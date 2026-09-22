import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { CompletionClient, CompletionUsage } from "../extraction";
import { LocalCache } from "../runtime/cache";
import { commandAvailable } from "../runtime/poppler";
import { SQLitePoliticalRepository } from "../storage/sqlite";
import { syncPoliticalDisclosures, type SyncHouseSource, type SyncSenateSource } from "../sync";
import type { SenateSearchRow } from "../sources/senate";
import { testResolver } from "./helpers";

const NOW = new Date("2024-07-02T12:00:00.000Z");

const INDEX_2024 = [
  "prefix\tlast\tfirst\tsuffix\tfilingtype\tstatedst\tyear\tfilingdate\tdocid",
  "Hon.\tPelosi\tNancy\t\tP\tCA12\t2024\t06/15/2024\t20018253",
  "Ms.\tLee\tBarbara\t\tP\tCA13\t2024\t06/18/2024\t20018255",
  "Mr.\tSmith\tBob\t\tZ\tTX01\t2024\t06/14/2024\t20018254",
].join("\n");

const EXTRACTED_ROW: Record<string, unknown> = {
  transaction_type_code: "P",
  owner: "self",
  partial_sale: false,
  asset_description: "Apple Inc. Common Stock",
  amount_bracket: "$1,001 - $15,000",
  amount_category: "$1,001 - $15,000",
  ticker: "AAPL",
  transaction_date_iso: "2024-06-10",
  notification_date_iso: null,
};

const BAD_TYPE_ROW: Record<string, unknown> = { ...EXTRACTED_ROW, transaction_type_code: "X" };

type Script = Record<string, Record<string, unknown>[] | undefined>;

/** Serves scripted per-document rows, keyed by the docId embedded in sync's idempotency key. */
class ScriptedCompletion implements CompletionClient {
  calls = 0;
  constructor(private readonly script: Script) {}

