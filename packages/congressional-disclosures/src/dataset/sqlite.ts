import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  POLITICAL_ACTIONS,
  POLITICAL_CHAMBERS,
  POLITICAL_EXTRACTION_STATUSES,
  POLITICAL_PARSE_METHODS,
  RESOLUTION_STATUSES,
  type PoliticalAction,
  type PoliticalChamber,
  type PoliticalExtractionStatus,
  type PoliticalFilingRow,
  type PoliticalLakeSnapshot,
  type PoliticalOwner,
  type PoliticalParseMethod,
  type PoliticalTradeEventRow,
  type PoliticalTradeRow,
  type ResolutionStatus,
} from "../lake/types";
import type { IdentifiedFilingRow, IdentifiedTradeRow } from "../identity/apply";
import { IDENTITY_SOURCES, type FilerIdentity } from "../identity/types";
import { SQLitePoliticalRepository } from "../storage/sqlite";
import type { CongressionalDatasetSnapshot, DatasetTable } from "./download";

const REQUIRED_TABLES = ["political_filings", "political_trades", "political_trade_events"] as const;

export interface MaterializeCongressionalDatasetSqliteOptions {
  datasetDirectory: string;
  databasePath: string;
  snapshot: CongressionalDatasetSnapshot;
  readParquetFile?: (path: string) => Promise<readonly unknown[]>;
  onPlan?: (plan: DatasetSqlitePlan) => void;
  onProgress?: (message: string) => void;
}

export interface DatasetSqlitePlan {
  database: string;
  estimatedBytes: number;
  availableBytes: number;
  enoughSpace: boolean;
}

export interface MaterializedCongressionalDatasetSqlite {
  database: string;
  databaseBytes: number;
  filings: number;
  trades: number;
  events: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function nullableString(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string or null`);
  return value;
}

function numberValue(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new Error(`${name} must be a finite number`);
}

function nullableNumber(row: Record<string, unknown>, name: string): number | null {
  return row[name] === null || row[name] === undefined ? null : numberValue(row, name);
}

function booleanValue(row: Record<string, unknown>, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function nullableBoolean(row: Record<string, unknown>, name: string): boolean | null {
  return row[name] === null || row[name] === undefined ? null : booleanValue(row, name);
}

function dateValue(row: Record<string, unknown>, name: string): Date {
  const value = row[name];
  const parsed = value instanceof Date ? value : new Date(stringValue(row, name));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be a valid date`);
  return parsed;
}

function nullableDate(row: Record<string, unknown>, name: string): Date | null {
  return row[name] === null || row[name] === undefined ? null : dateValue(row, name);
}

function dateOnly(row: Record<string, unknown>, name: string): string {
  return dateValue(row, name).toISOString().slice(0, 10);
}

function nullableDateOnly(row: Record<string, unknown>, name: string): string | null {
  return row[name] === null || row[name] === undefined ? null : dateOnly(row, name);
}

function enumValue<const T extends readonly string[]>(
  row: Record<string, unknown>,
  name: string,
  values: T,
): T[number] {
  const value = stringValue(row, name);
  if (!values.includes(value)) throw new Error(`${name} has unsupported value ${value}`);
  return value as T[number];
}

/** Identity columns, present in every snapshot published by 2.0 and later. */
function identity(row: Record<string, unknown>, table: string): FilerIdentity {
  if (!("filerKey" in row) || !("identitySource" in row)) {
    throw new Error(`${table} has no member identity columns; this snapshot predates congressional-disclosures 2.0`);
  }
  return {
    filerKey: stringValue(row, "filerKey"),
    memberId: nullableString(row, "memberId"),
    displayName: stringValue(row, "displayName"),
    identitySource: enumValue(row, "identitySource", IDENTITY_SOURCES),
  };
}

function filingRow(value: unknown): IdentifiedFilingRow {
  const row = object(value, "political_filings row");
  return {
    ...identity(row, "political_filings"),
    chamber: enumValue(row, "chamber", POLITICAL_CHAMBERS) as PoliticalChamber,
    docId: stringValue(row, "docId"),
    filerFirst: stringValue(row, "filerFirst"),
    filerLast: stringValue(row, "filerLast"),
    filerSuffix: nullableString(row, "filerSuffix"),
    stateDistrict: nullableString(row, "stateDistrict"),
    filingDate: dateOnly(row, "filingDate"),
    availableAt: dateValue(row, "availableAt"),
    availabilitySource: stringValue(row, "availabilitySource"),
    sourceUrl: stringValue(row, "sourceUrl"),
    rawArchiveKey: stringValue(row, "rawArchiveKey"),
    rawSha256: stringValue(row, "rawSha256"),
    parseMethod: enumValue(row, "parseMethod", POLITICAL_PARSE_METHODS) as PoliticalParseMethod,
    extractionStatus: enumValue(row, "extractionStatus", POLITICAL_EXTRACTION_STATUSES) as PoliticalExtractionStatus,
    failureReason: nullableString(row, "failureReason"),
    extractedRows: numberValue(row, "extractedRows"),
    extractionModel: nullableString(row, "extractionModel"),
    contractVersion: nullableString(row, "contractVersion"),
    ocrArchiveKey: nullableString(row, "ocrArchiveKey"),
    amendedReportDate: nullableDateOnly(row, "amendedReportDate"),
    reportDate: nullableDateOnly(row, "reportDate"),
    processedAt: dateValue(row, "processedAt"),
  };
}

