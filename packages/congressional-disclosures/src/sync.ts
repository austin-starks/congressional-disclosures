import { randomUUID } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import {
  decidePtrConsensus,
  extractPtrBatch,
  ptrContractVersion,
  readsAgree,
  type CompletionClient,
  type PtrDocumentInput,
  type PtrDocumentResult,
  type PtrFormFamily,
} from "./extraction";
import { auditPoliticalIntegrity, type PoliticalIntegrityReport } from "./integrity";
import {
  houseFilingRows,
  senateElectronicFilingRows,
  senateFilingWithoutTrades,
  senatePaperFilingRows,
  type SenateReportSource,
} from "./lake/normalize";
import type { PoliticalChamber, PoliticalFilingRow, PoliticalFilingRows } from "./lake/types";
import type { OcrClient, OcrPageResult } from "./providers/mistralOcr";
import { LocalCache } from "./runtime/cache";
import { popplerDecryptPdf, popplerReadPath } from "./runtime/poppler";
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

async function decryptIfNeeded(pdf: Buffer): Promise<Buffer> {
  const document = await PDFDocument.load(pdf, { ignoreEncryption: true });
  return document.isEncrypted ? popplerDecryptPdf(pdf) : pdf;
}

async function extractWithConsensus(
  completion: CompletionClient,
  model: string,
  form: PtrFormFamily,
  document: PtrDocumentInput
): Promise<PtrDocumentResult> {
  const read = async (pass: number): Promise<PtrDocumentResult | undefined> => {
    const batch = await extractPtrBatch(completion, {
      model,
      contract: "lake",
      form,
      documents: [document],
      idempotencyKey: `congressional-disclosures:${form}:${document.sourceId}:read-${pass}`,
      timeoutMs: 240_000,
    });
    return batch.documents.find((candidate) => candidate.sourceId === document.sourceId);
  };
  const first = await read(1);
  const second = await read(2);
  if (first && readsAgree(first, second)) return first;
  const third = await read(3);
  return decidePtrConsensus(
    [document.sourceId],
    [new Map(first ? [[document.sourceId, first]] : []), new Map(second ? [[document.sourceId, second]] : []), new Map(third ? [[document.sourceId, third]] : [])]
  )[0]?.result ?? {
    sourceId: document.sourceId, rows: [], noTransactionsStatement: null, amendedReportDate: null,
    amendedReportDateIso: null, nonTransactionRows: [], continuationRows: [], invalidRowIndexes: [],
    reviewRowIndexes: [], error: "extraction returned no consensus result",
  };
}

async function ocrArchive(cache: LocalCache, docId: string, pages: readonly OcrPageResult[]): Promise<string> {
  return (await cache.archive(Buffer.from(JSON.stringify(pages.map((page) => page.payload))), `ocr://${docId}`, `${docId}.ocr.json`)).rawArchiveKey;
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
  const copyable = await decryptIfNeeded(pdf);
  const path = await popplerReadPath(copyable);
  let ocrPages: OcrPageResult[] = [];
  if (path === "page_image_ocr") {
    if (!ocr) throw new Error("MISTRAL_API_KEY is required for scanned House filings");
    ocrPages = await ocr.readPdf(copyable, `House ${filing.docId}`);
  }
  const result = await extractWithConsensus(completion, model, "house", {
    sourceId: filing.docId,
    pdf: copyable,
    ...(ocrPages.length > 0 ? { ocrPages: ocrPages.map((page) => page.markdown), ocrWithPdf: true } : {}),
  });
  return houseFilingRows(filing, source, {
    result, parseMethod: path === "text_layer" ? "text" : "scan", model,
    contractVersion: ptrContractVersion("lake", "house"),
    ocrArchiveKey: ocrPages.length > 0 ? await ocrArchive(cache, filing.docId, ocrPages) : null,
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
  const imageUrls = senatePaperPageImageUrls(html).map((url) => new URL(url, "https://efdsearch.senate.gov").href);
  if (imageUrls.length === 0) return senateFilingWithoutTrades(source, "paper", "failed", "paper report lists no page images");
  const images = await Promise.all(imageUrls.map((url) => senate.fetchMedia(url)));
  await Promise.all(images.map((image, index) => cache.archive(image, imageUrls[index] ?? sourceUrl, `${docId}-page-${index + 1}.png`)));
  const ocrPages = await Promise.all(images.map((image, index) => ocr.readImage(image, `Senate ${docId} page ${index + 1}`)));
  const result = await extractWithConsensus(completion, model, "senate_paper", {
    sourceId: docId, ocrPages: ocrPages.map((page) => page.markdown), pageImages: images, ocrWithPageImages: true,
  });
  return senatePaperFilingRows(source, {
    result, model, contractVersion: ptrContractVersion("lake", "senate_paper"),
    ocrArchiveKey: await ocrArchive(cache, docId, ocrPages),
  });
}

function years(options: SyncOptions, now: Date): number[] {
  if (options.year !== undefined) return [options.year];
  return Array.from({ length: now.getUTCFullYear() - options.sinceYear + 1 }, (_, index) => options.sinceYear + index);
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
      indexed.push(...filings.map((filing) => ({ chamber: "house" as const, docId: filing.docId })));
      const queue = filings.filter((filing) => shouldProcess({ chamber: "house", docId: filing.docId }));
      skipped += filings.length - queue.length;
      const selected = queue.slice(0, Math.max(0, max - processed));
      planned += selected.length;
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
      const reports = await senateSource.search(`01/01/${options.year ?? options.sinceYear}`);
      discovered += reports.length;
      indexed.push(...reports.map((report) => ({ chamber: "senate" as const, docId: senateReportId(report.reportPath) })));
      const queue = reports.filter((report) => shouldProcess({ chamber: "senate", docId: senateReportId(report.reportPath) }));
      skipped += reports.length - queue.length;
      const selected = queue.slice(0, Math.max(0, max - processed));
      planned += selected.length;
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
