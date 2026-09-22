import type { IdentifiedFilingRow, IdentifiedTradeRow } from "../identity/apply";
import { MEMBER_IDENTITY_SOURCES } from "../identity/types";
import type { PoliticalTradeEventRow, PoliticalTradeRow } from "./types";

interface EventRoles {
  owner: string | null;
  action: string | null;
  partialSale: boolean | null;
  transactionDate: string | null;
  ticker: string | null;
  assetTypeCode: string | null;
  assetTypeLabel: string | null;
  amount: string | null;
}

const ROLE_KEYS: ReadonlyArray<keyof EventRoles> = [
  "owner", "action", "partialSale", "transactionDate", "ticker", "assetTypeCode", "assetTypeLabel", "amount",
];

interface OpenEvent {
  /** Creation order: every lookup returns the earliest qualifying event, as a full scan would. */
  seq: number;
  eventId: string;
  sourceTransactionId: string | null;
  firstAvailableAt: Date;
  versions: PoliticalTradeEventRow[];
  currentDocIds: Set<string>;
  allDocIds: Set<string>;
  roles: EventRoles;
  contributors: string[];
}

function eventTicker(row: PoliticalTradeRow): string | null {
  return (row.printedTicker ?? row.resolvedTicker)?.toUpperCase() ?? null;
}

function rolesOf(row: PoliticalTradeRow): EventRoles {
  return {
    owner: row.owner === "not_indicated" ? null : row.owner,
    action: row.action === "unmarked" ? null : row.action,
    partialSale: row.chamber === "senate" ? row.partialSale : row.partialSale ? true : null,
    transactionDate: row.transactionDate,
    ticker: eventTicker(row),
    assetTypeCode: row.assetTypeCode,
    assetTypeLabel: row.assetTypeLabel,
    amount: row.amountLow === null && row.amountHigh === null ? null : `${row.amountLow}-${row.amountHigh}`,
  };
}

function conflictingRoles(left: EventRoles, right: EventRoles): Array<keyof EventRoles> {
  return ROLE_KEYS.filter((key) => left[key] !== null && right[key] !== null && left[key] !== right[key]);
}

/**
 * One filer's open events, indexed by the only fields a match can use. A repeat must
 * share a transaction ID or a ticker and date; a correction must share a transaction ID
 * or a ticker. Looking up those buckets finds exactly the events a scan of every open
 * event would, without the scan: a member with 40,000 trades made the scan quadratic.
 */
interface FilerIndex {
  bySourceId: Map<string, OpenEvent[]>;
  byTickerDate: Map<string, OpenEvent[]>;
  byTicker: Map<string, OpenEvent[]>;
}

function tickerDateKey(roles: EventRoles): string | null {
  return roles.ticker !== null && roles.transactionDate !== null ? `${roles.ticker}|${roles.transactionDate}` : null;
}

function addTo(map: Map<string, OpenEvent[]>, key: string | null, event: OpenEvent): void {
  if (key === null) return;
  const list = map.get(key);
  if (list) list.push(event);
  else map.set(key, [event]);
}

function removeFrom(map: Map<string, OpenEvent[]>, key: string | null, event: OpenEvent): void {
  if (key === null) return;
  const list = map.get(key);
  const at = list?.indexOf(event) ?? -1;
  if (list && at >= 0) list.splice(at, 1);
}

function indexRoles(index: FilerIndex, event: OpenEvent): void {
  addTo(index.byTickerDate, tickerDateKey(event.roles), event);
  addTo(index.byTicker, event.roles.ticker, event);
}

function unindexRoles(index: FilerIndex, event: OpenEvent): void {
  removeFrom(index.byTickerDate, tickerDateKey(event.roles), event);
  removeFrom(index.byTicker, event.roles.ticker, event);
}

function inCreationOrder(...lists: Array<readonly OpenEvent[] | undefined>): OpenEvent[] {
  return [...new Set(lists.flatMap((list) => list ?? []))].sort((left, right) => left.seq - right.seq);
}

function observationId(row: PoliticalTradeRow): string {
  return `${row.docId}:${row.rowIndex}`;
}

function versionRow(event: Pick<OpenEvent, "eventId" | "firstAvailableAt">, version: number, row: IdentifiedTradeRow): PoliticalTradeEventRow {
  return {
    eventId: event.eventId, version, chamber: row.chamber, filerFirst: row.filerFirst, filerLast: row.filerLast,
    owner: row.owner, action: row.action, partialSale: row.partialSale, transactionDate: row.transactionDate,
    ticker: eventTicker(row), sourceTransactionId: row.sourceTransactionId, assetDescription: row.assetDescription,
    assetTypeCode: row.assetTypeCode, assetTypeLabel: row.assetTypeLabel, amountLow: row.amountLow,
    amountHigh: row.amountHigh, firstAvailableAt: event.firstAvailableAt, availableAt: row.availableAt,
    supersededAt: null, sourceDocId: row.docId, sourceRowIndex: row.rowIndex, sourceUrl: row.sourceUrl,
    contributorRowIds: JSON.stringify([observationId(row)]),
    filerKey: row.filerKey, memberId: row.memberId, displayName: row.displayName, identitySource: row.identitySource,
  };
}

