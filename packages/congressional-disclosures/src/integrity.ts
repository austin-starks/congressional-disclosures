/**
 * Pure integrity checks over published disclosure lake rows.
 *
 * Nothing here talks to S3 or Mongo: a test builds the rows that failed in
 * production, and the refresh pass plus a read-only audit script supply live
 * ones. Row types are structural minimums — any richer table row carrying the
 * checked fields is assignable.
 */

export const DISCLOSURE_CHAMBERS = ["house", "senate"] as const;
export type DisclosureChamber = (typeof DISCLOSURE_CHAMBERS)[number];

export const LAKE_EXTRACTION_STATUSES = ["ok", "failed", "unsupported"] as const;
export type LakeExtractionStatus = (typeof LAKE_EXTRACTION_STATUSES)[number];

export const LAKE_RESOLUTION_STATUSES = [
  "printed",
  "resolved",
  "not_public_equity",
  "unresolved",
] as const;
export type LakeResolutionStatus = (typeof LAKE_RESOLUTION_STATUSES)[number];

/** One `political_filings` row, including failed filings (completeness is a query). */
export interface LakeFiling {
  chamber: DisclosureChamber;
  docId: string;
  filingDate: string;
  extractionStatus: LakeExtractionStatus;
  /** Identity columns (2.0+). Absent skips the identity checks. */
  filerKey?: string;
  memberId?: string | null;
  identitySource?: string;
}

/** One `political_trades` row: a printed transaction of an `ok` filing. */
export interface LakeTrade {
  chamber: DisclosureChamber;
  docId: string;
  rowIndex: number;
  filingDate: string;
  transactionDate: string | null;
  notificationDate: string | null;
  amountLow: number | null;
  amountHigh: number | null;
  resolutionStatus: LakeResolutionStatus;
  resolvedTicker: string | null;
}

/** One `political_trade_events` row. */
export interface LakeTradeEvent {
  eventId: string;
  chamber: DisclosureChamber;
  sourceDocId: string;
  identitySource?: string;
  /** JSON array of `"docId:rowIndex"` observations, in availability order. */
  contributorRowIds: string;
}

/** A House index PTR or Senate report the lake must contain. */
export interface IndexedDisclosure {
  chamber: DisclosureChamber;
  docId: string;
}

export const POLITICAL_INTEGRITY_EARLIEST_DATE = "1789-01-01";
/** The Clerk index regenerates in batches; alert when the newest filing is older than this. */
export const POLITICAL_INTEGRITY_FRESHNESS_DAYS = 4;
const CONTRIBUTOR_ROW_ID = /^([^:]+):(\d+)$/;
const YEAR_ALL_SHARD = /^(.+)\/(\d{4})-all\.parquet$/;
const EXAMPLE_CAP = 20;

export type PoliticalIntegrityCheck =
  | "index_completeness"
  | "publication_parity"
  | "orphan_trades"
  | "orphan_event_sources"
  | "invalid_contributor_row_ids"
  | "dated_after_filing"
  | "date_out_of_range"
  | "invalid_amount_range"
  | "duplicate_trade_key"
  | "resolved_without_ticker"
  | "extraction_health"
  | "freshness"
  | "manifest_health"
  | "member_split"
  | "unresolved_filers"
  | "non_member_events"
  | "stale_overrides";

export interface PoliticalIntegrityFinding {
  check: PoliticalIntegrityCheck;
  severity: "fail" | "info";
  message: string;
  count: number;
  examples: string[];
}

export interface PoliticalIntegrityReceipt {
  chamber: DisclosureChamber;
  docId: string;
}

export interface PoliticalIntegrityInput {
  now: Date;
  filings: readonly LakeFiling[];
  trades: readonly LakeTrade[];
  events: readonly LakeTradeEvent[];
  /** House index PTRs and Senate reports the lake must contain. Empty skips index completeness. */
  indexed?: readonly IndexedDisclosure[];
  /** A backfill round's receipts. Absent skips publication parity. */
  receipts?: readonly PoliticalIntegrityReceipt[];
  /** Per-prefix year → shard keys already resolved through the manifest, never a glob. */
  shardKeys?: Readonly<Record<string, Readonly<Record<number, readonly string[]>>>>;
  /** Previous pass's failed/total per filing-date year; a rise is a regression. */
  previousFailedShareByYear?: Readonly<Record<number, number>>;
  /**
   * How many `transactionDate > filingDate` rows may exist before the check fails.
   * Filer-error filings stay a failure until a publish policy says otherwise; a
   * later cap turns this into a count, not a discard of the whole filing.
   */
  datedAfterFilingCap?: number;
  /** Reviewed member overrides their own proving filing no longer matches (`MemberResolver.staleOverrides`); any is a failure. */
  staleOverrides?: readonly string[];
}

