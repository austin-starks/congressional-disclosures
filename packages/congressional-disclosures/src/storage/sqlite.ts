import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { identifyPoliticalRows, type IdentifiedFilingRow, type IdentifiedFilingRows, type IdentifiedTradeRow } from "../identity/apply";
import type { MemberResolver } from "../identity/resolve";
import type { FilerIdentity, IdentitySource } from "../identity/types";
import { buildPoliticalTradeEvents } from "../lake/events";
import type {
  PoliticalFilingRow,
  PoliticalLakeSnapshot,
  PoliticalTradeEventRow,
  PoliticalTradeRow,
} from "../lake/types";
import type { PoliticalRepository } from "./repository";

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS political_filings (
  chamber TEXT NOT NULL, doc_id TEXT NOT NULL, filer_first TEXT NOT NULL, filer_last TEXT NOT NULL,
  filer_suffix TEXT, state_district TEXT, filing_date TEXT NOT NULL, available_at TEXT NOT NULL,
  availability_source TEXT NOT NULL, source_url TEXT NOT NULL, raw_archive_key TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
  parse_method TEXT NOT NULL, extraction_status TEXT NOT NULL, failure_reason TEXT, extracted_rows INTEGER NOT NULL,
  extraction_model TEXT, contract_version TEXT, ocr_archive_key TEXT, amended_report_date TEXT, report_date TEXT,
  processed_at TEXT NOT NULL, filer_key TEXT NOT NULL, member_id TEXT, display_name TEXT NOT NULL DEFAULT '',
  identity_source TEXT NOT NULL DEFAULT 'unresolved', PRIMARY KEY (chamber, doc_id)
);
CREATE TABLE IF NOT EXISTS political_trades (
  chamber TEXT NOT NULL, doc_id TEXT NOT NULL, row_index INTEGER NOT NULL, source_transaction_id TEXT,
  filer_first TEXT NOT NULL, filer_last TEXT NOT NULL, owner TEXT NOT NULL, owner_code_raw TEXT,
  action TEXT NOT NULL, partial_sale INTEGER NOT NULL, action_code_raw TEXT, transaction_date TEXT,
  notification_date TEXT, filing_date TEXT NOT NULL, available_at TEXT NOT NULL, availability_source TEXT NOT NULL,
  asset_description TEXT NOT NULL, printed_ticker TEXT, resolved_ticker TEXT, resolution_status TEXT NOT NULL,
  resolution_reason TEXT, asset_type_code TEXT, asset_type_label TEXT, amount_bracket TEXT NOT NULL,
  amount_low REAL, amount_high REAL, cap_gains_over_200 INTEGER, comment TEXT, filing_status TEXT,
  source_url TEXT NOT NULL, raw_archive_key TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
  filer_key TEXT NOT NULL, member_id TEXT, display_name TEXT NOT NULL DEFAULT '',
  identity_source TEXT NOT NULL DEFAULT 'unresolved',
  PRIMARY KEY (chamber, doc_id, row_index),
  FOREIGN KEY (chamber, doc_id) REFERENCES political_filings(chamber, doc_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS political_trade_events (
  event_id TEXT NOT NULL, version INTEGER NOT NULL, chamber TEXT NOT NULL, filer_first TEXT NOT NULL,
  filer_last TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, partial_sale INTEGER NOT NULL,
  transaction_date TEXT, ticker TEXT, source_transaction_id TEXT, asset_description TEXT NOT NULL,
  asset_type_code TEXT, asset_type_label TEXT, amount_low REAL, amount_high REAL,
  first_available_at TEXT NOT NULL, available_at TEXT NOT NULL, superseded_at TEXT,
  source_doc_id TEXT NOT NULL, source_row_index INTEGER NOT NULL, source_url TEXT NOT NULL,
  contributor_row_ids TEXT NOT NULL, filer_key TEXT NOT NULL, member_id TEXT, display_name TEXT NOT NULL DEFAULT '',
  identity_source TEXT NOT NULL DEFAULT 'unresolved', PRIMARY KEY (event_id, version)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_receipts (
  chamber TEXT NOT NULL, doc_id TEXT NOT NULL, run_id TEXT NOT NULL, committed_at TEXT NOT NULL,
  PRIMARY KEY (chamber, doc_id)
);
CREATE INDEX IF NOT EXISTS political_filings_date_idx ON political_filings(filing_date);
CREATE INDEX IF NOT EXISTS political_filings_filer_idx ON political_filings(filer_last, filer_first);
CREATE INDEX IF NOT EXISTS political_filings_filer_key_idx ON political_filings(filer_key);
CREATE INDEX IF NOT EXISTS political_trades_ticker_idx ON political_trades(printed_ticker, resolved_ticker, available_at);
CREATE INDEX IF NOT EXISTS political_trades_transaction_date_idx ON political_trades(transaction_date);
CREATE INDEX IF NOT EXISTS political_trades_filer_key_idx ON political_trades(filer_key);
CREATE INDEX IF NOT EXISTS political_events_ticker_idx ON political_trade_events(ticker, available_at);
CREATE INDEX IF NOT EXISTS political_events_filer_key_idx ON political_trade_events(filer_key);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
`;

/** Identity columns, added in place to a database created before 2.0; `reidentify` then fills them. */
const IDENTITY_TABLES = ["political_filings", "political_trades", "political_trade_events"] as const;
const IDENTITY_COLUMN_DDL = [
  ["member_id", "TEXT"],
  ["display_name", "TEXT NOT NULL DEFAULT ''"],
  ["identity_source", "TEXT NOT NULL DEFAULT 'unresolved'"],
] as const;
const IDENTITY_INDEXES = `
CREATE INDEX IF NOT EXISTS political_filings_member_idx ON political_filings(member_id);
CREATE INDEX IF NOT EXISTS political_trades_member_idx ON political_trades(member_id);
CREATE INDEX IF NOT EXISTS political_events_member_idx ON political_trade_events(member_id);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
`;

const IDENTITY = "filer_key, member_id, display_name, identity_source";
const FILING_COLUMNS = `chamber, doc_id, filer_first, filer_last, filer_suffix, state_district, filing_date, available_at, availability_source, source_url, raw_archive_key, raw_sha256, parse_method, extraction_status, failure_reason, extracted_rows, extraction_model, contract_version, ocr_archive_key, amended_report_date, report_date, processed_at, ${IDENTITY}`;
const TRADE_COLUMNS = `chamber, doc_id, row_index, source_transaction_id, filer_first, filer_last, owner, owner_code_raw, action, partial_sale, action_code_raw, transaction_date, notification_date, filing_date, available_at, availability_source, asset_description, printed_ticker, resolved_ticker, resolution_status, resolution_reason, asset_type_code, asset_type_label, amount_bracket, amount_low, amount_high, cap_gains_over_200, comment, filing_status, source_url, raw_archive_key, raw_sha256, ${IDENTITY}`;
const EVENT_COLUMNS = `event_id, version, chamber, filer_first, filer_last, owner, action, partial_sale, transaction_date, ticker, source_transaction_id, asset_description, asset_type_code, asset_type_label, amount_low, amount_high, first_available_at, available_at, superseded_at, source_doc_id, source_row_index, source_url, contributor_row_ids, ${IDENTITY}`;

function iso(value: Date): string { return value.toISOString(); }
function date(value: unknown): Date { return new Date(String(value)); }
function textOrNull(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function numberOrNull(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
function booleanOrNull(value: unknown): boolean | null { return value === null || value === undefined ? null : Boolean(value); }
function rowObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("SQLite returned a non-object row");
  return value as Record<string, unknown>;
}

function identityFromDb(row: Record<string, unknown>): FilerIdentity {
  return {
    filerKey: String(row.filer_key), memberId: textOrNull(row.member_id), displayName: String(row.display_name),
    identitySource: String(row.identity_source) as IdentitySource,
  };
}

function identityValues(row: FilerIdentity): SQLInputValue[] {
  return [row.filerKey, row.memberId, row.displayName, row.identitySource];
}

function sameIdentity(left: FilerIdentity, right: FilerIdentity): boolean {
  return left.filerKey === right.filerKey && left.memberId === right.memberId &&
    left.displayName === right.displayName && left.identitySource === right.identitySource;
}

function filingFromDb(raw: unknown): IdentifiedFilingRow {
  const row = rowObject(raw);
  return {
    ...identityFromDb(row),
    chamber: String(row.chamber) as PoliticalFilingRow["chamber"], docId: String(row.doc_id),
    filerFirst: String(row.filer_first), filerLast: String(row.filer_last), filerSuffix: textOrNull(row.filer_suffix),
    stateDistrict: textOrNull(row.state_district), filingDate: String(row.filing_date), availableAt: date(row.available_at),
    availabilitySource: String(row.availability_source), sourceUrl: String(row.source_url),
    rawArchiveKey: String(row.raw_archive_key), rawSha256: String(row.raw_sha256),
    parseMethod: String(row.parse_method) as PoliticalFilingRow["parseMethod"],
    extractionStatus: String(row.extraction_status) as PoliticalFilingRow["extractionStatus"],
    failureReason: textOrNull(row.failure_reason), extractedRows: Number(row.extracted_rows),
    extractionModel: textOrNull(row.extraction_model), contractVersion: textOrNull(row.contract_version),
    ocrArchiveKey: textOrNull(row.ocr_archive_key), amendedReportDate: textOrNull(row.amended_report_date),
    reportDate: textOrNull(row.report_date), processedAt: date(row.processed_at),
  };
}

function tradeFromDb(raw: unknown): IdentifiedTradeRow {
  const row = rowObject(raw);
  return {
    ...identityFromDb(row),
    chamber: String(row.chamber) as PoliticalTradeRow["chamber"], docId: String(row.doc_id), rowIndex: Number(row.row_index),
    sourceTransactionId: textOrNull(row.source_transaction_id), filerFirst: String(row.filer_first), filerLast: String(row.filer_last),
    owner: String(row.owner) as PoliticalTradeRow["owner"], ownerCodeRaw: textOrNull(row.owner_code_raw),
    action: String(row.action) as PoliticalTradeRow["action"], partialSale: Boolean(row.partial_sale),
    actionCodeRaw: textOrNull(row.action_code_raw), transactionDate: textOrNull(row.transaction_date),
    notificationDate: textOrNull(row.notification_date), filingDate: String(row.filing_date), availableAt: date(row.available_at),
    availabilitySource: String(row.availability_source), assetDescription: String(row.asset_description),
    printedTicker: textOrNull(row.printed_ticker), resolvedTicker: textOrNull(row.resolved_ticker),
    resolutionStatus: String(row.resolution_status) as PoliticalTradeRow["resolutionStatus"],
    resolutionReason: textOrNull(row.resolution_reason), assetTypeCode: textOrNull(row.asset_type_code),
    assetTypeLabel: textOrNull(row.asset_type_label), amountBracket: String(row.amount_bracket),
    amountLow: numberOrNull(row.amount_low), amountHigh: numberOrNull(row.amount_high),
    capGainsOver200: booleanOrNull(row.cap_gains_over_200), comment: textOrNull(row.comment),
    filingStatus: textOrNull(row.filing_status), sourceUrl: String(row.source_url),
    rawArchiveKey: String(row.raw_archive_key), rawSha256: String(row.raw_sha256),
  };
}

function eventFromDb(raw: unknown): PoliticalTradeEventRow {
  const row = rowObject(raw);
  return {
    ...identityFromDb(row),
    eventId: String(row.event_id), version: Number(row.version), chamber: String(row.chamber) as PoliticalTradeEventRow["chamber"],
    filerFirst: String(row.filer_first), filerLast: String(row.filer_last), owner: String(row.owner) as PoliticalTradeEventRow["owner"],
    action: String(row.action) as PoliticalTradeEventRow["action"], partialSale: Boolean(row.partial_sale),
    transactionDate: textOrNull(row.transaction_date), ticker: textOrNull(row.ticker),
    sourceTransactionId: textOrNull(row.source_transaction_id), assetDescription: String(row.asset_description),
    assetTypeCode: textOrNull(row.asset_type_code), assetTypeLabel: textOrNull(row.asset_type_label),
    amountLow: numberOrNull(row.amount_low), amountHigh: numberOrNull(row.amount_high), firstAvailableAt: date(row.first_available_at),
    availableAt: date(row.available_at), supersededAt: row.superseded_at === null ? null : date(row.superseded_at),
    sourceDocId: String(row.source_doc_id), sourceRowIndex: Number(row.source_row_index), sourceUrl: String(row.source_url),
    contributorRowIds: String(row.contributor_row_ids),
  };
}

function filingValues(row: IdentifiedFilingRow): SQLInputValue[] {
  return [row.chamber, row.docId, row.filerFirst, row.filerLast, row.filerSuffix, row.stateDistrict, row.filingDate,
    iso(row.availableAt), row.availabilitySource, row.sourceUrl, row.rawArchiveKey, row.rawSha256, row.parseMethod,
    row.extractionStatus, row.failureReason, row.extractedRows, row.extractionModel, row.contractVersion,
    row.ocrArchiveKey, row.amendedReportDate, row.reportDate, iso(row.processedAt), ...identityValues(row)];
}

function tradeValues(row: IdentifiedTradeRow): SQLInputValue[] {
  return [row.chamber, row.docId, row.rowIndex, row.sourceTransactionId, row.filerFirst, row.filerLast, row.owner,
    row.ownerCodeRaw, row.action, Number(row.partialSale), row.actionCodeRaw, row.transactionDate, row.notificationDate,
    row.filingDate, iso(row.availableAt), row.availabilitySource, row.assetDescription, row.printedTicker,
    row.resolvedTicker, row.resolutionStatus, row.resolutionReason, row.assetTypeCode, row.assetTypeLabel,
    row.amountBracket, row.amountLow, row.amountHigh, row.capGainsOver200 === null ? null : Number(row.capGainsOver200),
    row.comment, row.filingStatus, row.sourceUrl, row.rawArchiveKey, row.rawSha256, ...identityValues(row)];
}

function eventValues(row: PoliticalTradeEventRow): SQLInputValue[] {
  return [row.eventId, row.version, row.chamber, row.filerFirst, row.filerLast, row.owner, row.action,
    Number(row.partialSale), row.transactionDate, row.ticker, row.sourceTransactionId, row.assetDescription,
    row.assetTypeCode, row.assetTypeLabel, row.amountLow, row.amountHigh, iso(row.firstAvailableAt), iso(row.availableAt),
    row.supersededAt ? iso(row.supersededAt) : null, row.sourceDocId, row.sourceRowIndex, row.sourceUrl, row.contributorRowIds,
    ...identityValues(row)];
}

function placeholders(count: number): string {
  return `(${Array(count).fill("?").join(",")})`;
}

export class SQLitePoliticalRepository implements PoliticalRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
    this.db.exec(SCHEMA);
    for (const table of IDENTITY_TABLES) {
      const present = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(rowObject(column).name)));
      for (const [name, ddl] of IDENTITY_COLUMN_DDL) {
        if (!present.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      }
    }
    this.db.exec(IDENTITY_INDEXES);
  }

  async snapshot(): Promise<PoliticalLakeSnapshot> {
    return {
      filings: this.db.prepare("SELECT * FROM political_filings").all().map(filingFromDb),
      trades: this.db.prepare("SELECT * FROM political_trades").all().map(tradeFromDb),
      events: this.db.prepare("SELECT * FROM political_trade_events").all().map(eventFromDb),
    };
  }

  async counts(): Promise<{ filings: number; trades: number; events: number; failedFilings: number; members: number; unresolvedFilings: number }> {
    const count = (table: string): number => {
      const row = rowObject(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
      return Number(row.count);
    };
    return {
      filings: count("political_filings"),
      trades: count("political_trades"),
      events: count("political_trade_events"),
      failedFilings: Number(rowObject(this.db.prepare(
        "SELECT COUNT(*) AS count FROM political_filings WHERE extraction_status = 'failed'",
      ).get()).count),
      members: Number(rowObject(this.db.prepare(
        "SELECT COUNT(DISTINCT member_id) AS count FROM political_filings WHERE member_id IS NOT NULL",
      ).get()).count),
      unresolvedFilings: Number(rowObject(this.db.prepare(
        "SELECT COUNT(*) AS count FROM political_filings WHERE identity_source = 'unresolved'",
      ).get()).count),
    };
  }

  async replaceSnapshot(snapshot: PoliticalLakeSnapshot): Promise<void> {
    const insertFiling = this.db.prepare(`INSERT INTO political_filings (${FILING_COLUMNS}) VALUES ${placeholders(26)}`);
    const insertTrade = this.db.prepare(`INSERT INTO political_trades (${TRADE_COLUMNS}) VALUES ${placeholders(36)}`);
    const insertEvent = this.db.prepare(`INSERT INTO political_trade_events (${EVENT_COLUMNS}) VALUES ${placeholders(27)}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM political_trade_events; DELETE FROM political_trades; DELETE FROM political_filings;");
      for (const filing of snapshot.filings) insertFiling.run(...filingValues(filing));
      for (const trade of snapshot.trades) insertTrade.run(...tradeValues(trade));
      for (const event of snapshot.events) insertEvent.run(...eventValues(event));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async replaceFilings(updates: readonly IdentifiedFilingRows[], runId: string): Promise<void> {
    if (updates.length === 0) return;
    const insertFiling = this.db.prepare(`INSERT INTO political_filings (${FILING_COLUMNS}) VALUES ${placeholders(26)}`);
    const insertTrade = this.db.prepare(`INSERT INTO political_trades (${TRADE_COLUMNS}) VALUES ${placeholders(36)}`);
    const insertEvent = this.db.prepare(`INSERT INTO political_trade_events (${EVENT_COLUMNS}) VALUES ${placeholders(27)}`);
    const deleteFiling = this.db.prepare("DELETE FROM political_filings WHERE chamber = ? AND doc_id = ?");
    const previousKey = this.db.prepare("SELECT filer_key FROM political_filings WHERE chamber = ? AND doc_id = ?");
    const deleteEvents = this.db.prepare("DELETE FROM political_trade_events WHERE filer_key = ?");
    const selectFilerFilings = this.db.prepare("SELECT * FROM political_filings WHERE filer_key = ?");
    const selectFilerTrades = this.db.prepare("SELECT * FROM political_trades WHERE filer_key = ?");
    const receipt = this.db.prepare("INSERT OR REPLACE INTO sync_receipts VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A re-extracted filing can change filer; both the old and the new filer's events are rebuilt.
      const touched = new Set(updates.map((update) => update.filing.filerKey));
      for (const update of updates) {
        const previous = previousKey.get(update.filing.chamber, update.filing.docId);
        if (previous) touched.add(String(rowObject(previous).filer_key));
        deleteFiling.run(update.filing.chamber, update.filing.docId);
        insertFiling.run(...filingValues(update.filing));
        for (const trade of update.trades) insertTrade.run(...tradeValues(trade));
        receipt.run(update.filing.chamber, update.filing.docId, runId, new Date().toISOString());
      }
      // Events never cross filers, so rebuilding only the touched filers' events
      // from their full trade history is identical to a whole-lake rebuild.
      for (const filerKey of touched) {
        deleteEvents.run(filerKey);
        const filings = selectFilerFilings.all(filerKey).map(filingFromDb);
        const trades = selectFilerTrades.all(filerKey).map(tradeFromDb);
        for (const event of buildPoliticalTradeEvents(trades, filings)) insertEvent.run(...eventValues(event));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Re-derive every row's identity (after the member data or the overrides change, or on
   * a database created before 2.0) and rebuild all events when any identity moved.
   * Returns how many filings changed identity.
   */
  async reidentify(resolver: MemberResolver): Promise<number> {
    const current = await this.snapshot();
    const identified = identifyPoliticalRows(current.filings, current.trades, resolver);
    const changed = identified.filings.filter((filing, index) => {
      const stored = current.filings[index];
      return stored === undefined || !sameIdentity(filing, stored);
    }).length;
    const tradesChanged = identified.trades.some((trade, index) => {
      const stored = current.trades[index];
      return stored === undefined || !sameIdentity(trade, stored);
    });
    if (changed === 0 && !tradesChanged) return 0;
    await this.replaceSnapshot({
      filings: identified.filings,
      trades: identified.trades,
      events: buildPoliticalTradeEvents(identified.trades, identified.filings),
    });
    return changed;
  }

  async recordRun(run: { runId: string; startedAt: Date; finishedAt: Date; status: "ok" | "failed"; detail: string }): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO sync_runs VALUES (?, ?, ?, ?, ?)").run(
      run.runId, iso(run.startedAt), iso(run.finishedAt), run.status, run.detail
    );
  }

  async close(): Promise<void> {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.close();
  }
}