function compareObservations(left: PoliticalTradeRow, right: PoliticalTradeRow): number {
  return left.availableAt.getTime() - right.availableAt.getTime() || left.chamber.localeCompare(right.chamber) ||
    left.docId.localeCompare(right.docId) || left.rowIndex - right.rowIndex;
}

/**
 * Deterministically consolidate repeated and amended observations into economic event
 * versions, per member. A member's filings are grouped by `filerKey`, so a repeat filed
 * under another spelling of the name still consolidates. Only members of Congress get
 * events: non-member and unresolved filers stay in the filing and trade tables.
 */
export function buildPoliticalTradeEvents(trades: readonly IdentifiedTradeRow[], filings: readonly IdentifiedFilingRow[]): PoliticalTradeEventRow[] {
  const filingByDoc = new Map(filings.map((filing) => [`${filing.chamber}:${filing.docId}`, filing]));
  const filingDocsByFilerDate = new Map<string, Set<string>>();
  for (const filing of filings) {
    for (const date of new Set([filing.filingDate, filing.reportDate])) {
      if (date === null) continue;
      const key = `${filing.filerKey}|${date}`;
      const docs = filingDocsByFilerDate.get(key) ?? new Set<string>();
      docs.add(filing.docId);
      filingDocsByFilerDate.set(key, docs);
    }
  }

  const events: OpenEvent[] = [];
  const indexes = new Map<string, FilerIndex>();
  let seq = 0;
  for (const row of [...trades].filter((trade) => MEMBER_IDENTITY_SOURCES.has(trade.identitySource)).sort(compareObservations)) {
    const key = row.filerKey;
    const index = indexes.get(key) ?? { bySourceId: new Map(), byTickerDate: new Map(), byTicker: new Map() };
    indexes.set(key, index);
    const roles = rolesOf(row);
    const isCandidate = (event: OpenEvent): boolean =>
      !event.currentDocIds.has(row.docId) && !(event.sourceTransactionId && row.sourceTransactionId && event.sourceTransactionId !== row.sourceTransactionId);
    const sharesId = (event: OpenEvent): boolean => event.sourceTransactionId !== null && event.sourceTransactionId === row.sourceTransactionId;
    const sameId = row.sourceTransactionId === null ? undefined : index.bySourceId.get(row.sourceTransactionId);
    const rowTickerDate = tickerDateKey(roles);
    const sameTickerDate = rowTickerDate === null ? undefined : index.byTickerDate.get(rowTickerDate);
    const repeated = inCreationOrder(sameId, sameTickerDate).find((event) => isCandidate(event) && conflictingRoles(event.roles, roles).length === 0 && (
      sharesId(event) || roles.ticker !== null && event.roles.ticker === roles.ticker && roles.transactionDate !== null && event.roles.transactionDate === roles.transactionDate
    ));
    if (repeated) {
      repeated.currentDocIds.add(row.docId);
      repeated.allDocIds.add(row.docId);
      repeated.contributors.push(observationId(row));
      if (repeated.sourceTransactionId === null && row.sourceTransactionId !== null) {
        repeated.sourceTransactionId = row.sourceTransactionId;
        addTo(index.bySourceId, row.sourceTransactionId, repeated);
      }
      const current = repeated.versions[repeated.versions.length - 1];
      if (current) current.contributorRowIds = JSON.stringify(repeated.contributors);
      continue;
    }

    const amendedDate = filingByDoc.get(`${row.chamber}:${row.docId}`)?.amendedReportDate ?? null;
    const amendedDocs = amendedDate ? filingDocsByFilerDate.get(`${key}|${amendedDate}`) : undefined;
    const corrected = inCreationOrder(sameId).find((event) => isCandidate(event) && sharesId(event)) ??
      (amendedDocs && roles.ticker !== null ? inCreationOrder(index.byTicker.get(roles.ticker)).find((event) =>
        isCandidate(event) && [...event.allDocIds].some((docId) => amendedDocs.has(docId)) &&
        event.roles.ticker === roles.ticker && conflictingRoles(event.roles, roles).length === 1
      ) : undefined);
    if (corrected) {
      const previous = corrected.versions[corrected.versions.length - 1];
      if (!previous) throw new Error(`Event ${corrected.eventId} has no current version`);
      previous.supersededAt = row.availableAt;
      corrected.versions.push(versionRow(corrected, previous.version + 1, row));
      corrected.currentDocIds = new Set([row.docId]);
      corrected.allDocIds.add(row.docId);
      unindexRoles(index, corrected);
      corrected.roles = roles;
      indexRoles(index, corrected);
      corrected.contributors = [observationId(row)];
      if (corrected.sourceTransactionId === null && row.sourceTransactionId !== null) {
        corrected.sourceTransactionId = row.sourceTransactionId;
        addTo(index.bySourceId, row.sourceTransactionId, corrected);
      }
      continue;
    }

    const event: OpenEvent = {
      seq: seq++, eventId: `${row.chamber}:${observationId(row)}`, sourceTransactionId: row.sourceTransactionId,
      firstAvailableAt: row.availableAt, versions: [], currentDocIds: new Set([row.docId]),
      allDocIds: new Set([row.docId]), roles, contributors: [observationId(row)],
    };
    event.versions.push(versionRow(event, 1, row));
    events.push(event);
    addTo(index.bySourceId, event.sourceTransactionId, event);
    indexRoles(index, event);
  }
  return events.flatMap((event) => event.versions);
}
