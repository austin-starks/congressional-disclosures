import { ocrPageGeometry } from "./ocrPageGeometry";
import { planOcrTextRequests, type FiledPageBand, type OcrTextBudget, type OcrTextFiling } from "./ocrTextPlan";
import type { PageRotation, RotationScore, UprightPage } from "./pageOrientation";
import { MAX_PAGE_IMAGES_PER_REQUEST, type PtrDocumentResult } from "./ptrExtraction";
import {
  readsOf,
  runExtractionReads,
  runMapReduceReads,
  sumConsensus,
  type ConsensusCounts,
  type RunReadRequests,
} from "./ptrReadPasses";
import {
  mergePtrFilingResults,
  planPtrRequests,
  type PlannedPtrAttachment,
  type PtrRequestBudget,
} from "./ptrRequestPlan";
import { createConcurrencyLimiter, mapWithConcurrency } from "./utils/mapWithConcurrency";
import type { PdfDecrypt } from "./utils/decryptPdf";

/**
 * Extraction of House PTR PDFs along the path the Phase 0 gate measured
 * (`scripts/testing/runPtrExtractionGate.ts --input auto --reads map-reduce`):
 *
 * - A PDF with an adequate text layer is sent as a PDF, split by page budget.
 * - A scan is rendered page by page, each page turned upright and OCR'd, and the
 *   OCR text is labeled and cut into row windows.
 * - Text-layer requests go through `runExtractionReads` (two reads and consensus), and
 *   scan windows through `runMapReduceReads` (a read of the OCR text, a read of the filed
 *   PDF's pages without it, and a reconciling read where they disagree); results merge
 *   back per filing.
 *
 * Transport is injected (`HouseExtractionDeps`), so the daily job supplies the
 * rasterizer, tesseract, Mistral and NexusGenAI, and tests supply fakes. A scan
 * keeps each page's OCR response and orientation evidence so they can be archived.
 */
export type HouseReadPath = "text_layer" | "page_image_ocr";

export interface OcrPageRead {
  /** The page's clockwise turn to upright. */
  rotation: PageRotation;
  scores: RotationScore[];
  decidedBy: UprightPage["decidedBy"];
  /** The verbatim OCR response for the upright page image. */
  payload: Record<string, unknown>;
  /** The verbatim OCR response for the same upright page at another resolution (`ocrReadsDisagreement`). */
  checkPayload: Record<string, unknown>;
  markdown: string;
}

/** One scanned page rendered at the OCR render scale and at the check scale. */
export interface ScanPageImages {
  image: Buffer;
  checkImage: Buffer;
  /**
   * The same page rendered differently, for one retry when a coverage guard rejects the first
   * read. OCR responses are cached on a hash of the whole request, image bytes included, so
   * re-reading identical bytes is served the same failing answer forever. Different bytes are
   * what make a retry a retry.
   */
  reRender?: () => Promise<{ image: Buffer; checkImage: Buffer; dpi?: number }>;
}

export interface HouseExtractionDeps {
  readPath(pdf: Buffer): Promise<HouseReadPath>;
  /** A scanned PDF's pages at the OCR render scale and the check scale, in page order. */
  renderPages(pdf: Buffer): Promise<ScanPageImages[]>;
  /** One page turned upright and OCR'd at both scales, with the orientation evidence. */
  ocrPage(page: ScanPageImages, label: string): Promise<OcrPageRead>;
  /** A crop of one filed page's rows for a reconciling read (`utils/pageBandImage.ts`); absent sends none. */
  pageBand?: FiledPageBand;
  /** Rewrites an RC4-encrypted filing PDF unencrypted before its pages are split or copied; absent leaves a filing that needs it to fail loudly. */
  decrypt?: PdfDecrypt;
  run: RunReadRequests;
}

export interface HouseExtractionBudgets {
  pdf: PtrRequestBudget;
  ocrText: OcrTextBudget;
  /** Pages OCR'd at once across every scanned filing, and filings rendered at once; results keep page order. 1 when absent. */
  ocrConcurrency?: number;
}

export interface HouseFilingPdf {
  filingId: string;
  pdf: Buffer;
  /** Rows this filing is expected to hold, so requests are packed by answer length. */
  estimatedRows?: number;
  /** The day the report was filed, YYYY-MM-DD; a scan's read dated after it is disputed (`ptrDateChecks.ts`). */
  filedOn?: string;
}

export interface HouseFilingExtraction {
  filingId: string;
  parseMethod: "text" | "scan";
  result: PtrDocumentResult;
  /** Each page's OCR read for a scan; null for a text-layer PDF. */
  ocrPages: OcrPageRead[] | null;
}

export interface HouseExtractionRun {
  extractions: HouseFilingExtraction[];
  consensus: ConsensusCounts | null;
}

