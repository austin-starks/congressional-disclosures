import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  estimateDatasetSqliteBytes,
  materializeCongressionalDatasetSqlite,
  type CongressionalDatasetSnapshot,
  type DatasetFile,
} from "../dataset";
import { buildPoliticalTradeEvents } from "../lake/events";
import { SQLitePoliticalRepository } from "../storage/sqlite";
import { filingFixture, tradeFixture } from "./helpers";

const TABLES = ["political_filings", "political_trades", "political_trade_events"] as const;

function fixtureSnapshot(): CongressionalDatasetSnapshot {
  const tables: CongressionalDatasetSnapshot["tables"] = {};
  for (const table of TABLES) {
    const publicPath = `data/${table}/2026.parquet`;
    const file: DatasetFile = {
      publicPath,
      size: 1,
      sha256: "0".repeat(64),
    };
    tables[table] = { rows: 1, years: [2026], manifests: [{ year: 2026, files: [file] }] };
  }
  return {
    schemaVersion: 1,
    dataset: "austin-starks/congressional-stock-trades",
    generatedAt: "2026-09-20T00:00:00.000Z",
    totals: { filings: 1, trades: 1, events: 1, failedFilings: 0 },
    tables,
  };
}

const filing = filingFixture();
const trade = tradeFixture();
const [event] = buildPoliticalTradeEvents([trade], [filing]);
if (!event) throw new Error("event fixture was not created");

async function readFixtureParquet(path: string): Promise<readonly unknown[]> {
  if (path.includes("political_trade_events")) return [event];
  if (path.includes("political_trades")) return [trade];
  if (path.includes("political_filings")) return [filing];
  throw new Error(`No fixture for ${path}`);
}

describe("public dataset SQLite materialization", () => {
  test("converts published snapshot rows into a standalone queryable database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "congressional-sqlite-"));
    const database = join(directory, "congressional.sqlite");
    const snapshot = fixtureSnapshot();

    const result = await materializeCongressionalDatasetSqlite({
      datasetDirectory: directory,
      databasePath: database,
      snapshot,
      readParquetFile: readFixtureParquet,
    });

    expect(result).toMatchObject({ database, filings: 1, trades: 1, events: 1 });
    expect(result.databaseBytes).toBe((await stat(database)).size);
    await expect(stat(`${database}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${database}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    const repository = new SQLitePoliticalRepository(database);
    try {
      expect(await repository.counts()).toEqual({ filings: 1, trades: 1, events: 1, failedFilings: 0 });
      const lake = await repository.snapshot();
      expect(lake.events[0]).toMatchObject({ filerLast: "Pelosi", ticker: "AAPL", action: "purchase" });
      expect(lake.events[0]?.transactionDate).toBe("2024-06-10");
    } finally {
      await repository.close();
    }
  });

  test("leaves an existing database untouched if source validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "congressional-sqlite-"));
    const database = join(directory, "congressional.sqlite");
    await writeFile(database, "existing database");
    const snapshot = fixtureSnapshot();
    const events = snapshot.tables.political_trade_events;
    if (!events) throw new Error("fixture snapshot is missing political_trade_events");
    events.manifests[0] = {
      year: 2026,
      files: [{ publicPath: "data/political_trade_events/missing.parquet", size: 1, sha256: "0".repeat(64) }],
    };

    await expect(materializeCongressionalDatasetSqlite({
      datasetDirectory: directory,
      databasePath: database,
      snapshot,
      readParquetFile: async (path) => {
        if (path.endsWith("missing.parquet")) throw new Error("missing fixture");
        return readFixtureParquet(path);
      },
    })).rejects.toThrow();
    expect(await readFile(database, "utf8")).toBe("existing database");
  });

  test("rejects a materialization path outside its declared table directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "congressional-sqlite-"));
    const snapshot = fixtureSnapshot();
    const events = snapshot.tables.political_trade_events;
    if (!events) throw new Error("fixture snapshot is missing political_trade_events");
    events.manifests[0] = {
      year: 2026,
      files: [{ publicPath: "../outside.parquet", size: 1, sha256: "0".repeat(64) }],
    };

    await expect(materializeCongressionalDatasetSqlite({
      datasetDirectory: directory,
      databasePath: join(directory, "congressional.sqlite"),
      snapshot,
      readParquetFile: readFixtureParquet,
    })).rejects.toThrow(/safe political_trade_events dataset path/);
  });

  test("budgets for SQLite expansion instead of reporting only compressed Parquet bytes", async () => {
    expect(estimateDatasetSqliteBytes(fixtureSnapshot())).toBe(256_000_000);
  });
});
