import { PDFDocument } from "pdf-lib";

import { loadCopyablePdf, type PdfDecrypt } from "./utils/decryptPdf";
import type {
  PtrDocumentInput,
  PtrDocumentResult,
  PtrPageRange,
  PtrRowWindow,
} from "./ptrExtraction";
import type { NumberedOcrFiling } from "./ocrRowNumbering";
import type { FiledSource } from "./ocrTextPlan";
import { verifyOcrRowCoverage, type OcrWindowRead } from "./ptrRowCoverage";

/**
 * Plans extraction requests by page budget, never by filer or document count: the model
 * stops enumerating long tables without an error, so long filings go as page ranges and
 * dense scans may go a page at a time. Short filings still share a request.
 */
export interface PtrFilingInput {
  filingId: string;
  pdf: Buffer;
  /** Overrides the budget's attachment size for this filing. */
  maxPagesPerAttachment?: number;
  /**
   * Transaction rows this filing is expected to hold, counted from its own text layer.
   *
   * Pages are a proxy for how long an answer will be, and the proxy breaks on exactly the filings
   * that matter: 20016481 prints 9.0 rows a page, so a 10-page request asks for ~90 rows against
   * the 40 the OCR path was measured at. Absent, the planner falls back to the page budget.
   */
  estimatedRows?: number;
  /** Rewrites the PDF unencrypted before pdf-lib splits it into ranges (an RC4-encrypted House PTR). */
  decrypt?: PdfDecrypt;
}

export interface PtrRequestBudget {
  /** A filing with more pages than this is split into ranges of this many pages. */
  maxPagesPerAttachment: number;
  maxPagesPerRequest: number;
  maxAttachmentsPerRequest: number;
  /**
   * Transaction rows one request may ask for, when the filings carry an `estimatedRows`.
   *
   * The output token limit is spent on the answer, and the answer is rows — so this is the budget
   * that actually binds. Page budgets only approximate it, and every page number tried on the
   * dense filings (1000, then 40, then 10) truncated because 9 rows a page turns any of them into
   * far more than one answer holds.
   */
  maxRowsPerRequest?: number;
}

export interface PtrAttachmentMeta {
  sourceId: string;
  filingId: string;
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  /** Order of an OCR row window within its filing. */
  chunkIndex?: number;
  /** The numbered OCR rows this attachment accounts for. */
  rowWindow?: PtrRowWindow;
  pages?: PtrPageRange;
}

export interface PlannedPtrAttachment extends PtrAttachmentMeta, PtrDocumentInput {
  /** The whole filing's labeled OCR text, kept to plan gap reads of a row window. */
  numberedOcr?: NumberedOcrFiling;
  /** The whole filing as filed, kept to plan its source reads and reconciling reads (`runMapReduceReads`). */
  filedSource?: FiledSource;
}