/** The request budgets the Phase 0 gate measured, shared by the gate's defaults and the daily job. */
export const DEFAULT_HOUSE_EXTRACTION_BUDGETS: HouseExtractionBudgets = {
  // 1000 pages per attachment meant "never split by page count", so a 62-page filing went whole
  // and its answer ran past the model's output token limit before the JSON closed — a doomed
  // 147-second generation, paid for, every time, before the retry ladder could narrow anything.
  // Nothing caught it because until the RC4 decrypt fix these filings were copied as blank pages
  // and had no rows to emit. 10 matches what the OCR path already uses
  // (MAX_PAGE_IMAGES_PER_REQUEST) and what the Phase 0 gate measured. At ~9 rows a page on a
  // dense filing that is ~90 rows an answer, against the ~360 a 40-page request was asking for.
  // Short filings are unaffected: they still batch up to maxAttachmentsPerRequest per request.
  // maxRowsPerRequest is what binds once a filing carries an estimate; the page numbers are the
  // fallback for filings that do not. 40 is not a new guess — it is the row budget the OCR path
  // was measured at (`ocrText.maxTableRowsPerRequest`), and the page budgets tried on dense
  // filings (1000, 40, then 10) each truncated because 9 rows a page makes any of them far more
  // than one answer holds.
  pdf: {
    maxPagesPerAttachment: 10,
    maxPagesPerRequest: 10,
    maxAttachmentsPerRequest: 10,
    maxRowsPerRequest: 40,
  },
  ocrText: {
    maxTableRowsPerWindow: 20,
    maxRowsPerWindow: 120,
    maxTableRowsPerRequest: 40,
    maxAttachmentsPerRequest: 10,
    maxPagesPerRequest: MAX_PAGE_IMAGES_PER_REQUEST,
  },
};

/** An empty result that fails its filing with `error`. */
export function noResult(filingId: string, error = "no extraction result"): PtrDocumentResult {
  return {
    sourceId: filingId,
    rows: [],
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows: [],
    continuationRows: [],
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error,
  };
}

interface TextLayerReads {
  /** The attachments each filing was finally read as. */
  attachments: PlannedPtrAttachment[];
  results: Map<string, PtrDocumentResult>;
  consensus: ConsensusCounts | null;
}

/**
 * Text-layer filings read by page budget, and any filing that failed because a read stopped at the
 * model's output token limit read again at half the pages per attachment, down to single pages. A long
 * table can outgrow one answer: on 2026-09-16 one 134K-token filing truncated on 15 of 15 whole reads.
 */
async function readTextLayerFilings(
  filings: readonly HouseFilingPdf[],
  budget: PtrRequestBudget,
  reads: 1 | 2,
  run: RunReadRequests,
  decrypt?: PdfDecrypt
): Promise<TextLayerReads> {
  if (filings.length === 0) return { attachments: [], results: new Map(), consensus: null };
  const requests = await planPtrRequests(
    filings.map((filing) => ({ ...filing, ...(decrypt ? { decrypt } : {}) })),
    budget
  );
  const truncated = new Set<string>();
  const extraction = await runExtractionReads(requests, reads, async (batch, read) => {
    const outcomes = await run(batch, read);
    for (const outcome of outcomes.filter((candidate) => candidate.truncated)) {
      for (const attachment of outcome.attachments) truncated.add(attachment.sourceId);
    }
    return outcomes;
  });
  const attachments = requests.flat();
  const results = readsOf(extraction.outcomes);
  const failed = new Set(
    mergePtrFilingResults(attachments, results)
      .filter((result) => result.error !== null)
      .map((result) => result.sourceId)
  );
  const pagesPerAttachment = new Map<string, number>();
  for (const attachment of attachments) {
    const pages = attachment.pageEnd - attachment.pageStart + 1;
    if (!failed.has(attachment.filingId) || !truncated.has(attachment.sourceId) || pages < 2) continue;
    const half = Math.ceil(pages / 2);
    pagesPerAttachment.set(attachment.filingId, Math.min(half, pagesPerAttachment.get(attachment.filingId) ?? half));
  }
  if (pagesPerAttachment.size === 0) return { attachments, results, consensus: extraction.consensus };

  // Narrow the request budget with the attachment, not just the attachment. An output token
  // limit is spent on the whole request's answer, and the planner packs attachments up to
  // maxPagesPerRequest — so halving a filing's pages and keeping the budget re-packs the halves
  // into one request and asks the model for the same rows again. It escapes only at the third
  // read, where each attachment goes alone, after every rung has paid for two doomed
  // generations. One attachment per request from the retry on makes each rung strictly smaller.
  const narrowest = Math.min(...pagesPerAttachment.values());
  const narrowed: PtrRequestBudget = {
    ...budget,
    maxPagesPerRequest: Math.max(1, Math.min(budget.maxPagesPerRequest, narrowest)),
    maxAttachmentsPerRequest: 1,
  };

  const split = await readTextLayerFilings(
    filings
      .filter((filing) => pagesPerAttachment.has(filing.filingId))
      .map((filing) => {
        const maxPagesPerAttachment = pagesPerAttachment.get(filing.filingId);
        return { ...filing, ...(maxPagesPerAttachment !== undefined ? { maxPagesPerAttachment } : {}) };
      }),
    narrowed,
    reads,
    run,
    decrypt
  );
  const kept = attachments.filter((attachment) => !pagesPerAttachment.has(attachment.filingId));
  return {
    attachments: [...kept, ...split.attachments],
    results: new Map([
      ...kept.flatMap((attachment): Array<[string, PtrDocumentResult]> => {
        const result = results.get(attachment.sourceId);
        return result ? [[attachment.sourceId, result]] : [];
      }),
      ...split.results,
    ]),
    consensus: sumConsensus([extraction.consensus, split.consensus]),
  };
}

