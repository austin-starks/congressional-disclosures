import { randomUUID } from "node:crypto";

import {
  DEFAULT_HOUSE_EXTRACTION_BUDGETS,
  extractHouseFilings,
  extractPtrBatch,
  extractSenatePaperReports,
  ocrPageShortfall,
  ocrReadsDisagreement,
  ptrContractVersion,
  ptrBatchIdempotencyKey,
  readPageWithRescale,
  responseText,
  uprightPage,
  type CompletionClient,
  type OcrPageRead,
  type PlannedPtrAttachment,
  type PtrFormFamily,
  type ReadOutcome,
  type ReadPass,
  type ScanPageImages,
} from "./extraction";
import { auditPoliticalIntegrity, type PoliticalIntegrityReport } from "./integrity";
import { parseSlashDate } from "./lake/dates";
import {
  houseFilingRows,
  senateElectronicFilingRows,
  senateFilingWithoutTrades,
  senatePaperFilingRows,
  type SenateReportSource,
} from "./lake/normalize";
import type { PoliticalChamber, PoliticalFilingRow, PoliticalFilingRows } from "./lake/types";
import type { OcrClient } from "./providers/mistralOcr";
import { LocalCache, requestHash } from "./runtime/cache";
import {
  popplerDecryptPdf,
  popplerReadPath,
  popplerRenderPages,
  rotateImage,
  tesseractWords,
} from "./runtime/poppler";
import {
  fetchHouseIndexZip,
  fetchHousePtrPdf,
  houseIndexZipUrl,
  housePeriodicTransactionReports,
  housePtrPdfUrl,
  parseHouseIndexZip,
  type HouseIndexFiling,
} from "./sources/house";
import {
  fetchSenateMedia,
  parseSenateElectronicPtr,
  senatePaperPageImageUrls,
  senateReportId,
  senateReportKind,
  SenateEfdSession,
  type SenateSearchRow,
} from "./sources/senate";
import type { PoliticalRepository } from "./storage/repository";

export interface SyncProgress {
  stage: "discover" | "download" | "extract" | "commit";
  chamber: PoliticalChamber;
  docId?: string;
  message: string;
}

/** Injectable official-source access; defaults perform real House Clerk and Senate eFD requests. */
export interface SyncSenateSource {
  search(submittedStartDate: string): Promise<SenateSearchRow[]>;
  fetchReportHtml(reportPath: string): Promise<string>;
  fetchMedia(url: string): Promise<Buffer>;
}

export interface SyncHouseSource {
  fetchIndexZip(year: number): Promise<Buffer>;
  fetchPdf(filing: HouseIndexFiling): Promise<Buffer>;
}

export interface SyncSources {
  house?: SyncHouseSource;
  senate?: SyncSenateSource;
}

export interface SyncOptions {
  repository: PoliticalRepository;
  cache: LocalCache;
  completion?: CompletionClient;
  ocr?: OcrClient;
  sources?: SyncSources;
  model?: string;
  sinceYear: number;
  year?: number;
  chamber?: PoliticalChamber | "both";
  maxFilings?: number;
  acceptSenateTerms?: boolean;
  dryRun?: boolean;
  now?: Date;
  onProgress?: (progress: SyncProgress) => void;
}

export interface SyncSummary {
  runId: string;
  discovered: number;
  planned: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  audit: PoliticalIntegrityReport | null;
}