export function ptrPageRangeSourceId(
  filingId: string,
  start: number,
  end: number
): string {
  return `${filingId}:p${start}-${end}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

async function attachmentsForFiling(
  filing: PtrFilingInput,
  maxPagesPerAttachment: number
): Promise<PlannedPtrAttachment[]> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(filing.pdf, { ignoreEncryption: true });
  } catch {
    // An unparseable PDF is still sent whole: the model may read what pdf-lib
    // cannot, and a failed read surfaces as a per-document error downstream.
    return [
      {
        sourceId: filing.filingId,
        filingId: filing.filingId,
        pdf: filing.pdf,
        pageStart: 1,
        pageEnd: 1,
        totalPages: 1,
      },
    ];
  }
  const total = source.getPageCount();
  if (total <= maxPagesPerAttachment) {
    return [
      {
        sourceId: filing.filingId,
        filingId: filing.filingId,
        pdf: filing.pdf,
        pageStart: 1,
        pageEnd: total,
        totalPages: total,
      },
    ];
  }
  const copyable = await loadCopyablePdf(filing.pdf, filing.decrypt);
  const attachments: PlannedPtrAttachment[] = [];
  for (let start = 1; start <= total; start += maxPagesPerAttachment) {
    const end = Math.min(total, start + maxPagesPerAttachment - 1);
    const range = await PDFDocument.create();
    const pages = await range.copyPages(
      copyable,
      Array.from({ length: end - start + 1 }, (_, offset) => start - 1 + offset)
    );
    pages.forEach((page) => range.addPage(page));
    attachments.push({
      sourceId: ptrPageRangeSourceId(filing.filingId, start, end),
      filingId: filing.filingId,
      pdf: Buffer.from(await range.save()),
      pageStart: start,
      pageEnd: end,
      totalPages: total,
      pages: { start, end, total },
    });
  }
  return attachments;
}

export async function planPtrRequests(
  filings: readonly PtrFilingInput[],
  budget: PtrRequestBudget
): Promise<PlannedPtrAttachment[][]> {
  assertPositiveInteger(budget.maxPagesPerAttachment, "maxPagesPerAttachment");
  assertPositiveInteger(budget.maxPagesPerRequest, "maxPagesPerRequest");
  assertPositiveInteger(budget.maxAttachmentsPerRequest, "maxAttachmentsPerRequest");
  const requests: PlannedPtrAttachment[][] = [];
  let current: PlannedPtrAttachment[] = [];
  let currentPages = 0;
  let currentRows = 0;
  for (const filing of filings) {
    const maxPagesPerAttachment =
      filing.maxPagesPerAttachment ?? budget.maxPagesPerAttachment;
    assertPositiveInteger(
      maxPagesPerAttachment,
      `maxPagesPerAttachment for ${filing.filingId}`
    );
    const attachments = await attachmentsForFiling(filing, maxPagesPerAttachment);
    // Spread the filing's estimate across its ranges by page share. A range is not read alone —
    // the model answers the whole request — so what has to stay under the budget is the rows of
    // every attachment packed together, not of any one of them.
    const totalPages = attachments.reduce(
      (sum, attachment) => sum + (attachment.pageEnd - attachment.pageStart + 1),
      0
    );
    for (const attachment of attachments) {
      const pages = attachment.pageEnd - attachment.pageStart + 1;
      const rows =
        filing.estimatedRows !== undefined && totalPages > 0
          ? Math.ceil((filing.estimatedRows * pages) / totalPages)
          : 0;
      const overRows =
        budget.maxRowsPerRequest !== undefined &&
        rows > 0 &&
        currentRows + rows > budget.maxRowsPerRequest;
      if (
        current.length > 0 &&
        (current.length >= budget.maxAttachmentsPerRequest ||
          currentPages + pages > budget.maxPagesPerRequest ||
          overRows)
      ) {
        requests.push(current);
        current = [];
        currentPages = 0;
        currentRows = 0;
      }
      current.push(attachment);
      currentPages += pages;
      currentRows += rows;
    }
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/**
 * Reassemble page-range results into one result per filing, rows in page order.
 * Any failed range fails the filing: a filing missing a page is incomplete, not
 * a smaller filing.
 */
export function mergePtrFilingResults(
  attachments: readonly PtrAttachmentMeta[],
  results: ReadonlyMap<string, PtrDocumentResult>
): PtrDocumentResult[] {
  const byFiling = new Map<string, PtrAttachmentMeta[]>();
  for (const attachment of attachments) {
    const group = byFiling.get(attachment.filingId) ?? [];
    group.push(attachment);
    byFiling.set(attachment.filingId, group);
  }
  return [...byFiling.entries()].map(([filingId, group]): PtrDocumentResult => {
    const ordered = [...group].sort(
      (left, right) =>
        (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0) || left.pageStart - right.pageStart
    );
    if (ordered.length === 1 && !ordered[0]!.pages && !ordered[0]!.rowWindow) {
      const whole = results.get(ordered[0]!.sourceId);
      return whole
        ? { ...whole, sourceId: filingId }
        : {
            sourceId: filingId,
            rows: [],
            noTransactionsStatement: null,
            amendedReportDate: null,
            amendedReportDateIso: null,
            nonTransactionRows: [],
            continuationRows: [],
            invalidRowIndexes: [],
            reviewRowIndexes: [],
            error: "no extraction result",
          };
    }
    const rows: Array<Record<string, unknown>> = [];
    const invalidRowIndexes: number[] = [];
    const reviewRowIndexes: number[] = [];
    const errors: string[] = [];
    let noTransactionsStatement: string | null = null;
    let amendedReportDate: string | null = null;
    let amendedReportDateIso: string | null = null;
    const nonTransactionRows: number[] = [];
    const continuationRows: number[] = [];
    const windowReads: OcrWindowRead[] = [];
    for (const attachment of ordered) {
      const label =
        `pages ${attachment.pageStart}-${attachment.pageEnd}` +
        `${attachment.rowWindow ? ` rows R${attachment.rowWindow.first}-R${attachment.rowWindow.last}` : ""}`;
      const result = results.get(attachment.sourceId);
      if (!result) {
        errors.push(`${label}: no extraction result`);
        continue;
      }
      if (result.error) errors.push(`${label}: ${result.error}`);
      const offset = rows.length;
      rows.push(...result.rows);
      invalidRowIndexes.push(...result.invalidRowIndexes.map((index) => index + offset));
      reviewRowIndexes.push(...result.reviewRowIndexes.map((index) => index + offset));
      noTransactionsStatement ??= result.noTransactionsStatement;
      amendedReportDate ??= result.amendedReportDate;
      amendedReportDateIso ??= result.amendedReportDateIso;
      nonTransactionRows.push(...result.nonTransactionRows);
      continuationRows.push(...result.continuationRows);
      if (attachment.rowWindow) {
        windowReads.push({
          sourceId: attachment.sourceId,
          window: attachment.rowWindow,
          rows: result.rows,
          nonTransactionRows: result.nonTransactionRows,
          continuationRows: result.continuationRows,
        });
      }
    }
    let error: string | null = errors.length > 0 ? errors.join("; ") : null;
    const rowCount = ordered.find((attachment) => attachment.rowWindow)?.rowWindow?.rowCount;
    if (!error && rowCount !== undefined) {
      const coverage = verifyOcrRowCoverage(rowCount, windowReads);
      if (coverage.length > 0) error = `OCR row coverage: ${coverage.join("; ")}`;
    }
    if (!error && rows.length === 0 && !noTransactionsStatement) {
      error = "document returned no rows and no no-transactions statement";
    }
    return {
      sourceId: filingId,
      rows,
      noTransactionsStatement: rows.length === 0 ? noTransactionsStatement : null,
      amendedReportDate,
      amendedReportDateIso,
      nonTransactionRows,
      continuationRows,
      invalidRowIndexes,
      reviewRowIndexes,
      error,
    };
  });
}
