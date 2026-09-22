import {
  identifyPoliticalRows,
  type IdentifiedFilingRow,
  type IdentifiedFilingRows,
  type IdentifiedTradeRow,
} from "../identity/apply";
import type { MemberResolver } from "../identity/resolve";
import type { FilerIdentity } from "../identity/types";
import { buildPoliticalTradeEvents } from "../lake/events";
import type {
  PoliticalFilingRow,
  PoliticalLakeSnapshot,
  PoliticalTradeEventRow,
} from "../lake/types";
import {
  POLITICAL_FILINGS_PREFIX,
  POLITICAL_TRADE_EVENTS_PREFIX,
  POLITICAL_TRADES_PREFIX,
} from "../lake/types";
import type { PoliticalRepository } from "./repository";

/**
 * Physical Parquet/manifest operations. NexusTrade supplies its proven DuckDB and
 * Tigris implementation; other callers can implement this against any S3-compatible store.
 */
export interface ParquetLakePort {
  publishedYears(prefix: string): Promise<number[]>;
  readFilings(year: number): Promise<IdentifiedFilingRow[]>;
  readTrades(year: number): Promise<IdentifiedTradeRow[]>;
  readEvents(year: number): Promise<PoliticalTradeEventRow[]>;
  publishFilings(year: number, rows: readonly IdentifiedFilingRow[], runId: string): Promise<void>;
  publishTrades(year: number, rows: readonly IdentifiedTradeRow[], runId: string): Promise<void>;
  publishEvents(year: number, rows: readonly PoliticalTradeEventRow[], runId: string): Promise<void>;
  recordRun?(run: { runId: string; startedAt: Date; finishedAt: Date; status: "ok" | "failed"; detail: string }): Promise<void>;
  close?(): Promise<void>;
}

function filingKey(row: Pick<PoliticalFilingRow, "chamber" | "docId">): string {
  return `${row.chamber}:${row.docId}`;
}

function yearOf(row: Pick<PoliticalFilingRow, "availableAt">): number {
  return row.availableAt.getUTCFullYear();
}

function sameIdentity(left: FilerIdentity, right: FilerIdentity | undefined): boolean {
  return right !== undefined && left.filerKey === right.filerKey && left.memberId === right.memberId &&
    left.displayName === right.displayName && left.identitySource === right.identitySource;
}

/** Production repository preserving NexusTrade's yearly manifest-published lake behavior. */
export class ManifestParquetPoliticalRepository implements PoliticalRepository {
  constructor(private readonly port: ParquetLakePort) {}

  async snapshot(): Promise<PoliticalLakeSnapshot> {
    const [filingYears, tradeYears, eventYears] = await Promise.all([
      this.port.publishedYears(POLITICAL_FILINGS_PREFIX),
      this.port.publishedYears(POLITICAL_TRADES_PREFIX),
      this.port.publishedYears(POLITICAL_TRADE_EVENTS_PREFIX),
    ]);
    const [filings, trades, events] = await Promise.all([
      Promise.all(filingYears.map((year) => this.port.readFilings(year))),
      Promise.all(tradeYears.map((year) => this.port.readTrades(year))),
      Promise.all(eventYears.map((year) => this.port.readEvents(year))),
    ]);
    return { filings: filings.flat(), trades: trades.flat(), events: events.flat() };
  }

  async replaceFilings(updates: readonly IdentifiedFilingRows[], runId: string): Promise<void> {
    if (updates.length === 0) return;
    const snapshot = await this.snapshot();
    const replaced = new Set(updates.map((update) => filingKey(update.filing)));
    const filings = [...snapshot.filings.filter((row) => !replaced.has(filingKey(row))), ...updates.map((update) => update.filing)];
    const trades = [...snapshot.trades.filter((row) => !replaced.has(filingKey(row))), ...updates.flatMap((update) => update.trades)];
    await this.publish(snapshot, filings, trades, new Set(updates.map((update) => yearOf(update.filing))), runId);
  }

  async reidentify(resolver: MemberResolver): Promise<number> {
    const snapshot = await this.snapshot();
    const identified = identifyPoliticalRows(snapshot.filings, snapshot.trades, resolver);
    const moved = identified.filings.filter((filing, index) => !sameIdentity(filing, snapshot.filings[index]));
    const movedTrades = identified.trades.filter((trade, index) => !sameIdentity(trade, snapshot.trades[index]));
    if (moved.length === 0 && movedTrades.length === 0) return 0;
    const years = new Set([...moved, ...movedTrades].map((row) => row.availableAt.getUTCFullYear()));
    await this.publish(snapshot, identified.filings, identified.trades, years, `reidentify-${resolver.legislatorsCommit}`);
    return moved.length;
  }

  private async publish(
    snapshot: PoliticalLakeSnapshot,
    filings: readonly IdentifiedFilingRow[],
    trades: readonly IdentifiedTradeRow[],
    affectedYears: ReadonlySet<number>,
    runId: string,
  ): Promise<void> {
    for (const year of [...affectedYears].sort()) {
      await this.port.publishFilings(year, filings.filter((row) => yearOf(row) === year), runId);
      await this.port.publishTrades(year, trades.filter((row) => row.availableAt.getUTCFullYear() === year), runId);
    }
    const events = buildPoliticalTradeEvents(trades, filings);
    const eventYears = new Set([...snapshot.events.map((row) => row.availableAt.getUTCFullYear()), ...events.map((row) => row.availableAt.getUTCFullYear())]);
    for (const year of [...eventYears].sort()) {
      await this.port.publishEvents(year, events.filter((row) => row.availableAt.getUTCFullYear() === year), runId);
    }
  }

  async recordRun(run: { runId: string; startedAt: Date; finishedAt: Date; status: "ok" | "failed"; detail: string }): Promise<void> {
    await this.port.recordRun?.(run);
  }

  async close(): Promise<void> { await this.port.close?.(); }
}