function tradeRow(value: unknown): IdentifiedTradeRow {
  const row = object(value, "political_trades row");
  return {
    ...identity(row, "political_trades"),
    chamber: enumValue(row, "chamber", POLITICAL_CHAMBERS) as PoliticalChamber,
    docId: stringValue(row, "docId"),
    rowIndex: numberValue(row, "rowIndex"),
    sourceTransactionId: nullableString(row, "sourceTransactionId"),
    filerFirst: stringValue(row, "filerFirst"),
    filerLast: stringValue(row, "filerLast"),
    owner: stringValue(row, "owner") as PoliticalOwner,
    ownerCodeRaw: nullableString(row, "ownerCodeRaw"),
    action: enumValue(row, "action", POLITICAL_ACTIONS) as PoliticalAction,
    partialSale: booleanValue(row, "partialSale"),
    actionCodeRaw: nullableString(row, "actionCodeRaw"),
    transactionDate: nullableDateOnly(row, "transactionDate"),
    notificationDate: nullableDateOnly(row, "notificationDate"),
    filingDate: dateOnly(row, "filingDate"),
    availableAt: dateValue(row, "availableAt"),
    availabilitySource: stringValue(row, "availabilitySource"),
    assetDescription: stringValue(row, "assetDescription"),
    printedTicker: nullableString(row, "printedTicker"),
    resolvedTicker: nullableString(row, "resolvedTicker"),
    resolutionStatus: enumValue(row, "resolutionStatus", RESOLUTION_STATUSES) as ResolutionStatus,
    resolutionReason: nullableString(row, "resolutionReason"),
    assetTypeCode: nullableString(row, "assetTypeCode"),
    assetTypeLabel: nullableString(row, "assetTypeLabel"),
    amountBracket: stringValue(row, "amountBracket"),
    amountLow: nullableNumber(row, "amountLow"),
    amountHigh: nullableNumber(row, "amountHigh"),
    capGainsOver200: nullableBoolean(row, "capGainsOver200"),
    comment: nullableString(row, "comment"),
    filingStatus: nullableString(row, "filingStatus"),
    sourceUrl: stringValue(row, "sourceUrl"),
    rawArchiveKey: stringValue(row, "rawArchiveKey"),
    rawSha256: stringValue(row, "rawSha256"),
  };
}

function eventRow(value: unknown): PoliticalTradeEventRow {
  const row = object(value, "political_trade_events row");
  return {
    ...identity(row, "political_trade_events"),
    eventId: stringValue(row, "eventId"),
    version: numberValue(row, "version"),
    chamber: enumValue(row, "chamber", POLITICAL_CHAMBERS) as PoliticalChamber,
    filerFirst: stringValue(row, "filerFirst"),
    filerLast: stringValue(row, "filerLast"),
    owner: stringValue(row, "owner") as PoliticalOwner,
    action: enumValue(row, "action", POLITICAL_ACTIONS) as PoliticalAction,
    partialSale: booleanValue(row, "partialSale"),
    transactionDate: nullableDateOnly(row, "transactionDate"),
    ticker: nullableString(row, "ticker"),
    sourceTransactionId: nullableString(row, "sourceTransactionId"),
    assetDescription: stringValue(row, "assetDescription"),
    comment: nullableString(row, "comment"),
    assetTypeCode: nullableString(row, "assetTypeCode"),
    assetTypeLabel: nullableString(row, "assetTypeLabel"),
    amountLow: nullableNumber(row, "amountLow"),
    amountHigh: nullableNumber(row, "amountHigh"),
    firstAvailableAt: dateValue(row, "firstAvailableAt"),
    availableAt: dateValue(row, "availableAt"),
    supersededAt: nullableDate(row, "supersededAt"),
    sourceDocId: stringValue(row, "sourceDocId"),
    sourceRowIndex: numberValue(row, "sourceRowIndex"),
    sourceUrl: stringValue(row, "sourceUrl"),
    contributorRowIds: stringValue(row, "contributorRowIds"),
  };
}

function requiredTable(snapshot: CongressionalDatasetSnapshot, name: string): DatasetTable {
  const table = snapshot.tables[name];
  if (!table) throw new Error(`Public snapshot is missing ${name}`);
  return table;
}

export function estimateDatasetSqliteBytes(snapshot: CongressionalDatasetSnapshot): number {
  const parquetBytes = REQUIRED_TABLES.reduce((total, name) => total + requiredTable(snapshot, name).manifests
    .flatMap((manifest) => manifest.files)
    .reduce((tableTotal, file) => tableTotal + file.size, 0), 0);
  return Math.max(256_000_000, parquetBytes * 32);
}