function key(row: Pick<PoliticalFilingRow, "chamber" | "docId">): string {
  return `${row.chamber}:${row.docId}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncated(payload: Record<string, unknown>): boolean {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return choices.some((choice) => choice && typeof choice === "object" &&
    ["length", "max_tokens"].includes(String((choice as Record<string, unknown>).finish_reason)));
}

function readRunner(completion: CompletionClient, model: string, form: PtrFormFamily) {
  return async (requests: PlannedPtrAttachment[][], read: ReadPass): Promise<ReadOutcome[]> =>
    Promise.all(requests.map(async (attachments): Promise<ReadOutcome> => {
      const contentKey = ptrBatchIdempotencyKey(model, "lake", attachments, form);
      const result = await extractPtrBatch(completion, {
        model,
        contract: "lake",
        form,
        documents: attachments,
        idempotencyKey: `congressional-disclosures:${form}:${attachments.map((item) => item.sourceId).join(",")}:read-${read.pass}:gap-${Number(read.gap)}:${contentKey}`,
        timeoutMs: 240_000,
      });
      return { attachments, result, ...(truncated(result.rawResponse) ? { truncated: true } : {}) };
    }));
}

async function askUprightRotation(
  completion: CompletionClient,
  model: string,
  candidates: readonly { rotation: 0 | 90 | 180 | 270; image: Buffer }[]
): Promise<0 | 90 | 180 | 270 | null> {
  const schema = {
    type: "json_schema",
    json_schema: {
      name: "page_orientation",
      strict: true,
      schema: { type: "object", properties: { rotation: { type: "integer", enum: [0, 90, 180, 270] } }, required: ["rotation"], additionalProperties: false },
    },
  };
  const body = {
    model,
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Each image is the same disclosure page labeled by clockwise rotation. Return the rotation whose text is upright." },
        ...candidates.flatMap((candidate) => [
          { type: "text", text: `rotation ${candidate.rotation}` },
          { type: "image_url", image_url: { url: `data:image/png;base64,${candidate.image.toString("base64")}` } },
        ]),
      ],
    }],
    response_format: schema,
  };
  const contentKey = requestHash(model, ...candidates.map((candidate) => candidate.image));
  const read = async (index: 1 | 2): Promise<number | null> => {
    const { payload } = await completion.complete({
      model,
      body,
      idempotencyKey: `congressional-disclosures:orientation:read-${index}:${contentKey}`,
      timeoutMs: 120_000,
    });
    try {
      const parsed: unknown = JSON.parse(responseText(payload));
      if (!parsed || typeof parsed !== "object") return null;
      const rotation = (parsed as Record<string, unknown>).rotation;
      return [0, 90, 180, 270].includes(Number(rotation)) ? Number(rotation) : null;
    } catch { return null; }
  };
  const [first, second] = await Promise.all([read(1), read(2)]);
  return first !== null && first === second ? first as 0 | 90 | 180 | 270 : null;
}

async function readOcrPage(
  page: ScanPageImages,
  label: string,
  completion: CompletionClient,
  ocr: OcrClient,
  model: string,
  dpi = 216
): Promise<OcrPageRead> {
  const run = async (source: { image: Buffer; checkImage: Buffer; dpi: number }) => {
    const upright = await uprightPage(source.image, {
      rotate: rotateImage,
      readWords: tesseractWords,
      askUpright: (candidates) => askUprightRotation(completion, model, candidates),
    });
    const checkImage = upright.rotation === 0
      ? source.checkImage
      : await rotateImage(source.checkImage, upright.rotation);
    const [first, second] = await Promise.all([
      ocr.readImage(upright.image, `${label} OCR read 1 at ${source.dpi}dpi`),
      ocr.readImage(checkImage, `${label} OCR read 2 at check resolution`),
    ]);
    const shortfall = ocrPageShortfall(first.markdown, upright.scores, upright.rotation);
    const disagreement = ocrReadsDisagreement(first.markdown, second.markdown);
    if (shortfall || disagreement) return { upright, failure: shortfall ?? disagreement ?? "OCR rejected" };
    return {
      upright,
      read: {
        rotation: upright.rotation,
        scores: upright.scores,
        decidedBy: upright.decidedBy,
        payload: first.payload,
        checkPayload: second.payload,
        markdown: first.markdown,
      },
    };
  };
  return readPageWithRescale({
    source: { image: page.image, checkImage: page.checkImage, dpi },
    ...(page.reRender ? { reRender: page.reRender } : {}),
    readPage: run,
  });
}

async function extractHouse(
  filing: HouseIndexFiling,
  pdf: Buffer,
  completion: CompletionClient,
  ocr: OcrClient | undefined,
  model: string,
  cache: LocalCache,
  processedAt: Date
): Promise<PoliticalFilingRows> {
  const sourceUrl = housePtrPdfUrl(filing.indexYear, filing.docId);
  const source = await cache.archive(pdf, sourceUrl, `${filing.docId}.pdf`);
  const filedOn = parseSlashDate(filing.filingDate);
  const run = await extractHouseFilings(
    [{ filingId: filing.docId, pdf, ...(filedOn ? { filedOn } : {}) }],
    {
      readPath: popplerReadPath,
      renderPages: popplerRenderPages,
      ocrPage: async (page, label) => {
        if (!ocr) throw new Error("MISTRAL_API_KEY is required for scanned House filings");
        return readOcrPage(page, label, completion, ocr, model);
      },
      decrypt: popplerDecryptPdf,
      run: readRunner(completion, model, "house"),
    },
    { ...DEFAULT_HOUSE_EXTRACTION_BUDGETS, ocrConcurrency: 4 },
    2
  );
  const extracted = run.extractions[0];
  if (!extracted) throw new Error(`House ${filing.docId} returned no extraction`);
  return houseFilingRows(filing, source, {
    result: extracted.result, parseMethod: extracted.parseMethod, model,
    contractVersion: ptrContractVersion("lake", "house"),
    ocrArchiveKey: extracted.ocrPages
      ? await cache.archive(Buffer.from(JSON.stringify(extracted.ocrPages)), `ocr://${filing.docId}`, `${filing.docId}.ocr.json`).then((item) => item.rawArchiveKey)
      : null,
    processedAt,
  });
}