  async complete(request: { idempotencyKey?: string }): Promise<{ payload: Record<string, unknown>; usage: CompletionUsage }> {
    this.calls += 1;
    const parts = (request.idempotencyKey ?? "").split(":");
    const docId = parts[2] ?? "";
    const rows = this.script[docId];
    const content = JSON.stringify({
      documents: [{
        source_id: docId,
        rows: rows ?? [],
        no_transactions_statement: null,
        amended_report_date: null,
        non_transaction_rows: [],
        continuation_rows: [],
        invalid_row_indexes: [],
        review_row_indexes: [],
      }],
    });
    return {
      payload: { choices: [{ message: { content } }], model: "scripted-model" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

async function houseIndexZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("2024FD.txt", INDEX_2024);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function textLayerPdf(filer: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(`Periodic Transaction Report ${filer} Apple Common Stock purchase June disclosure statement`, {
    x: 50, y: 720, size: 12, font,
  });
  page.drawText("Transaction type purchase amount bracket owner self ticker symbol column header", {
    x: 50, y: 700, size: 12, font,
  });
  return Buffer.from(await pdf.save());
}

function houseSource(pdfFetches: { count: number }): SyncHouseSource {
  return {
    fetchIndexZip: houseIndexZip,
    fetchPdf: async (filing) => {
      pdfFetches.count += 1;
      return textLayerPdf(`${filing.last}-${filing.docId}`);
    },
  };
}

const SENATE_REPORT_PATH = "/search/view/ptr/5b2f0c3a-1d4e-4f5a-9b8c-7a6d5e4f3c21/";

const SENATE_ROW: SenateSearchRow = {
  firstName: "Jane", lastName: "Doe", filerName: "Doe, Jane",
  reportPath: SENATE_REPORT_PATH,
  reportTitle: "Periodic Transaction Report for 06/10/2024",
  submittedDate: "06/12/2024",
};

const SENATE_HTML = `<html><body><table>
  <thead><tr><th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th><th>Asset Name</th>
  <th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th></tr></thead>
  <tbody><tr><td>1</td><td>06/01/2024</td><td>Self</td><td>AAPL</td><td>Apple Inc. Common Stock</td>
  <td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr></tbody>
</table></body></html>`;

function senateSource(htmlFetches: { count: number }): SyncSenateSource {
  return {
    search: async () => [SENATE_ROW],
    fetchReportHtml: async () => {
      htmlFetches.count += 1;
      return SENATE_HTML;
    },
    fetchMedia: async () => {
      throw new Error("unexpected media fetch");
    },
  };
}

let directory: string;
let hasPoppler = false;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "congressional-disclosures-sync-"));
  hasPoppler = await commandAvailable("pdftotext");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function dbPath(name: string): string { return join(directory, `${name}.sqlite`); }
function cachePath(name: string): string { return join(directory, `cache-${name}`); }

describe("syncPoliticalDisclosures", () => {
  test("extracts and commits House filings end to end, then skips them on resume", async () => {
    if (!hasPoppler) return;
    const repository = new SQLitePoliticalRepository(dbPath("house"));
    const completion = new ScriptedCompletion({ "20018253": [EXTRACTED_ROW], "20018255": [EXTRACTED_ROW] });
    const pdfFetches = { count: 0 };
    try {
      const first = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("house")), completion,
        sinceYear: 2024, chamber: "house", acceptSenateTerms: false, now: NOW,
        sources: { house: houseSource(pdfFetches) },
      });
      expect(first.discovered).toBe(2);
      expect(first.succeeded).toBe(2);
      expect(first.failed).toBe(0);
      expect(pdfFetches.count).toBe(2);
      expect(completion.calls).toBe(4);

      const snapshot = await repository.snapshot();
      expect(snapshot.filings.map((filing) => filing.docId).sort()).toEqual(["20018253", "20018255"]);
      expect(snapshot.filings.every((filing) => filing.extractionStatus === "ok")).toBe(true);
      expect(snapshot.trades).toHaveLength(2);
      expect(snapshot.trades.every((trade) => trade.printedTicker === "AAPL")).toBe(true);
      expect(snapshot.events).toHaveLength(2);

      const callsAfterFirstRun = completion.calls;
      const second = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("house")), completion,
        sinceYear: 2024, chamber: "house", acceptSenateTerms: false, now: NOW,
        sources: { house: houseSource(pdfFetches) },
      });
      expect(second.planned).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.succeeded).toBe(0);
      expect(pdfFetches.count).toBe(2);
      expect(completion.calls).toBe(callsAfterFirstRun);
    } finally {
      await repository.close();
    }
  }, 60_000);

  test("dry run plans without downloads, provider calls, or lake writes", async () => {
    const repository = new SQLitePoliticalRepository(dbPath("dry"));
    const completion = new ScriptedCompletion({});
    const pdfFetches = { count: 0 };
    try {
      const summary = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("dry")), completion,
        sinceYear: 2024, chamber: "house", acceptSenateTerms: false, now: NOW, dryRun: true,
        sources: { house: houseSource(pdfFetches) },
      });
      expect(summary.discovered).toBe(2);
      expect(summary.planned).toBe(2);
      expect(summary.processed).toBe(0);
      expect(pdfFetches.count).toBe(0);
      expect(completion.calls).toBe(0);
      expect(summary.audit).toBeNull();
      const snapshot = await repository.snapshot();
      expect(snapshot.filings).toHaveLength(0);
      expect(snapshot.trades).toHaveLength(0);
    } finally {
      await repository.close();
    }
  });

  test("failed House filings are retried on the next run", async () => {
    if (!hasPoppler) return;
    const repository = new SQLitePoliticalRepository(dbPath("retry"));
    const pdfFetches = { count: 0 };
    try {
      const failing = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("retry")),
        completion: new ScriptedCompletion({ "20018253": [BAD_TYPE_ROW] }),
        sinceYear: 2024, chamber: "house", maxFilings: 1, acceptSenateTerms: false, now: NOW,
        sources: { house: houseSource(pdfFetches) },
      });
      expect(failing.succeeded).toBe(0);
      expect(failing.failed).toBe(1);
      const afterFailure = await repository.snapshot();
      expect(afterFailure.filings[0]?.extractionStatus).toBe("failed");
      expect(afterFailure.trades).toHaveLength(0);

      const retrying = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("retry")),
        completion: new ScriptedCompletion({ "20018253": [EXTRACTED_ROW] }),
        sinceYear: 2024, chamber: "house", maxFilings: 1, acceptSenateTerms: false, now: NOW,
        sources: { house: houseSource(pdfFetches) },
      });
      expect(retrying.planned).toBe(1);
      expect(retrying.succeeded).toBe(1);
      const afterRetry = await repository.snapshot();
      expect(afterRetry.filings[0]?.extractionStatus).toBe("ok");
      expect(afterRetry.trades).toHaveLength(1);
    } finally {
      await repository.close();
    }
  }, 60_000);

  test("commits Senate electronic filings from parsed HTML without any provider", async () => {
    const repository = new SQLitePoliticalRepository(dbPath("senate"));
    const htmlFetches = { count: 0 };
    try {
      const summary = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("senate")),
        sinceYear: 2024, chamber: "senate", acceptSenateTerms: true, now: NOW,
        sources: { senate: senateSource(htmlFetches) },
      });
      expect(summary.discovered).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(htmlFetches.count).toBe(1);
      const snapshot = await repository.snapshot();
      expect(snapshot.filings[0]).toMatchObject({
        chamber: "senate", docId: "5b2f0c3a-1d4e-4f5a-9b8c-7a6d5e4f3c21",
        parseMethod: "html", extractionStatus: "ok", extractedRows: 1,
      });
      expect(snapshot.trades[0]).toMatchObject({ action: "purchase", printedTicker: "AAPL", owner: "self" });
      expect(snapshot.events).toHaveLength(1);

      const second = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("senate")),
        sinceYear: 2024, chamber: "senate", acceptSenateTerms: true, now: NOW,
        sources: { senate: senateSource(htmlFetches) },
      });
      expect(second.skipped).toBe(1);
      expect(second.planned).toBe(0);
      expect(htmlFetches.count).toBe(1);
      const refetched = await repository.snapshot();
      expect(refetched.trades).toHaveLength(1);
    } finally {
      await repository.close();
    }
  });

  test("refuses Senate access without accepted terms", async () => {
    const repository = new SQLitePoliticalRepository(dbPath("terms"));
    try {
      await expect(syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("terms")),
        sinceYear: 2024, chamber: "senate", acceptSenateTerms: false, now: NOW,
        sources: { senate: senateSource({ count: 0 }) },
      })).rejects.toThrow(/accept-senate-terms/);
    } finally {
      await repository.close();
    }
  });

  test("--year excludes later Senate reports returned by the start-date search", async () => {
    const repository = new SQLitePoliticalRepository(dbPath("senate-year"));
    const later: SenateSearchRow = {
      ...SENATE_ROW,
      reportPath: "/search/view/ptr/6c3f1d4b-2e5f-4a6b-8c9d-8b7e6f5a4d32/",
      submittedDate: "01/02/2025",
    };
    try {
      const summary = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("senate-year")),
        sinceYear: 2024, year: 2024, chamber: "senate", acceptSenateTerms: true, now: NOW,
        sources: { senate: {
          search: async () => [SENATE_ROW, later],
          fetchReportHtml: async () => SENATE_HTML,
          fetchMedia: async () => { throw new Error("unexpected media fetch"); },
        } },
      });
      expect(summary.discovered).toBe(1);
      expect(summary.succeeded).toBe(1);
      const snapshot = await repository.snapshot();
      expect(snapshot.filings.map((filing) => filing.docId)).toEqual([
        "5b2f0c3a-1d4e-4f5a-9b8c-7a6d5e4f3c21",
      ]);
    } finally {
      await repository.close();
    }
  });

  test("bounds one run to --max-filings", async () => {
    if (!hasPoppler) return;
    const repository = new SQLitePoliticalRepository(dbPath("max"));
    const pdfFetches = { count: 0 };
    try {
      const summary = await syncPoliticalDisclosures({
        resolver: testResolver(),
        repository, cache: new LocalCache(cachePath("max")),
        completion: new ScriptedCompletion({ "20018253": [EXTRACTED_ROW] }),
        sinceYear: 2024, chamber: "house", maxFilings: 1, acceptSenateTerms: false, now: NOW,
        sources: { house: houseSource(pdfFetches) },
      });
      expect(summary.planned).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(pdfFetches.count).toBe(1);
    } finally {
      await repository.close();
    }
  }, 60_000);
});