export interface PoliticalIntegrityReport {
  passed: boolean;
  findings: PoliticalIntegrityFinding[];
  failedShareByYear: Record<number, number>;
}

export interface PreviousPoliticalIntegrity {
  failed: boolean;
  failedShareByYear: Record<number, number>;
}

function filingKey(chamber: DisclosureChamber, docId: string): string {
  return `${chamber}:${docId}`;
}

function tradeKey(docId: string, rowIndex: number): string {
  return `${docId}:${rowIndex}`;
}

function utcYmd(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function utcDatePlusDays(now: Date, days: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  return utcYmd(date);
}

function utcDayDiff(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000);
}

function finding(
  check: PoliticalIntegrityCheck,
  examples: readonly string[],
  message: string,
  severity: PoliticalIntegrityFinding["severity"] = "fail"
): PoliticalIntegrityFinding {
  return {
    check,
    severity,
    message,
    count: examples.length,
    examples: examples.slice(0, EXAMPLE_CAP),
  };
}

function okFilings(filings: readonly LakeFiling[]): Map<string, LakeFiling> {
  return new Map(
    filings.filter((row) => row.extractionStatus === "ok").map((row) => [filingKey(row.chamber, row.docId), row])
  );
}

function allFilings(filings: readonly LakeFiling[]): Map<string, LakeFiling> {
  return new Map(filings.map((row) => [filingKey(row.chamber, row.docId), row]));
}

function tradeIndex(trades: readonly LakeTrade[]): Map<string, LakeTrade> {
  return new Map(trades.map((row) => [tradeKey(row.docId, row.rowIndex), row]));
}

/** Index identities with no published filing row. */
export function missingIndexedFilings(
  indexed: readonly IndexedDisclosure[],
  filings: readonly LakeFiling[]
): string[] {
  const published = allFilings(filings);
  return indexed
    .filter((entry) => !published.has(filingKey(entry.chamber, entry.docId)))
    .map((entry) => filingKey(entry.chamber, entry.docId))
    .sort();
}

/** Receipts a reduce did not publish, and published rows a full-round reduce left without a receipt. */
export function publicationParityGaps(
  receipts: readonly PoliticalIntegrityReceipt[],
  filings: readonly LakeFiling[]
): { missingFromFilings: string[]; missingFromReceipts: string[] } {
  const receiptKeys = new Set(receipts.map((receipt) => filingKey(receipt.chamber, receipt.docId)));
  const filingKeys = new Set(filings.map((row) => filingKey(row.chamber, row.docId)));
  return {
    missingFromFilings: [...receiptKeys].filter((key) => !filingKeys.has(key)).sort(),
    missingFromReceipts: [...filingKeys].filter((key) => !receiptKeys.has(key)).sort(),
  };
}

/** Trades whose filing is missing or not `ok`. */
export function orphanTrades(trades: readonly LakeTrade[], filings: readonly LakeFiling[]): string[] {
  const ok = okFilings(filings);
  return trades
    .filter((row) => !ok.has(filingKey(row.chamber, row.docId)))
    .map((row) => `${filingKey(row.chamber, row.docId)}#${row.rowIndex}`)
    .sort();
}

/** Events whose `sourceDocId` is not an `ok` filing. */
export function orphanEventSources(
  events: readonly LakeTradeEvent[],
  filings: readonly LakeFiling[]
): string[] {
  const ok = okFilings(filings);
  return events
    .filter((row) => !ok.has(filingKey(row.chamber, row.sourceDocId)))
    .map((row) => `${row.eventId} source=${filingKey(row.chamber, row.sourceDocId)}`)
    .sort();
}

function parseContributorRowIds(raw: string): string[] | { error: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { error: "not an array" };
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string" || !CONTRIBUTOR_ROW_ID.test(entry)) {
        return { error: `invalid ${JSON.stringify(entry)}` };
      }
      ids.push(entry);
    }
    return ids;
  } catch {
    return { error: "not JSON" };
  }
}