function senateSource(report: SenateSearchRow, source: { sourceUrl: string; rawArchiveKey: string; rawSha256: string }, processedAt: Date): SenateReportSource {
  return {
    reportId: senateReportId(report.reportPath), firstName: report.firstName, lastName: report.lastName,
    submittedDate: report.submittedDate, reportTitle: report.reportTitle, processedAt, ...source,
  };
}

async function extractSenate(
  report: SenateSearchRow,
  senate: SyncSenateSource,
  completion: CompletionClient | undefined,
  ocr: OcrClient | undefined,
  model: string,
  cache: LocalCache,
  processedAt: Date
): Promise<PoliticalFilingRows> {
  const docId = senateReportId(report.reportPath);
  const sourceUrl = new URL(report.reportPath, "https://efdsearch.senate.gov").href;
  const html = await senate.fetchReportHtml(report.reportPath);
  const archived = await cache.archive(Buffer.from(html), sourceUrl, `${docId}.html`);
  const source = senateSource(report, archived, processedAt);
  if (senateReportKind(report.reportPath) === "electronic") {
    try { return senateElectronicFilingRows(source, parseSenateElectronicPtr(html)); }
    catch (error) { return senateFilingWithoutTrades(source, "html", "failed", message(error)); }
  }
  if (!completion) return senateFilingWithoutTrades(source, "paper", "failed", "OPENROUTER_API_KEY is required for Senate paper filings");
  if (!ocr) return senateFilingWithoutTrades(source, "paper", "failed", "MISTRAL_API_KEY is required for Senate paper filings");
  const imageUrls = senatePaperPageImageUrls(html);
  if (imageUrls.length === 0) return senateFilingWithoutTrades(source, "paper", "failed", "paper report lists no page images");
  const images = await Promise.all(imageUrls.map((url) => senate.fetchMedia(url)));
  await Promise.all(images.map((image, index) => cache.archive(image, imageUrls[index] ?? sourceUrl, `${docId}-page-${index + 1}.png`)));
  const submittedOn = parseSlashDate(report.submittedDate);
  const run = await extractSenatePaperReports(
    [{ reportId: docId, pages: images, ...(submittedOn ? { filedOn: submittedOn } : {}) }],
    {
      ocrPage: (image, label) => readOcrPage({ image, checkImage: image }, label, completion, ocr, model),
      uprightPageImage: async (image, rotation) => rotation === 0 ? image : rotateImage(image, rotation),
      run: readRunner(completion, model, "senate_paper"),
    },
    DEFAULT_HOUSE_EXTRACTION_BUDGETS.ocrText,
    2,
    4
  );
  const extracted = run.extractions[0];
  if (!extracted) throw new Error(`Senate ${docId} returned no extraction`);
  return senatePaperFilingRows(source, {
    result: extracted.result, model, contractVersion: ptrContractVersion("lake", "senate_paper"),
    ocrArchiveKey: extracted.ocrPages
      ? await cache.archive(Buffer.from(JSON.stringify(extracted.ocrPages)), `ocr://${docId}`, `${docId}.ocr.json`).then((item) => item.rawArchiveKey)
      : null,
  });
}

