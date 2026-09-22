import { degrees, PDFDocument } from "pdf-lib";

import { loadCopyablePdf, type PdfDecrypt } from "./utils/decryptPdf";
import type { OcrPageBox, OcrPageGeometry } from "./ocrPageGeometry";
import { numberOcrRows, type NumberedOcrFiling } from "./ocrRowNumbering";
import type { PageRotation } from "./pageOrientation";
import { MAX_PAGE_IMAGES_PER_REQUEST, type PtrDocumentInput, type PtrPriorRead, type PtrRowWindow } from "./ptrExtraction";
import type { PlannedPtrAttachment } from "./ptrRequestPlan";

/**
 * Plans OCR text requests by the rows a model must return, never by cutting the text: a
 * window carries its neighbouring pages so column headers and wrapped rows stay visible,
 * and marks where it begins and ends so the model returns only its own rows.
 * `ptrRowCoverage.ts` proves every labelled row was accounted for. The failures that
 * shaped this are in designs/2026-09-14-political-disclosure-lake.md.
 */
export interface OcrTextFiling {
  filingId: string;
  /** Raw OCR markdown for each page, in page order. */
  pages: readonly string[];
  /** The filing as filed, for its source reads and reconciling reads. */
  source?: FiledSource;
  /** The day the report was filed, YYYY-MM-DD, for the date findings of its reads (`ptrDateChecks.ts`). */
  filedOn?: string;
}

/**
 * A filing as filed. A House scan is its PDF, with each page's clockwise turn to upright from the orientation vote
 * (`pageOrientation.ts`); a Senate paper report, filed as page images, is those images upright as a read receives
 * them, beside the pages as filed that a band is cut from at their own resolution. `geometries` holds each page's
 * table box from the OCR response that read it, and `band` cuts one (`utils/pageBandImage.ts`).
 */
export type FiledSource =
  | {
      kind: "pdf";
      pdf: Buffer;
      rotations: readonly PageRotation[];
      geometries: ReadonlyArray<OcrPageGeometry | null>;
      /** Rewrites the PDF unencrypted before pdf-lib copies its pages (an RC4-encrypted House PTR). */
      decrypt?: PdfDecrypt;
      band?: FiledPageBand;
    }
  | {
      kind: "images";
      /** Each page as filed. A pass keeps one copy of a page, so upright copies are made per request, not retained. */
      filed: readonly Buffer[];
      rotations: readonly PageRotation[];
      geometries: ReadonlyArray<OcrPageGeometry | null>;
      /** One filed page turned upright for a request (`utils/modelPageImage.ts`). */
      upright: (image: Buffer, rotation: PageRotation) => Promise<Buffer>;
      band?: FiledPageBand;
    };

/** One filed page cropped to the rows between two fractions of its table, with the table's column headers above them. */
export interface FiledPageBandRequest {
  /** The filing as filed, when it is a scanned PDF. */
  pdf?: Buffer;
  /** The page as filed, when the report is filed as page images. */
  image?: Buffer;
  /** 1-based page of the filing. */
  page: number;
  /** The page's clockwise turn to upright. */
  rotation: PageRotation;
  /** The page's size in its OCR response's pixels, which `table` is given in. */
  pageWidth: number;
  pageHeight: number;
  table: OcrPageBox;
  /** The band's edges as fractions of the table's height. */
  from: number;
  to: number;
}

export type FiledPageBand = (request: FiledPageBandRequest) => Promise<Buffer>;

export interface OcrTextBudget {
  maxTableRowsPerWindow: number;
  maxRowsPerWindow: number;
  maxTableRowsPerRequest: number;
  maxAttachmentsPerRequest: number;
  /**
   * Most page images in one request. When a filing's filed pages are images, a window spans at most this many pages
   * with its context pages, since its reconciling read carries each of them, and a source read request holds at most
   * this many.
   */
  maxPagesPerRequest?: number;
}

function filedPageCount(source: FiledSource): number {
  return source.rotations.length;
}

