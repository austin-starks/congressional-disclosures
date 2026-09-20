import { noResult, type OcrPageRead } from "./houseFilingExtraction";
import { ocrPageGeometry } from "./ocrPageGeometry";
import { planOcrTextRequests, type FiledPageBand, type OcrTextBudget, type OcrTextFiling } from "./ocrTextPlan";
import type { PageRotation } from "./pageOrientation";
import type { PtrDocumentResult } from "./ptrExtraction";
import {
  readsOf,
  runExtractionReads,
  runMapReduceReads,
  type ConsensusCounts,
  type RunReadRequests,
} from "./ptrReadPasses";
import { mergePtrFilingResults } from "./ptrRequestPlan";
import { createConcurrencyLimiter, mapWithConcurrency } from "./utils/mapWithConcurrency";

/**
 * Extraction of Senate paper periodic transaction reports along the path their gate
 * measured (`scripts/testing/runPtrExtractionGate.ts --fixture senate-paper --input auto
 * --reads map-reduce`). eFD serves a paper report as page images with no PDF, so every
 * page is turned upright and OCR'd as filed, the OCR text is labeled and cut into row
 * windows, and every request goes through `runMapReduceReads` (a read of the OCR text, a
 * read of the upright page images without it, and a reconciling read where they
 * disagree). The caller's `run` sends the Senate paper contract wording (`PtrFormFamily`
 * "senate_paper").
 */
export const LETTER_PAGE_LONG_SIDE_INCHES = 11;

/**
 * The resolution a filed page image was scanned at. eFD's page GIFs are letter sheets
 * 2,179 to 4,400 pixels on the long side in the sampled reports, some of them sideways,
 * so the long side is taken as 11 inches.
 */
export function filedPageDpi(width: number, height: number): number {
  return Math.round(Math.max(width, height) / LETTER_PAGE_LONG_SIDE_INCHES);
}

export interface SenatePaperReportPages {
  reportId: string;
  /** Filed page images in page order, as fetched. */
  pages: readonly Buffer[];
}

export interface SenatePaperExtractionDeps {
  /** One filed page image turned upright and OCR'd, with the orientation evidence. */
  ocrPage(image: Buffer, label: string): Promise<OcrPageRead>;
  /** A filed page image turned `rotation` degrees clockwise, as a model request sends it (`utils/modelPageImage.ts`). */
  uprightPageImage(image: Buffer, rotation: PageRotation): Promise<Buffer>;
  /** A crop of one filed page's rows for a reconciling read (`utils/pageBandImage.ts`); absent sends none. */
  pageBand?: FiledPageBand;
  run: RunReadRequests;
}

export interface SenatePaperExtraction {
  reportId: string;
  result: PtrDocumentResult;
  /** Each page's OCR read; null when the report's pages could not be OCR'd. */
  ocrPages: OcrPageRead[] | null;
}

export interface SenatePaperExtractionRun {
  extractions: SenatePaperExtraction[];
  consensus: ConsensusCounts | null;
}

export async function extractSenatePaperReports(
  reports: readonly SenatePaperReportPages[],
  deps: SenatePaperExtractionDeps,
  budget: OcrTextBudget,
  reads: 1 | 2,
  /** Pages OCR'd at once across every report; results keep page order. */
  ocrConcurrency = 1
): Promise<SenatePaperExtractionRun> {
  const scans = new Map<string, OcrPageRead[]>();
  // A report whose pages cannot be OCR'd fails on its own; the other reports in the pass still extract.
  const ocrFailures = new Map<string, string>();
  const ocrSlot = createConcurrencyLimiter(ocrConcurrency);
  await mapWithConcurrency(reports, ocrConcurrency, async (report) => {
    try {
      scans.set(
        report.reportId,
        await Promise.all(
          report.pages.map((image, index) => ocrSlot(() => deps.ocrPage(image, `${report.reportId} page ${index + 1}`)))
        )
      );
    } catch (error) {
      ocrFailures.set(report.reportId, error instanceof Error ? error.message : String(error));
    }
  });

  // A pass holds every report's pages until it publishes, so each page is kept once, as filed. A read turns a page
  // upright when it sends one (`uprightPageImage`) and a crop cuts its own from the same bytes, rather than a pass
  // retaining a second copy of every page: on a 2 GB `nexustrade-cron-workers` machine that second copy is what runs
  // it out of memory, since filed pages average 402 KB over the Senate fixtures.
  const requests = planOcrTextRequests(
    reports.flatMap((report): OcrTextFiling[] => {
      const scan = scans.get(report.reportId);
      return scan
        ? [
            {
              filingId: report.reportId,
              pages: scan.map((page) => page.markdown),
              source: {
                kind: "images",
                filed: report.pages,
                rotations: scan.map((page) => page.rotation),
                geometries: scan.map((page) => ocrPageGeometry(page.payload)),
                upright: deps.uprightPageImage,
                ...(deps.pageBand ? { band: deps.pageBand } : {}),
              },
            },
          ]
        : [];
    }),
    budget
  );
  const { outcomes, consensus } =
    requests.length === 0
      ? { outcomes: [], consensus: null }
      : reads === 2
        ? await runMapReduceReads(requests, deps.run, budget)
        : await runExtractionReads(requests, 1, deps.run);
  const merged = new Map(
    mergePtrFilingResults(requests.flat(), readsOf(outcomes)).map((result) => [result.sourceId, result])
  );

  return {
    extractions: reports.map((report): SenatePaperExtraction => {
      const ocrFailure = ocrFailures.get(report.reportId);
      if (ocrFailure !== undefined) {
        return {
          reportId: report.reportId,
          result: noResult(report.reportId, `OCR failed: ${ocrFailure}`),
          ocrPages: null,
        };
      }
      return {
        reportId: report.reportId,
        result: merged.get(report.reportId) ?? noResult(report.reportId),
        ocrPages: scans.get(report.reportId) ?? null,
      };
    }),
    consensus,
  };
}