/** `contributorRowIds` entries that do not parse as `docId:rowIndex` or do not exist as trades. */
export function invalidContributorRowIds(
  events: readonly LakeTradeEvent[],
  trades: readonly LakeTrade[]
): string[] {
  const known = tradeIndex(trades);
  const broken: string[] = [];
  for (const event of events) {
    const parsed = parseContributorRowIds(event.contributorRowIds);
    if ("error" in parsed) {
      broken.push(`${event.eventId}: ${parsed.error}`);
      continue;
    }
    for (const id of parsed) {
      if (!known.has(id)) broken.push(`${event.eventId}: missing trade ${id}`);
    }
  }
  return broken.sort();
}

/** Transactions dated after their filing date. */
export function tradesDatedAfterFiling(trades: readonly LakeTrade[]): string[] {
  return trades
    .filter((row) => row.transactionDate !== null && row.transactionDate > row.filingDate)
    .map((row) => `${row.docId}#${row.rowIndex} ${row.transactionDate} > ${row.filingDate}`)
    .sort();
}

/** Dates before the Constitution or after tomorrow. */
export function tradesOutsideDateRange(trades: readonly LakeTrade[], now: Date): string[] {
  const latest = utcDatePlusDays(now, 1);
  const out: string[] = [];
  for (const row of trades) {
    for (const [field, value] of [
      ["transactionDate", row.transactionDate],
      ["notificationDate", row.notificationDate],
      ["filingDate", row.filingDate],
    ] as const) {
      if (value === null) continue;
      if (value < POLITICAL_INTEGRITY_EARLIEST_DATE || value > latest) {
        out.push(`${row.docId}#${row.rowIndex} ${field}=${value}`);
      }
    }
  }
  return out.sort();
}

export function invalidAmountRanges(trades: readonly LakeTrade[]): string[] {
  return trades
    .filter((row) => {
      if (row.amountLow !== null && row.amountLow < 0) return true;
      if (row.amountHigh !== null && row.amountHigh < 0) return true;
      return row.amountLow !== null && row.amountHigh !== null && row.amountLow > row.amountHigh;
    })
    .map((row) => `${row.docId}#${row.rowIndex} ${row.amountLow}..${row.amountHigh}`)
    .sort();
}

