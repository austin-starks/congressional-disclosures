import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPoliticalTradeEvents } from "../lake/events";
import { SQLitePoliticalRepository } from "../storage/sqlite";
import { identifyFilingRows } from "../identity/apply";
import { filingFixture, identifiedRowsFixture as filingRowsFixture, testResolver, tradeFixture } from "./helpers";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "congressional-disclosures-sqlite-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function repository(name: string): SQLitePoliticalRepository {
  return new SQLitePoliticalRepository(join(directory, `${name}.sqlite`));
}

describe("SQLitePoliticalRepository", () => {
  test("commits a filing, its trades, and events atomically with dates round-tripped", async () => {
    const repo = repository("commit");
    try {
      const update = filingRowsFixture({ trades: [{}] });
      await repo.replaceFilings([update], "run-1");
      const snapshot = await repo.snapshot();
      expect(snapshot.filings).toHaveLength(1);
      expect(snapshot.trades).toHaveLength(1);
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.filings[0]?.availableAt).toEqual(new Date("2024-06-16T03:59:59.999Z"));
      expect(snapshot.trades[0]?.printedTicker).toBe("AAPL");
      expect(snapshot.events[0]?.eventId).toBe("house:20018253:0");
      expect(snapshot.events[0]?.ticker).toBe("AAPL");
    } finally {
      await repo.close();
    }
  });

  test("reprocessing the same filing replaces its trades without duplicates", async () => {
    const repo = repository("idempotent");
    try {
      const first = filingRowsFixture({ trades: [{}, { printedTicker: "MSFT" }] });
      await repo.replaceFilings([first], "run-1");
      const second = filingRowsFixture({
        filing: { extractionStatus: "ok", extractedRows: 1 },
        trades: [{ printedTicker: "TSLA" }],
      });
      await repo.replaceFilings([second], "run-2");
      const snapshot = await repo.snapshot();
      expect(snapshot.filings).toHaveLength(1);
      expect(snapshot.trades.map((trade) => trade.printedTicker)).toEqual(["TSLA"]);
      expect((snapshot.filings[0] as { docId?: string })?.docId).toBe("20018253");
    } finally {
      await repo.close();
    }
  });

  test("repeated observations across filings consolidate into one event version", async () => {
    const repo = repository("events");
    try {
      const later = filingRowsFixture({
        filing: { docId: "20018999", filingDate: "2024-07-01", availableAt: new Date("2024-07-02T03:59:59.999Z") },
        trades: [{ transactionDate: "2024-06-10", availableAt: new Date("2024-07-02T03:59:59.999Z") }],
      });
      await repo.replaceFilings([later], "run-1");
      const earlier = filingRowsFixture();
      await repo.replaceFilings([earlier], "run-2");
      const snapshot = await repo.snapshot();
      expect(snapshot.filings).toHaveLength(2);
      expect(snapshot.trades).toHaveLength(2);
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0]?.version).toBe(1);
      const contributors = JSON.parse(snapshot.events[0]?.contributorRowIds ?? "[]") as unknown[];
      expect(contributors).toHaveLength(2);
      expect(snapshot.events[0]?.firstAvailableAt).toEqual(new Date("2024-06-16T03:59:59.999Z"));
    } finally {
      await repo.close();
    }
  });

  test("a failed commit rolls back the filing, trades, and events entirely", async () => {
    const repo = repository("rollback");
    try {
      await repo.replaceFilings([filingRowsFixture()], "run-1");
      const before = await repo.snapshot();
      // Two trades with the same row index violate the trade primary key mid-commit.
      const broken = identifyFilingRows({
        filing: filingFixture({ docId: "20018500", filerLast: "Broken" }),
        trades: [tradeFixture({ docId: "20018500", rowIndex: 0 }), tradeFixture({ docId: "20018500", rowIndex: 0 })],
      }, testResolver());
      await expect(repo.replaceFilings([broken], "run-2")).rejects.toThrow();
      const after = await repo.snapshot();
      expect(after.filings).toEqual(before.filings);
      expect(after.trades).toEqual(before.trades);
      expect(after.events).toEqual(before.events);
    } finally {
      await repo.close();
    }
  });

  test("scoped per-filer rebuild equals a whole-lake rebuild", async () => {
    const repo = repository("parity");
    try {
      const pelosi = filingRowsFixture();
      const hatch = filingRowsFixture({
        filing: { docId: "20018111", filerFirst: "Orrin", filerLast: "Hatch", stateDistrict: "UT" },
        trades: [{ printedTicker: "GOOG" }],
      });
      const feinstein = filingRowsFixture({
        filing: { docId: "20018222", filerFirst: "Dianne", filerLast: "Feinstein", stateDistrict: "CA" },
        trades: [{ printedTicker: "NVDA" }, { printedTicker: "AMZN" }],
      });
      await repo.replaceFilings([pelosi, hatch], "run-1");
      await repo.replaceFilings([feinstein], "run-2");
      const scoped = await repo.snapshot();

      const rebuilt = buildPoliticalTradeEvents(scoped.trades, scoped.filings);
      const shape = (rows: typeof rebuilt) => rows.map((row) => ({
        eventId: row.eventId, version: row.version, supersededAt: row.supersededAt,
        firstAvailableAt: row.firstAvailableAt.toISOString(), contributorRowIds: row.contributorRowIds,
      })).sort((left, right) => `${left.eventId}:${left.version}`.localeCompare(`${right.eventId}:${right.version}`));
      expect(shape(scoped.events)).toEqual(shape(rebuilt));
      expect(scoped.events).toHaveLength(rebuilt.length);
    } finally {
      await repo.close();
    }
  });

  test("records sync runs", async () => {
    const repo = repository("runs");
    try {
      await repo.recordRun({
        runId: "run-1", startedAt: new Date("2026-09-19T01:00:00Z"),
        finishedAt: new Date("2026-09-19T01:01:00Z"), status: "ok", detail: "{}",
      });
      const raw = (repo as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db
        .prepare("SELECT run_id, status FROM sync_runs").all();
      expect(raw).toEqual([{ run_id: "run-1", status: "ok" }]);
    } finally {
      await repo.close();
    }
  });
});
