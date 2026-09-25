import type { PTR_OWNERS } from "../extraction";
import type { IdentifiedFilingRow, IdentifiedTradeRow } from "../identity/apply";
import type { IdentitySource } from "../identity/types";

export const POLITICAL_FILINGS_PREFIX = "political_filings";
export const POLITICAL_TRADES_PREFIX = "political_trades";
export const POLITICAL_TRADE_EVENTS_PREFIX = "political_trade_events";

export const HOUSE_AVAILABILITY_SOURCE = "house_fd_index_filing_date";
export const SENATE_AVAILABILITY_SOURCE = "senate_efd_filed_date";

export const POLITICAL_CHAMBERS = ["house", "senate"] as const;
export type PoliticalChamber = (typeof POLITICAL_CHAMBERS)[number];
export const POLITICAL_PARSE_METHODS = ["text", "scan", "html", "paper"] as const;
export type PoliticalParseMethod = (typeof POLITICAL_PARSE_METHODS)[number];
export const POLITICAL_EXTRACTION_STATUSES = ["ok", "failed", "unsupported"] as const;
export type PoliticalExtractionStatus = (typeof POLITICAL_EXTRACTION_STATUSES)[number];
export const POLITICAL_ACTIONS = ["purchase", "sale", "exchange", "unmarked"] as const;
export type PoliticalAction = (typeof POLITICAL_ACTIONS)[number];
export type PoliticalOwner = (typeof PTR_OWNERS)[number];
export const RESOLUTION_STATUSES = ["printed", "resolved", "not_public_equity", "unresolved"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export interface PoliticalFilingRow {
  chamber: PoliticalChamber;
  docId: string;
  filerFirst: string;
  filerLast: string;
  filerSuffix: string | null;
  stateDistrict: string | null;
  filingDate: string;
  availableAt: Date;
  availabilitySource: string;
  sourceUrl: string;
  rawArchiveKey: string;
  rawSha256: string;
  parseMethod: PoliticalParseMethod;
  extractionStatus: PoliticalExtractionStatus;
  failureReason: string | null;
  extractedRows: number;
  extractionModel: string | null;
  contractVersion: string | null;
  ocrArchiveKey: string | null;
  amendedReportDate: string | null;
  reportDate: string | null;
  processedAt: Date;
}

export interface PoliticalTradeRow {
  chamber: PoliticalChamber;
  docId: string;
  rowIndex: number;
  sourceTransactionId: string | null;
  filerFirst: string;
  filerLast: string;
  owner: PoliticalOwner;
  ownerCodeRaw: string | null;
  action: PoliticalAction;
  partialSale: boolean;
  actionCodeRaw: string | null;
  transactionDate: string | null;
  notificationDate: string | null;
  filingDate: string;
  availableAt: Date;
  availabilitySource: string;
  assetDescription: string;
  printedTicker: string | null;
  resolvedTicker: string | null;
  resolutionStatus: ResolutionStatus;
  resolutionReason: string | null;
  assetTypeCode: string | null;
  assetTypeLabel: string | null;
  amountBracket: string;
  amountLow: number | null;
  amountHigh: number | null;
  capGainsOver200: boolean | null;
  comment: string | null;
  filingStatus: string | null;
  sourceUrl: string;
  rawArchiveKey: string;
  rawSha256: string;
}

export interface PoliticalTradeEventRow {
  eventId: string;
  version: number;
  chamber: PoliticalChamber;
  filerFirst: string;
  filerLast: string;
  owner: PoliticalOwner;
  action: PoliticalAction;
  partialSale: boolean;
  transactionDate: string | null;
  ticker: string | null;
  sourceTransactionId: string | null;
  assetDescription: string;
  /** Comment text retained from extraction, including option terms when captured. */
  comment?: string | null;
  assetTypeCode: string | null;
  assetTypeLabel: string | null;
  amountLow: number | null;
  amountHigh: number | null;
  firstAvailableAt: Date;
  availableAt: Date;
  supersededAt: Date | null;
  sourceDocId: string;
  sourceRowIndex: number;
  sourceUrl: string;
  contributorRowIds: string;
  /** `member:<bioguide>`: events exist only for members of Congress. */
  filerKey: string;
  memberId: string | null;
  displayName: string;
  identitySource: IdentitySource;
}

export interface PoliticalFilingRows {
  filing: PoliticalFilingRow;
  trades: PoliticalTradeRow[];
}

export interface PoliticalLakeSnapshot {
  filings: IdentifiedFilingRow[];
  trades: IdentifiedTradeRow[];
  events: PoliticalTradeEventRow[];
}

/** Identity columns every published table carries, derived from the filing. */
const IDENTITY_COLUMNS = { filerKey: "VARCHAR", memberId: "VARCHAR", displayName: "VARCHAR", identitySource: "VARCHAR" } as const;

export const POLITICAL_FILINGS_COLUMNS: Readonly<Record<keyof IdentifiedFilingRow, string>> = {
  chamber: "VARCHAR", docId: "VARCHAR", filerFirst: "VARCHAR", filerLast: "VARCHAR",
  filerSuffix: "VARCHAR", stateDistrict: "VARCHAR", filingDate: "DATE", availableAt: "TIMESTAMP",
  availabilitySource: "VARCHAR", sourceUrl: "VARCHAR", rawArchiveKey: "VARCHAR", rawSha256: "VARCHAR",
  parseMethod: "VARCHAR", extractionStatus: "VARCHAR", failureReason: "VARCHAR", extractedRows: "INTEGER",
  extractionModel: "VARCHAR", contractVersion: "VARCHAR", ocrArchiveKey: "VARCHAR",
  amendedReportDate: "DATE", reportDate: "DATE", processedAt: "TIMESTAMP", ...IDENTITY_COLUMNS,
};

export const POLITICAL_TRADES_COLUMNS: Readonly<Record<keyof IdentifiedTradeRow, string>> = {
  chamber: "VARCHAR", docId: "VARCHAR", rowIndex: "INTEGER", sourceTransactionId: "VARCHAR",
  filerFirst: "VARCHAR", filerLast: "VARCHAR", owner: "VARCHAR", ownerCodeRaw: "VARCHAR",
  action: "VARCHAR", partialSale: "BOOLEAN", actionCodeRaw: "VARCHAR", transactionDate: "DATE",
  notificationDate: "DATE", filingDate: "DATE", availableAt: "TIMESTAMP", availabilitySource: "VARCHAR",
  assetDescription: "VARCHAR", printedTicker: "VARCHAR", resolvedTicker: "VARCHAR",
  resolutionStatus: "VARCHAR", resolutionReason: "VARCHAR", assetTypeCode: "VARCHAR",
  assetTypeLabel: "VARCHAR", amountBracket: "VARCHAR", amountLow: "DOUBLE", amountHigh: "DOUBLE",
  capGainsOver200: "BOOLEAN", comment: "VARCHAR", filingStatus: "VARCHAR", sourceUrl: "VARCHAR",
  rawArchiveKey: "VARCHAR", rawSha256: "VARCHAR", ...IDENTITY_COLUMNS,
};

export const POLITICAL_TRADE_EVENTS_COLUMNS: Readonly<Record<keyof PoliticalTradeEventRow, string>> = {
  eventId: "VARCHAR", version: "INTEGER", chamber: "VARCHAR", filerFirst: "VARCHAR", filerLast: "VARCHAR",
  owner: "VARCHAR", action: "VARCHAR", partialSale: "BOOLEAN", transactionDate: "DATE", ticker: "VARCHAR",
  sourceTransactionId: "VARCHAR", assetDescription: "VARCHAR", comment: "VARCHAR", assetTypeCode: "VARCHAR",
  assetTypeLabel: "VARCHAR", amountLow: "DOUBLE", amountHigh: "DOUBLE", firstAvailableAt: "TIMESTAMP",
  availableAt: "TIMESTAMP", supersededAt: "TIMESTAMP", sourceDocId: "VARCHAR", sourceRowIndex: "INTEGER",
  sourceUrl: "VARCHAR", contributorRowIds: "VARCHAR", ...IDENTITY_COLUMNS,
};

export const POLITICAL_ORDER_BY = "filerLast, availableAt";