function years(options: SyncOptions, now: Date): number[] {
  if (options.year !== undefined) return [options.year];
  return Array.from({ length: now.getUTCFullYear() - options.sinceYear + 1 }, (_, index) => options.sinceYear + index);
}

function senateReportYear(report: SenateSearchRow): number {
  const submitted = parseSlashDate(report.submittedDate);
  if (!submitted) throw new Error(`Senate report ${senateReportId(report.reportPath)} has no submitted date`);
  return Number(submitted.slice(0, 4));
}

/** Discover official filings and commit each complete filing independently for resumability. */
export async function syncPoliticalDisclosures(options: SyncOptions): Promise<SyncSummary> {
  const runId = randomUUID();
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const model = options.model ?? "google/gemini-3.1-flash-lite";
  const chamber = options.chamber ?? "both";
  const max = options.maxFilings ?? Number.POSITIVE_INFINITY;
  const existing = await options.repository.snapshot();
  const known = new Map(existing.filings.map((filing) => [key(filing), filing]));
  const shouldProcess = (candidate: { chamber: PoliticalChamber; docId: string }): boolean => known.get(key(candidate))?.extractionStatus !== "ok";
  let discovered = 0;
  let planned = 0;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const indexed: Array<{ chamber: PoliticalChamber; docId: string }> = [];

  const commit = async (rows: PoliticalFilingRows): Promise<void> => {
    if (!options.dryRun) await options.repository.replaceFilings([rows], runId);
    processed += 1;
    rows.filing.extractionStatus === "ok" ? succeeded += 1 : failed += 1;
    options.onProgress?.({ stage: "commit", chamber: rows.filing.chamber, docId: rows.filing.docId, message: rows.filing.extractionStatus });
  };

  try {
    const houseSource: SyncHouseSource = options.sources?.house
      ?? { fetchIndexZip: fetchHouseIndexZip, fetchPdf: (filing) => fetchHousePtrPdf(filing.indexYear, filing.docId) };
    if (chamber !== "senate") {
      const filings: HouseIndexFiling[] = [];
      for (const year of years(options, now)) {
        options.onProgress?.({ stage: "discover", chamber: "house", message: `House index ${year}` });
        const zip = await houseSource.fetchIndexZip(year);
        await options.cache.archive(zip, houseIndexZipUrl(year), `${year}FD.zip`);
        filings.push(...housePeriodicTransactionReports(await parseHouseIndexZip(year, zip)));
      }
      discovered += filings.length;
      const queue = filings.filter((filing) => shouldProcess({ chamber: "house", docId: filing.docId }));
      skipped += filings.length - queue.length;
      const selected = queue.slice(0, Math.max(0, max - processed));
      planned += selected.length;
      // Audit coverage is judged against filings this run attempted or previously
      // completed, never the unattempted tail a bound or interruption leaves behind.
      const unattempted = new Set(queue.slice(selected.length).map((filing) => key({ chamber: "house", docId: filing.docId })));
      indexed.push(...filings
        .map((filing) => ({ chamber: "house" as const, docId: filing.docId }))
        .filter((candidate) => !unattempted.has(key(candidate))));
      if (!options.dryRun && selected.length > 0 && !options.completion) throw new Error("OPENROUTER_API_KEY is required for House extraction");
      for (const filing of selected) {
        if (options.dryRun) {
          options.onProgress?.({ stage: "download", chamber: "house", docId: filing.docId, message: "planned (dry run)" });
          continue;
        }
        options.onProgress?.({ stage: "download", chamber: "house", docId: filing.docId, message: "downloading official PDF" });
        try {
          const pdf = await houseSource.fetchPdf(filing);
          options.onProgress?.({ stage: "extract", chamber: "house", docId: filing.docId, message: "extracting filing" });
          if (options.completion) await commit(await extractHouse(filing, pdf, options.completion, options.ocr, model, options.cache, now));
        } catch (error) {
          failed += 1;
          options.onProgress?.({ stage: "extract", chamber: "house", docId: filing.docId, message: `failed: ${message(error)}` });
        }
      }
    }

    if (chamber !== "house" && processed < max) {
      if (!options.acceptSenateTerms) throw new Error("Senate sync requires --accept-senate-terms");
      options.onProgress?.({ stage: "discover", chamber: "senate", message: "opening Senate eFD session" });
      const senateSource: SyncSenateSource = options.sources?.senate ?? await (async () => {
        const session = await SenateEfdSession.open(true);
        return {
          search: (startDate: string) => session.searchPeriodicTransactionReports(startDate),
          fetchReportHtml: (reportPath: string) => session.fetchReportHtml(reportPath),
          fetchMedia: fetchSenateMedia,
        };
      })();
      const lastYear = options.year ?? now.getUTCFullYear();
      const reports = (await senateSource.search(`01/01/${options.year ?? options.sinceYear}`))
        .filter((report) => senateReportYear(report) <= lastYear);
      discovered += reports.length;
      const queue = reports.filter((report) => shouldProcess({ chamber: "senate", docId: senateReportId(report.reportPath) }));
      skipped += reports.length - queue.length;
      const selected = queue.slice(0, Math.max(0, max - processed));
      planned += selected.length;
      const unattemptedSenate = new Set(queue.slice(selected.length).map((report) => key({ chamber: "senate", docId: senateReportId(report.reportPath) })));
      indexed.push(...reports
        .map((report) => ({ chamber: "senate" as const, docId: senateReportId(report.reportPath) }))
        .filter((candidate) => !unattemptedSenate.has(key(candidate))));
      for (const report of selected) {
        const docId = senateReportId(report.reportPath);
        if (options.dryRun) {
          options.onProgress?.({ stage: "download", chamber: "senate", docId, message: "planned (dry run)" });
          continue;
        }
        options.onProgress?.({ stage: "download", chamber: "senate", docId, message: "downloading official report" });
        try {
          await commit(await extractSenate(report, senateSource, options.completion, options.ocr, model, options.cache, now));
        } catch (error) {
          failed += 1;
          options.onProgress?.({ stage: "extract", chamber: "senate", docId, message: `failed: ${message(error)}` });
        }
      }
    }

    const final = options.dryRun ? null : await options.repository.snapshot();
    const audit = final ? auditPoliticalIntegrity({ now, filings: final.filings, trades: final.trades, events: final.events, indexed }) : null;
    const summary: SyncSummary = { runId, discovered, planned, processed, succeeded, failed, skipped, audit };
    if (!options.dryRun) await options.repository.recordRun({ runId, startedAt, finishedAt: new Date(), status: audit?.passed === false ? "failed" : "ok", detail: JSON.stringify(summary) });
    return summary;
  } catch (error) {
    if (!options.dryRun) await options.repository.recordRun({ runId, startedAt, finishedAt: new Date(), status: "failed", detail: message(error) });
    throw error;
  }
}

export async function auditPoliticalRepository(repository: PoliticalRepository, now = new Date()): Promise<PoliticalIntegrityReport> {
  const snapshot = await repository.snapshot();
  return auditPoliticalIntegrity({ now, filings: snapshot.filings, trades: snapshot.trades, events: snapshot.events });
}
