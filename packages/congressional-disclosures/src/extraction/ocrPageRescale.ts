import type { OcrPageRead } from "./houseFilingExtraction";

/**
 * One retry of a page read, against a different render of the same page.
 *
 * `ocrPageCoverage.ts` rejects a read that dropped text or disagreed with its check read, and that
 * rejection fails the whole filing. Re-running the pass does not recover it: OCR responses are
 * cached on a hash of the entire request, image bytes included, so an identical request is served
 * its own failing answer back for as long as the row lives. On 2026-09-16 that was 31 filings of
 * backfill-2026-09-16 which no amount of re-extraction could have fixed.
 *
 * So the retry has to change the bytes. What it renders is the caller's business — a House page
 * comes from a PDF and can be rasterised at a higher scale, a Senate paper page is a filed image
 * and can only be resampled — and this holds the part that is the same either way: try once, and
 * on a rejection try exactly one different render before giving up with the *second* reason.
 */
export interface RescaleSource {
  image: Buffer;
  checkImage: Buffer;
  dpi: number;
}

/** A read that produced a page, or the reason the coverage guards rejected it. */
export interface PageReadAttempt {
  read?: OcrPageRead;
  failure?: string;
}

export interface ReadPageWithRescaleConfig {
  source: RescaleSource;
  readPage(source: RescaleSource): Promise<PageReadAttempt>;
  /** A different render of the same page. Absent means one attempt and no retry. */
  reRender?(): Promise<{ image: Buffer; checkImage: Buffer; dpi?: number }>;
}

export async function readPageWithRescale(config: ReadPageWithRescaleConfig): Promise<OcrPageRead> {
  const first = await config.readPage(config.source);
  if (first.read) return first.read;
  if (!config.reRender) throw new Error(first.failure ?? "OCR page read failed");

  const next = await config.reRender();
  const second = await config.readPage({
    image: next.image,
    checkImage: next.checkImage,
    dpi: next.dpi ?? config.source.dpi,
  });
  if (second.read) return second.read;
  // The second reason, not the first: it describes the render that was actually rejected last,
  // and a receipt carrying the first would send the next reader to the wrong image.
  throw new Error(second.failure ?? first.failure ?? "OCR page read failed");
}
