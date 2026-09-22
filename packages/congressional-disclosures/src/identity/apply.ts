import type { PoliticalFilingRow, PoliticalFilingRows, PoliticalTradeRow } from "../lake/types";
import { filedDisplayName, nameKey, type MemberResolver } from "./resolve";
import type { FilerIdentity } from "./types";

export type Identified<T> = T & FilerIdentity;
export type IdentifiedFilingRow = Identified<PoliticalFilingRow>;
export type IdentifiedTradeRow = Identified<PoliticalTradeRow>;

/** One filing and its printed trades, identified: what a repository replaces atomically. */
export interface IdentifiedFilingRows {
  filing: IdentifiedFilingRow;
  trades: IdentifiedTradeRow[];
}

function docKey(row: Pick<PoliticalFilingRow, "chamber" | "docId">): string {
  return `${row.chamber}:${row.docId}`;
}

function withIdentity<T extends object>(row: T, identity: FilerIdentity): Identified<T> {
  return {
    ...row,
    filerKey: identity.filerKey,
    memberId: identity.memberId,
    displayName: identity.displayName,
    identitySource: identity.identitySource,
  };
}

/**
 * Stamp every filing with its filer's identity, and every trade with its filing's.
 * Identity is a function of the filing, so a trade never disagrees with its filing.
 * A trade whose filing is missing (an orphan the audit already fails) keeps its
 * printed name, unresolved.
 */
export function identifyPoliticalRows(
  filings: readonly PoliticalFilingRow[],
  trades: readonly PoliticalTradeRow[],
  resolver: MemberResolver,
): { filings: IdentifiedFilingRow[]; trades: IdentifiedTradeRow[] } {
  const byDoc = new Map<string, FilerIdentity>();
  const identifiedFilings = filings.map((filing) => {
    const identity = resolver.resolve(filing);
    byDoc.set(docKey(filing), identity);
    return withIdentity(filing, identity);
  });
  const identifiedTrades = trades.map((trade) =>
    withIdentity(trade, byDoc.get(docKey(trade)) ?? {
      filerKey: nameKey(trade),
      memberId: null,
      displayName: filedDisplayName(trade),
      identitySource: "unresolved",
    }),
  );
  return { filings: identifiedFilings, trades: identifiedTrades };
}

/** Identify one freshly extracted filing and its trades. */
export function identifyFilingRows(rows: PoliticalFilingRows, resolver: MemberResolver): IdentifiedFilingRows {
  const identity = resolver.resolve(rows.filing);
  return { filing: withIdentity(rows.filing, identity), trades: rows.trades.map((trade) => withIdentity(trade, identity)) };
}
