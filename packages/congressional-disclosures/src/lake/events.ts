import type { PoliticalFilingRow, PoliticalTradeEventRow, PoliticalTradeRow } from "./types";

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

function filerKey(row: Pick<PoliticalTradeRow, "chamber" | "filerFirst" | "filerLast">): string {
  return `${row.chamber}|${row.filerLast.trim().toLowerCase()}|${row.filerFirst.trim().toLowerCase()}`;
}

/** Events never cross filers, so repositories may rebuild one filer's events independently. */
export function politicalFilerKey(row: Pick<PoliticalTradeRow, "chamber" | "filerFirst" | "filerLast">): string {
  return filerKey(row);
}

function observationId(row: PoliticalTradeRow): string {
  return `${row.docId}:${row.rowIndex}`;
}

function versionRow(event: Pick<OpenEvent, "eventId" | "firstAvailableAt">, version: number, row: PoliticalTradeRow): PoliticalTradeEventRow {
  return {
    eventId: event.eventId, version, chamber: row.chamber, filerFirst: row.filerFirst, filerLast: row.filerLast,
    owner: row.owner, action: row.action, partialSale: row.partialSale, transactionDate: row.transactionDate,
    ticker: eventTicker(row), sourceTransactionId: row.sourceTransactionId, assetDescription: row.assetDescription,
    assetTypeCode: row.assetTypeCode, assetTypeLabel: row.assetTypeLabel, amountLow: row.amountLow,
    amountHigh: row.amountHigh, firstAvailableAt: event.firstAvailableAt, availableAt: row.availableAt,
    supersededAt: null, sourceDocId: row.docId, sourceRowIndex: row.rowIndex, sourceUrl: row.sourceUrl,
    contributorRowIds: JSON.stringify([observationId(row)]),
  };
}

function compareObservations(left: PoliticalTradeRow, right: PoliticalTradeRow): number {
  return left.availableAt.getTime() - right.availableAt.getTime() || left.chamber.localeCompare(right.chamber) ||
    left.docId.localeCompare(right.docId) || left.rowIndex - right.rowIndex;
}

/** Deterministically consolidate repeated and amended observations into economic event versions. */
export function buildPoliticalTradeEvents(trades: readonly PoliticalTradeRow[], filings: readonly PoliticalFilingRow[]): PoliticalTradeEventRow[] {
  const filingByDoc = new Map(filings.map((filing) => [`${filing.chamber}:${filing.docId}`, filing]));
  const filingDocsByFilerDate = new Map<string, Set<string>>();
  for (const filing of filings) {
    for (const date of new Set([filing.filingDate, filing.reportDate])) {
      if (date === null) continue;
      const key = `${filerKey(filing)}|${date}`;
      const docs = filingDocsByFilerDate.get(key) ?? new Set<string>();
      docs.add(filing.docId);
      filingDocsByFilerDate.set(key, docs);
    }
  }

  const events: OpenEvent[] = [];
  const byFiler = new Map<string, OpenEvent[]>();
  for (const row of [...trades].sort(compareObservations)) {
    const key = filerKey(row);
    const roles = rolesOf(row);
    const candidates = (byFiler.get(key) ?? []).filter((event) =>
      !event.currentDocIds.has(row.docId) && !(event.sourceTransactionId && row.sourceTransactionId && event.sourceTransactionId !== row.sourceTransactionId)
    );
    const sharesId = (event: OpenEvent): boolean => event.sourceTransactionId !== null && event.sourceTransactionId === row.sourceTransactionId;
    const repeated = candidates.find((event) => conflictingRoles(event.roles, roles).length === 0 && (
      sharesId(event) || roles.ticker !== null && event.roles.ticker === roles.ticker && roles.transactionDate !== null && event.roles.transactionDate === roles.transactionDate
    ));
    if (repeated) {
      repeated.currentDocIds.add(row.docId);
      repeated.allDocIds.add(row.docId);
      repeated.contributors.push(observationId(row));
      repeated.sourceTransactionId ??= row.sourceTransactionId;
      const current = repeated.versions[repeated.versions.length - 1];
      if (current) current.contributorRowIds = JSON.stringify(repeated.contributors);
      continue;
    }

    const amendedDate = filingByDoc.get(`${row.chamber}:${row.docId}`)?.amendedReportDate ?? null;
    const amendedDocs = amendedDate ? filingDocsByFilerDate.get(`${key}|${amendedDate}`) : undefined;
    const corrected = candidates.find(sharesId) ?? (amendedDocs ? candidates.find((event) =>
      [...event.allDocIds].some((docId) => amendedDocs.has(docId)) && roles.ticker !== null &&
      event.roles.ticker === roles.ticker && conflictingRoles(event.roles, roles).length === 1
    ) : undefined);
    if (corrected) {
      const previous = corrected.versions[corrected.versions.length - 1];
      if (!previous) throw new Error(`Event ${corrected.eventId} has no current version`);
      previous.supersededAt = row.availableAt;
      corrected.versions.push(versionRow(corrected, previous.version + 1, row));
      corrected.currentDocIds = new Set([row.docId]);
      corrected.allDocIds.add(row.docId);
      corrected.roles = roles;
      corrected.contributors = [observationId(row)];
      corrected.sourceTransactionId ??= row.sourceTransactionId;
      continue;
    }

    const event: OpenEvent = {
      eventId: `${row.chamber}:${observationId(row)}`, sourceTransactionId: row.sourceTransactionId,
      firstAvailableAt: row.availableAt, versions: [], currentDocIds: new Set([row.docId]),
      allDocIds: new Set([row.docId]), roles, contributors: [observationId(row)],
    };
    event.versions.push(versionRow(event, 1, row));
    events.push(event);
    byFiler.set(key, [...(byFiler.get(key) ?? []), event]);
  }
  return events.flatMap((event) => event.versions);
}