async function availableBytes(path: string): Promise<number> {
  const stats = await statfs(path, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

export async function datasetSqlitePlan(
  databasePath: string,
  snapshot: CongressionalDatasetSnapshot,
): Promise<DatasetSqlitePlan> {
  const database = resolve(databasePath);
  await mkdir(dirname(database), { recursive: true });
  const estimatedBytes = estimateDatasetSqliteBytes(snapshot);
  const freeBytes = await availableBytes(dirname(database));
  return {
    database,
    estimatedBytes,
    availableBytes: freeBytes,
    enoughSpace: freeBytes >= estimatedBytes,
  };
}

function assertEnoughSqliteSpace(plan: DatasetSqlitePlan): void {
  if (!plan.enoughSpace) {
    throw new Error(
      `Insufficient disk space for SQLite: ${plan.estimatedBytes} bytes estimated, ` +
      `${plan.availableBytes} bytes available`,
    );
  }
}

async function readRows<T>(
  datasetDirectory: string,
  tableName: string,
  table: DatasetTable,
  convert: (value: unknown) => T,
  readParquetFile: (path: string) => Promise<readonly unknown[]>,
  onProgress?: (message: string) => void,
): Promise<T[]> {
  const rows: T[] = [];
  for (const manifest of table.manifests) {
    for (const entry of manifest.files) {
      const path = resolve(datasetDirectory, ...entry.publicPath.split("/"));
      const expectedPrefix = `data/${tableName}/`;
      if (!entry.publicPath.startsWith(expectedPrefix) || !path.startsWith(`${datasetDirectory}${sep}`)) {
        throw new Error(`${entry.publicPath} is not a safe ${tableName} dataset path`);
      }
      const parquetRows = await readParquetFile(path);
      rows.push(...parquetRows.map((row) => convert(row)));
      onProgress?.(`Read ${entry.publicPath}`);
    }
  }
  if (rows.length !== table.rows) {
    throw new Error(`${tableName} row count mismatch: snapshot declares ${table.rows}, Parquet contains ${rows.length}`);
  }
  return rows;
}

async function readParquetFile(path: string): Promise<readonly unknown[]> {
  const [{ asyncBufferFromFile, parquetReadObjects }, { compressors }] = await Promise.all([
    import("hyparquet/src/node.js"),
    import("hyparquet-compressors"),
  ]);
  const file = await asyncBufferFromFile(path);
  return parquetReadObjects({ file, compressors });
}

async function removeSqliteFiles(path: string): Promise<void> {
  await Promise.all([path, `${path}-shm`, `${path}-wal`].map((candidate) => unlink(candidate).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  })));
}

export async function materializeCongressionalDatasetSqlite(
  options: MaterializeCongressionalDatasetSqliteOptions,
): Promise<MaterializedCongressionalDatasetSqlite> {
  for (const name of REQUIRED_TABLES) requiredTable(options.snapshot, name);
  const datasetDirectory = resolve(options.datasetDirectory);
  const database = resolve(options.databasePath);
  const parquetReader = options.readParquetFile ?? readParquetFile;
  const sqlitePlan = await datasetSqlitePlan(database, options.snapshot);
  options.onPlan?.(sqlitePlan);
  assertEnoughSqliteSpace(sqlitePlan);

  const lake: PoliticalLakeSnapshot = {
    filings: await readRows(
      datasetDirectory,
      "political_filings",
      requiredTable(options.snapshot, "political_filings"),
      filingRow,
      parquetReader,
      options.onProgress,
    ),
    trades: await readRows(
      datasetDirectory,
      "political_trades",
      requiredTable(options.snapshot, "political_trades"),
      tradeRow,
      parquetReader,
      options.onProgress,
    ),
    events: await readRows(
      datasetDirectory,
      "political_trade_events",
      requiredTable(options.snapshot, "political_trade_events"),
      eventRow,
      parquetReader,
      options.onProgress,
    ),
  };

  const partial = `${database}.partial-${randomUUID()}`;
  await removeSqliteFiles(partial);
  const repository = new SQLitePoliticalRepository(partial);
  try {
    await repository.replaceSnapshot(lake);
    const counts = await repository.counts();
    if (counts.filings !== lake.filings.length || counts.trades !== lake.trades.length || counts.events !== lake.events.length) {
      throw new Error(`SQLite row count mismatch after import: ${JSON.stringify(counts)}`);
    }
  } catch (error) {
    await repository.close().catch(() => undefined);
    await removeSqliteFiles(partial);
    throw error;
  }
  await repository.close();

  await rename(partial, database);
  await removeSqliteFiles(partial);
  options.onProgress?.(`Created ${database}`);
  const databaseBytes = (await stat(database)).size;
  return {
    database,
    databaseBytes,
    filings: lake.filings.length,
    trades: lake.trades.length,
    events: lake.events.length,
  };
}