/**
 * Where a window's rows sit in a page's table, as fractions of its height: the page's table lines are taken as evenly
 * spaced, since a line's own place is not in the OCR text. Null when the page holds none of the window's table rows.
 * The crop's header strip stays a fixed share of the table (`BAND_HEADER_FRACTION`); deriving it from the OCR text's
 * first dated row was measured worse on both Senate fixtures (`utils/pageBandImage.ts`).
 */
function bandFractions(window: PlannedPtrAttachment, page: number): { from: number; to: number } | null {
  const numbered = window.numberedOcr;
  const rows = window.rowWindow;
  if (!numbered || !rows) return { from: 0, to: 1 };
  const tableLabels = numbered.rowPages.flatMap((rowPage, index) =>
    rowPage === page && numbered.tableRows[index] ? [index + 1] : []
  );
  const inside = tableLabels.filter((label) => label >= rows.first && label <= rows.last);
  if (tableLabels.length === 0 || inside.length === 0) return null;
  return {
    from: tableLabels.indexOf(inside[0]!) / tableLabels.length,
    to: (tableLabels.indexOf(inside[inside.length - 1]!) + 1) / tableLabels.length,
  };
}

/** Crops of the filed pages covering a window's own rows, at the resolution those pages were scanned at. */
async function windowBands(window: PlannedPtrAttachment): Promise<Buffer[]> {
  const source = window.filedSource;
  if (!source?.band) return [];
  const { band } = source;
  const bands = await Promise.all(
    windowRowPages(window).map(async (page): Promise<Buffer[]> => {
      const geometry = source.geometries[page - 1];
      const fractions = bandFractions(window, page);
      if (!geometry?.table || !fractions) return [];
      return [
        await band({
          ...(source.kind === "pdf" ? { pdf: source.pdf } : { image: source.filed[page - 1]! }),
          page,
          rotation: source.rotations[page - 1]!,
          pageWidth: geometry.width,
          pageHeight: geometry.height,
          table: geometry.table,
          from: fractions.from,
          to: fractions.to,
        }),
      ];
    })
  );
  return bands.flat();
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

/** A window's pages beyond those its rows sit on: at most one context page before and one after. */
const WINDOW_CONTEXT_PAGES = 2;

/**
 * Consecutive windows over labels R1..RN; `tableRows[n - 1]` says whether Rn is a table line. With `pageLimit`, a
 * window is also cut before a row that would make it span more than `maxPages` pages with its context pages, since
 * every page rides with its image and a request holds at most `MAX_PAGE_IMAGES_PER_REQUEST` images.
 */
export function planRowWindows(
  tableRows: readonly boolean[],
  maxTableRowsPerWindow: number,
  maxRowsPerWindow: number,
  pageLimit?: { rowPages: readonly number[]; maxPages: number }
): PtrRowWindow[] {
  assertPositiveInteger(maxTableRowsPerWindow, "maxTableRowsPerWindow");
  assertPositiveInteger(maxRowsPerWindow, "maxRowsPerWindow");
  if (pageLimit && pageLimit.maxPages < 1 + WINDOW_CONTEXT_PAGES) {
    throw new Error(`maxPages must be at least ${1 + WINDOW_CONTEXT_PAGES}`);
  }
  const rowCount = tableRows.length;
  const windows: PtrRowWindow[] = [];
  let first = 1;
  let tableCount = 0;
  tableRows.forEach((table, index) => {
    const row = index + 1;
    const labels = row - first;
    const spannedPages = pageLimit
      ? pageLimit.rowPages[row - 1]! - pageLimit.rowPages[first - 1]! + 1 + WINDOW_CONTEXT_PAGES
      : 0;
    if (
      labels > 0 &&
      (labels >= maxRowsPerWindow ||
        (table && tableCount >= maxTableRowsPerWindow) ||
        (pageLimit !== undefined && spannedPages > pageLimit.maxPages))
    ) {
      windows.push({ first, last: row - 1, rowCount });
      first = row;
      tableCount = 0;
    }
    if (table) tableCount += 1;
  });
  if (rowCount > 0) windows.push({ first, last: rowCount, rowCount });
  return windows;
}

interface WeightedAttachment {
  attachment: PlannedPtrAttachment;
  tableRows: number;
}

export function rowWindowMarker(window: PtrRowWindow, edge: "begins" | "ends"): string {
  return `=== ROW WINDOW R${window.first}-R${window.last} ${edge === "begins" ? "BEGINS" : "ENDS"} ===`;
}

/** A window's context pages, with a marker line before its first labeled row and after its last. */
function withWindowMarkers(
  numbered: NumberedOcrFiling,
  window: PtrRowWindow,
  contextStart: number,
  contextEnd: number
): string[] {
  const pages = numbered.pages.slice(contextStart - 1, contextEnd).map((page) => page.split("\n"));
  const lastPage = numbered.rowPages[window.last - 1]! - contextStart;
  pages[lastPage]!.splice(numbered.rowLines[window.last - 1]! + 1, 0, rowWindowMarker(window, "ends"));
  const firstPage = numbered.rowPages[window.first - 1]! - contextStart;
  pages[firstPage]!.splice(numbered.rowLines[window.first - 1]!, 0, rowWindowMarker(window, "begins"));
  return pages.map((lines) => lines.join("\n"));
}

function filingAttachments(filing: OcrTextFiling, budget: OcrTextBudget): WeightedAttachment[] {
  const numbered = numberOcrRows(filing.pages);
  const total = filing.pages.length;
  if (filing.source && filedPageCount(filing.source) !== total) {
    throw new Error(`${filing.filingId} has ${filedPageCount(filing.source)} filed pages for ${total} OCR pages`);
  }
  const maxPages = filing.source?.kind === "images" ? budget.maxPagesPerRequest : undefined;
  const windows = planRowWindows(
    numbered.tableRows,
    budget.maxTableRowsPerWindow,
    budget.maxRowsPerWindow,
    maxPages === undefined ? undefined : { rowPages: numbered.rowPages, maxPages }
  );
  const tableRowsIn = (window: PtrRowWindow): number =>
    numbered.tableRows.slice(window.first - 1, window.last).filter(Boolean).length;
  const filed = {
    ...(filing.source ? { filedSource: filing.source } : {}),
    ...(filing.filedOn ? { filedOn: filing.filedOn } : {}),
  };
  // A filing goes whole when it has at most one window and its pages fit one request's images.
  if (windows.length === 0 || (windows.length === 1 && (maxPages === undefined || total <= maxPages))) {
    return [
      {
        attachment: {
          sourceId: filing.filingId,
          filingId: filing.filingId,
          pageStart: 1,
          pageEnd: total,
          totalPages: total,
          ocrPages: numbered.pages,
          ocrFirstPage: 1,
          ...(windows.length === 1 ? { rowWindow: windows[0]! } : {}),
          numberedOcr: numbered,
          ...filed,
        },
        tableRows: windows.length === 1 ? tableRowsIn(windows[0]!) : 0,
      },
    ];
  }
  return windows.map((window, index): WeightedAttachment => {
    const contextStart = Math.max(1, numbered.rowPages[window.first - 1]! - 1);
    const contextEnd = Math.min(total, numbered.rowPages[window.last - 1]! + 1);
    return {
      attachment: {
        sourceId: `${filing.filingId}:w${index + 1}`,
        filingId: filing.filingId,
        pageStart: contextStart,
        pageEnd: contextEnd,
        totalPages: total,
        chunkIndex: index,
        ocrPages: withWindowMarkers(numbered, window, contextStart, contextEnd),
        ocrFirstPage: contextStart,
        rowWindow: window,
        numberedOcr: numbered,
        ...filed,
      },
      tableRows: tableRowsIn(window),
    };
  });
}

export function gapFillSourceId(baseSourceId: string, gap: PtrRowWindow): string {
  return `${baseSourceId}:g${gap.first}-${gap.last}`;
}

/**
 * A read of only the rows a window read left without a disposition, with the
 * context pages and markers a window of those rows gets. `ptrGapFill.ts` decides
 * when one runs and merges its answer back.
 */
export function planGapFillAttachment(base: PlannedPtrAttachment, gap: PtrRowWindow): PlannedPtrAttachment {
  const numbered = base.numberedOcr;
  if (!numbered || !base.rowWindow) throw new Error(`${base.sourceId} is not a numbered OCR row window`);
  const total = numbered.pages.length;
  const contextStart = Math.max(1, numbered.rowPages[gap.first - 1]! - 1);
  const contextEnd = Math.min(total, numbered.rowPages[gap.last - 1]! + 1);
  return {
    sourceId: gapFillSourceId(base.sourceId, gap),
    filingId: base.filingId,
    pageStart: contextStart,
    pageEnd: contextEnd,
    totalPages: total,
    ...(base.chunkIndex !== undefined ? { chunkIndex: base.chunkIndex } : {}),
    ocrPages: withWindowMarkers(numbered, gap, contextStart, contextEnd),
    ocrFirstPage: contextStart,
    rowWindow: gap,
    numberedOcr: numbered,
  };
}

export function planOcrTextRequests(
  filings: readonly OcrTextFiling[],
  budget: OcrTextBudget
): PlannedPtrAttachment[][] {
  assertPositiveInteger(budget.maxTableRowsPerRequest, "maxTableRowsPerRequest");
  assertPositiveInteger(budget.maxAttachmentsPerRequest, "maxAttachmentsPerRequest");
  const requests: PlannedPtrAttachment[][] = [];
  let current: PlannedPtrAttachment[] = [];
  let currentRows = 0;
  for (const filing of filings) {
    for (const { attachment, tableRows } of filingAttachments(filing, budget)) {
      const rows = Math.max(1, tableRows);
      if (
        current.length > 0 &&
        (current.length >= budget.maxAttachmentsPerRequest || currentRows + rows > budget.maxTableRowsPerRequest)
      ) {
        requests.push(current);
        current = [];
        currentRows = 0;
      }
      current.push(attachment);
      currentRows += rows;
    }
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/** The pages a window's own rows sit on, context pages aside; every page of a filing with no labeled row. */
export function windowRowPages(window: PlannedPtrAttachment): number[] {
  const numbered = window.numberedOcr;
  const first = window.rowWindow && numbered ? numbered.rowPages[window.rowWindow.first - 1]! : window.pageStart;
  const last = window.rowWindow && numbered ? numbered.rowPages[window.rowWindow.last - 1]! : window.pageEnd;
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

export function sourceReadId(filingId: string, page: number): string {
  return `${filingId}:s${page}`;
}

/**
 * Filed pages `first`..`last` (1-based, inclusive) as a request attaches them: their images, or a PDF of only those
 * pages with each page's rotation turned by the orientation vote's turn. The vote turned the page as rendered, and
 * rendering applies the page's own rotation first, so the turns add.
 */
export async function filedPages(
  source: FiledSource,
  first: number,
  last: number
): Promise<Pick<PtrDocumentInput, "pdf" | "pageImages">> {
  if (source.kind === "images") {
    return {
      pageImages: await Promise.all(
        source.filed
          .slice(first - 1, last)
          .map((image, offset) => source.upright(image, source.rotations[first - 1 + offset]!))
      ),
    };
  }
  const filed = await loadCopyablePdf(source.pdf, source.decrypt);
  const range = await PDFDocument.create();
  const indexes = Array.from({ length: last - first + 1 }, (_, offset) => first - 1 + offset);
  const pages = await range.copyPages(filed, indexes);
  pages.forEach((page, offset) => {
    const turned = page.getRotation().angle + source.rotations[first - 1 + offset]!;
    page.setRotation(degrees(((turned % 360) + 360) % 360));
    range.addPage(page);
  });
  return { pdf: Buffer.from(await range.save()) };
}

/** One source read attachment per filed page of a filing, each weighed by the table rows its OCR text holds. */
async function sourceReadPages(window: PlannedPtrAttachment): Promise<WeightedAttachment[]> {
  const { filingId, filedSource, numberedOcr, totalPages } = window;
  if (!filedSource || !numberedOcr) throw new Error(`${filingId} has no filed pages to read`);
  return Promise.all(
    Array.from({ length: totalPages }, async (_, offset): Promise<WeightedAttachment> => {
      const page = offset + 1;
      return {
        attachment: {
          sourceId: sourceReadId(filingId, page),
          filingId,
          pageStart: page,
          pageEnd: page,
          totalPages,
          pages: { start: page, end: page, total: totalPages },
          ...(await filedPages(filedSource, page, page)),
        },
        tableRows: numberedOcr.tableRows.filter((table, index) => table && numberedOcr.rowPages[index] === page).length,
      };
    })
  );
}

/**
 * Source reads for every filing in a set of window requests: each filed page alone, with no OCR text, so a source
 * read shares no OCR error. Requests are bounded as window requests are, and by `maxPagesPerRequest` page images. A
 * filing whose filed pages cannot be prepared is left out and named in `unreadable`.
 */
export async function planSourceReadRequests(
  windowRequests: readonly PlannedPtrAttachment[][],
  budget: OcrTextBudget
): Promise<{ requests: PlannedPtrAttachment[][]; unreadable: Map<string, string> }> {
  const filings = new Map<string, PlannedPtrAttachment>();
  for (const window of windowRequests.flat()) {
    if (!filings.has(window.filingId)) filings.set(window.filingId, window);
  }
  const unreadable = new Map<string, string>();
  const requests: PlannedPtrAttachment[][] = [];
  let current: PlannedPtrAttachment[] = [];
  let currentRows = 0;
  let currentImages = 0;
  for (const [filingId, window] of filings) {
    const pages = await sourceReadPages(window).catch((error: unknown) => {
      unreadable.set(filingId, error instanceof Error ? error.message : String(error));
      return [];
    });
    for (const { attachment, tableRows } of pages) {
      const rows = Math.max(1, tableRows);
      const images = attachment.pageImages?.length ?? 0;
      if (
        current.length > 0 &&
        (current.length >= budget.maxAttachmentsPerRequest ||
          currentRows + rows > budget.maxTableRowsPerRequest ||
          (budget.maxPagesPerRequest !== undefined && currentImages + images > budget.maxPagesPerRequest))
      ) {
        requests.push(current);
        current = [];
        currentRows = 0;
        currentImages = 0;
      }
      current.push(attachment);
      currentRows += rows;
      currentImages += images;
    }
  }
  if (current.length > 0) requests.push(current);
  return { requests, unreadable };
}

/**
 * A window's reconciling read: its OCR text, the filed pages that text covers, crops of its own rows at the
 * resolution they were scanned at, and both map reads of it. A whole page arrives shrunk enough that a form's narrow
 * checkbox columns are miscounted, so the crops are what a mark's column is read from. A report filed as page images
 * sends its crops alone when its pages and crops would exceed one request's images.
 */
export async function planReconcileAttachment(
  window: PlannedPtrAttachment,
  priorReads: readonly PtrPriorRead[],
  dateFindings: readonly string[] = [],
  repair: {
    assetFindings?: readonly string[];
    emptyReadFindings?: readonly string[];
    keptDateFindings?: readonly string[];
  } = {}
): Promise<PlannedPtrAttachment> {
  const source = window.filedSource;
  if (!source) throw new Error(`${window.sourceId} has no filed pages to reconcile against`);
  const evidenceImages = await windowBands(window);
  const filed = await filedPages(source, window.pageStart, window.pageEnd);
  const pageImages = filed.pageImages ?? [];
  // A whole page beside its crops competes with them: with both, a reconciling read kept the shifted amounts a page
  // read gave on Blumenthal 2022 `accadeb3` page 2 (2026-09-15). Its pages go only when the crops leave one uncovered.
  const dropPageImages =
    source.kind === "images" &&
    (evidenceImages.length >= windowRowPages(window).length ||
      evidenceImages.length + pageImages.length > MAX_PAGE_IMAGES_PER_REQUEST);
  return {
    ...window,
    ...(dropPageImages ? {} : filed),
    ...(source.kind === "pdf" ? { ocrWithPdf: true } : { ocrWithPageImages: !dropPageImages }),
    ...(evidenceImages.length > 0 ? { evidenceImages } : {}),
    priorReads,
    ...(dateFindings.length > 0 ? { dateFindings } : {}),
    ...(repair.assetFindings?.length ? { assetFindings: repair.assetFindings } : {}),
    ...(repair.emptyReadFindings?.length ? { emptyReadFindings: repair.emptyReadFindings } : {}),
    ...(repair.keptDateFindings?.length ? { keptDateFindings: repair.keptDateFindings } : {}),
  };
}