export function duplicateTradeKeys(trades: readonly LakeTrade[]): string[] {
  const seen = new Map<string, number>();
  for (const row of trades) {
    const key = `${row.chamber}:${tradeKey(row.docId, row.rowIndex)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => `${key} x${count}`)
    .sort();
}

export function resolvedWithoutTicker(trades: readonly LakeTrade[]): string[] {
  return trades
    .filter((row) => row.resolutionStatus === "resolved" && row.resolvedTicker === null)
    .map((row) => `${row.docId}#${row.rowIndex}`)
    .sort();
}

export function failedShareByFilingYear(filings: readonly LakeFiling[]): Record<number, number> {
  const totals = new Map<number, { failed: number; total: number }>();
  for (const row of filings) {
    const year = Number(row.filingDate.slice(0, 4));
    if (!Number.isInteger(year)) continue;
    const bucket = totals.get(year) ?? { failed: 0, total: 0 };
    bucket.total += 1;
    if (row.extractionStatus === "failed") bucket.failed += 1;
    totals.set(year, bucket);
  }
  return Object.fromEntries(
    [...totals.entries()]
      .sort(([left], [right]) => left - right)
      .map(([year, bucket]) => [year, bucket.total === 0 ? 0 : bucket.failed / bucket.total])
  );
}

/** Years whose failed share rose since the last pass. No previous pass means no threshold yet. */
export function extractionHealthRegressions(
  current: Readonly<Record<number, number>>,
  previous: Readonly<Record<number, number>> | undefined
): string[] {
  if (!previous) return [];
  return Object.entries(current)
    .filter(([year, share]) => {
      const prior = previous[Number(year)];
      return prior !== undefined && share > prior;
    })
    .map(([year, share]) => `${year}: ${(share * 100).toFixed(2)}% failed, was ${(previous[Number(year)] as number * 100).toFixed(2)}%`)
    .sort();
}

export function freshnessLagDays(filings: readonly LakeFiling[], now: Date): number | null {
  let newest: string | undefined;
  for (const row of filings) {
    if (!newest || row.filingDate > newest) newest = row.filingDate;
  }
  if (!newest) return null;
  return utcDayDiff(utcYmd(now), newest);
}

/** Years whose resolved keys are the frozen `{year}-all.parquet` fallback, or empty. */
export function unhealthyManifestYears(
  shardKeys: Readonly<Record<string, Readonly<Record<number, readonly string[]>>>>
): string[] {
  const broken: string[] = [];
  for (const [prefix, years] of Object.entries(shardKeys)) {
    for (const [year, keys] of Object.entries(years)) {
      if (keys.length === 0) {
        broken.push(`${prefix}/${year}: no shard keys`);
        continue;
      }
      for (const key of keys) {
        if (YEAR_ALL_SHARD.test(key)) broken.push(`${prefix}/${year}: reads ${key}`);
      }
    }
  }
  return broken.sort();
}

/** Members whose filings carry more than one filer key: the split identity exists to prevent. */
export function splitMembers(filings: readonly LakeFiling[]): string[] {
  const keys = new Map<string, Set<string>>();
  for (const filing of filings) {
    if (!filing.memberId || filing.filerKey === undefined) continue;
    keys.set(filing.memberId, (keys.get(filing.memberId) ?? new Set()).add(filing.filerKey));
  }
  return [...keys.entries()].filter(([, set]) => set.size > 1).map(([memberId, set]) => `${memberId} ${[...set].join(" | ")}`);
}

export function unresolvedFilers(filings: readonly LakeFiling[]): string[] {
  return filings
    .filter((filing) => filing.identitySource === "unresolved")
    .map((filing) => `${filingKey(filing.chamber, filing.docId)} ${filing.filerKey ?? ""}`.trim());
}

/** Events only exist for members; an event from any other filer is a build defect. */
export function nonMemberEvents(events: readonly LakeTradeEvent[]): string[] {
  return events
    .filter((event) => event.identitySource !== undefined && event.identitySource !== "legislators" && event.identitySource !== "override")
    .map((event) => event.eventId);
}

export function auditPoliticalIntegrity(input: PoliticalIntegrityInput): PoliticalIntegrityReport {
  const findings: PoliticalIntegrityFinding[] = [];

  const split = splitMembers(input.filings);
  if (split.length > 0) findings.push(finding("member_split", split, "members whose filings carry more than one filer key"));
  const unresolved = unresolvedFilers(input.filings);
  if (unresolved.length > 0) {
    findings.push(finding("unresolved_filers", unresolved, "filings no member of Congress matched; add a reviewed override", "info"));
  }
  const strayEvents = nonMemberEvents(input.events);
  if (strayEvents.length > 0) findings.push(finding("non_member_events", strayEvents, "events whose filer is not a member"));
  if (input.staleOverrides && input.staleOverrides.length > 0) {
    findings.push(finding("stale_overrides", [...input.staleOverrides], "member overrides their proving filing no longer matches"));
  }
  const failedShareByYear = failedShareByFilingYear(input.filings);

  if (input.indexed && input.indexed.length > 0) {
    const missing = missingIndexedFilings(input.indexed, input.filings);
    if (missing.length > 0) {
      findings.push(
        finding("index_completeness", missing, "indexed filings have no political_filings row")
      );
    }
  }

  if (input.receipts) {
    const gaps = publicationParityGaps(input.receipts, input.filings);
    // A receipt with no published row means the reduce did not finish the
    // round — that fails. A published row with no receipt in THIS round is
    // expected accumulation across rounds, so it reports as info, not failure.
    if (gaps.missingFromFilings.length > 0) {
      findings.push(
        finding(
          "publication_parity",
          gaps.missingFromFilings.map((key) => `receipt without row ${key}`),
          `receipts ${input.receipts.length} vs published filings ${input.filings.length}`
        )
      );
    }
    if (gaps.missingFromReceipts.length > 0) {
      findings.push(
        finding(
          "publication_parity",
          gaps.missingFromReceipts.map((key) => `row without receipt ${key}`),
          `published rows from earlier rounds (${gaps.missingFromReceipts.length})`,
          "info"
        )
      );
    }
  }

  const orphans = orphanTrades(input.trades, input.filings);
  if (orphans.length > 0) {
    findings.push(finding("orphan_trades", orphans, "trade rows whose filing is missing or not ok"));
  }

  const orphanSources = orphanEventSources(input.events, input.filings);
  if (orphanSources.length > 0) {
    findings.push(finding("orphan_event_sources", orphanSources, "events whose sourceDocId is not an ok filing"));
  }

  const contributors = invalidContributorRowIds(input.events, input.trades);
  if (contributors.length > 0) {
    findings.push(
      finding("invalid_contributor_row_ids", contributors, "contributorRowIds that do not parse or do not exist")
    );
  }

  const datedAfter = tradesDatedAfterFiling(input.trades);
  const datedAfterCap = input.datedAfterFilingCap ?? 0;
  if (datedAfter.length > datedAfterCap) {
    findings.push(
      finding(
        "dated_after_filing",
        datedAfter,
        `transactionDate after filingDate (${datedAfter.length}, cap ${datedAfterCap})`
      )
    );
  }

  const outOfRange = tradesOutsideDateRange(input.trades, input.now);
  if (outOfRange.length > 0) {
    findings.push(
      finding(
        "date_out_of_range",
        outOfRange,
        `dates outside ${POLITICAL_INTEGRITY_EARLIEST_DATE} .. ${utcDatePlusDays(input.now, 1)}`
      )
    );
  }

  const amounts = invalidAmountRanges(input.trades);
  if (amounts.length > 0) {
    findings.push(finding("invalid_amount_range", amounts, "amountLow > amountHigh or a negative bound"));
  }

  const duplicates = duplicateTradeKeys(input.trades);
  if (duplicates.length > 0) {
    findings.push(finding("duplicate_trade_key", duplicates, "duplicate (chamber, docId, rowIndex)"));
  }

  const unresolvedResolved = resolvedWithoutTicker(input.trades);
  if (unresolvedResolved.length > 0) {
    findings.push(
      finding("resolved_without_ticker", unresolvedResolved, "resolutionStatus=resolved with a null resolvedTicker")
    );
  }

  const regressions = extractionHealthRegressions(failedShareByYear, input.previousFailedShareByYear);
  if (regressions.length > 0) {
    findings.push(finding("extraction_health", regressions, "failed share rose for an index year"));
  }

  const lag = freshnessLagDays(input.filings, input.now);
  if (lag === null) {
    findings.push(finding("freshness", ["no filings"], "political_filings is empty"));
  } else if (lag >= POLITICAL_INTEGRITY_FRESHNESS_DAYS) {
    findings.push(
      finding("freshness", [`newest filingDate is ${lag} days behind ${utcYmd(input.now)}`], "newest filingDate is stale")
    );
  }

  if (input.shardKeys) {
    const broken = unhealthyManifestYears(input.shardKeys);
    if (broken.length > 0) {
      findings.push(
        finding("manifest_health", broken, "a published year has no manifest or still reads {year}-all.parquet")
      );
    }
  }

  return {
    passed: findings.every((item) => item.severity !== "fail"),
    findings,
    failedShareByYear,
  };
}

export function parsePreviousPoliticalIntegrity(lastRecord: string | null | undefined): PreviousPoliticalIntegrity {
  if (!lastRecord) return { failed: false, failedShareByYear: {} };
  try {
    const parsed: unknown = JSON.parse(lastRecord);
    if (!parsed || typeof parsed !== "object") return { failed: false, failedShareByYear: {} };
    const integrity = (parsed as { integrity?: unknown }).integrity;
    if (!integrity || typeof integrity !== "object") return { failed: false, failedShareByYear: {} };
    const record = integrity as { passed?: unknown; failedShareByYear?: unknown };
    const failedShareByYear: Record<number, number> = {};
    if (record.failedShareByYear && typeof record.failedShareByYear === "object") {
      for (const [year, share] of Object.entries(record.failedShareByYear as Record<string, unknown>)) {
        if (typeof share === "number" && Number.isFinite(share)) failedShareByYear[Number(year)] = share;
      }
    }
    return { failed: record.passed === false, failedShareByYear };
  } catch {
    return { failed: false, failedShareByYear: {} };
  }
}

export function shouldSendIntegrityRecovery(previousFailed: boolean, current: PoliticalIntegrityReport): boolean {
  return previousFailed && current.passed;
}

export function integrityHeadline(report: PoliticalIntegrityReport): string {
  const failing = report.findings.filter((item) => item.severity === "fail");
  return `${failing.length} political lake integrity check(s) failed`;
}

export function integrityAlertLines(report: PoliticalIntegrityReport): string[] {
  return report.findings
    .filter((item) => item.severity === "fail")
    .flatMap((item) => [`${item.check} (${item.count}): ${item.message}`, ...item.examples.map((line) => `  ${line}`)]);
}