export async function extractHouseFilings(
  filings: readonly HouseFilingPdf[],
  deps: HouseExtractionDeps,
  budgets: HouseExtractionBudgets,
  reads: 1 | 2
): Promise<HouseExtractionRun> {
  const scans = new Map<string, OcrPageRead[]>();
  // A scan whose pages cannot be rendered or OCR'd fails on its own; the other
  // filings in the pass still extract.
  const ocrFailures = new Map<string, string>();
  const textLayer: HouseFilingPdf[] = [];
  const scanned: HouseFilingPdf[] = [];
  for (const filing of filings) {
    ((await deps.readPath(filing.pdf)) === "text_layer" ? textLayer : scanned).push(filing);
  }
  // Every filing's pages share one pool, so a long scan's pages are read in parallel within the same bound.
  const ocrSlot = createConcurrencyLimiter(budgets.ocrConcurrency ?? 1);
  await mapWithConcurrency(scanned, budgets.ocrConcurrency ?? 1, async (filing) => {
    try {
      const rendered = await deps.renderPages(filing.pdf);
      const pages = await Promise.all(
        rendered.map((page, index) => ocrSlot(() => deps.ocrPage(page, `${filing.filingId} page ${index + 1}`)))
      );
      scans.set(filing.filingId, pages);
    } catch (error) {
      ocrFailures.set(filing.filingId, error instanceof Error ? error.message : String(error));
    }
  });

  const ocrRequests = planOcrTextRequests(
    filings.flatMap((filing): OcrTextFiling[] => {
      const pages = scans.get(filing.filingId);
      return pages
        ? [
            {
              filingId: filing.filingId,
              pages: pages.map((page) => page.markdown),
              ...(filing.filedOn ? { filedOn: filing.filedOn } : {}),
              source: {
                kind: "pdf",
                pdf: filing.pdf,
                rotations: pages.map((page) => page.rotation),
                geometries: pages.map((page) => ocrPageGeometry(page.payload)),
                ...(deps.decrypt ? { decrypt: deps.decrypt } : {}),
                ...(deps.pageBand ? { band: deps.pageBand } : {}),
              },
            },
          ]
        : [];
    }),
    budgets.ocrText
  );
  const pdfReads = await readTextLayerFilings(textLayer, budgets.pdf, reads, deps.run, deps.decrypt);
  const ocrReads =
    ocrRequests.length === 0
      ? null
      : reads === 2
        ? await runMapReduceReads(ocrRequests, deps.run, budgets.ocrText)
        : await runExtractionReads(ocrRequests, 1, deps.run);
  const consensus = sumConsensus([pdfReads.consensus, ocrReads?.consensus ?? null]);
  const merged = new Map(
    mergePtrFilingResults(
      [...pdfReads.attachments, ...ocrRequests.flat()],
      new Map([...pdfReads.results, ...readsOf(ocrReads?.outcomes ?? [])])
    ).map((result) => [result.sourceId, result])
  );

  return {
    extractions: filings.map((filing): HouseFilingExtraction => {
      const ocrFailure = ocrFailures.get(filing.filingId);
      if (ocrFailure !== undefined) {
        return {
          filingId: filing.filingId,
          parseMethod: "scan",
          result: noResult(filing.filingId, `OCR failed: ${ocrFailure}`),
          ocrPages: null,
        };
      }
      const ocrPages = scans.get(filing.filingId) ?? null;
      return {
        filingId: filing.filingId,
        parseMethod: ocrPages ? "scan" : "text",
        result: merged.get(filing.filingId) ?? noResult(filing.filingId),
        ocrPages,
      };
    }),
    consensus,
  };
}
