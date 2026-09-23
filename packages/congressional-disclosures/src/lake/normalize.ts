import {
  isIsoCalendarDate,
  ptrAmountBounds,
  ptrRowInvalidReason,
  PTR_AMOUNT_CATEGORIES,
  PTR_OWNERS,
  PTR_UNMARKED,
  type PtrDocumentResult,
} from "../extraction";
import type { HouseIndexFiling } from "../sources/house";
import { parseSenateReportTitle, type SenateElectronicTransaction } from "../sources/senate";
import { endOfDayNewYork, parseSlashDate } from "./dates";
import {
  HOUSE_AVAILABILITY_SOURCE,
  SENATE_AVAILABILITY_SOURCE,
  type PoliticalAction,
  type PoliticalExtractionStatus,
  type PoliticalFilingRow,
  type PoliticalFilingRows,
  type PoliticalOwner,
  type PoliticalTradeRow,
} from "./types";

export const POLITICAL_TRADE_EARLIEST_DATE = "1789-01-01";

export function latestUsablePoliticalDate(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
}

export function sanitizePoliticalTrades(trades: readonly PoliticalTradeRow[], latest: string): { trades: PoliticalTradeRow[]; dropped: string[] } {
  const kept: PoliticalTradeRow[] = [];
  const dropped: string[] = [];
  for (const trade of trades) {
    let notificationDate = trade.notificationDate;
    if (notificationDate !== null && (notificationDate < POLITICAL_TRADE_EARLIEST_DATE || notificationDate > latest)) {
      dropped.push(`${trade.docId}#${trade.rowIndex} notificationDate ${notificationDate} nulled`);
      notificationDate = null;
    }
    if (trade.transactionDate !== null && (
      trade.transactionDate < POLITICAL_TRADE_EARLIEST_DATE || trade.transactionDate > latest || trade.transactionDate > trade.filingDate
    )) {
      dropped.push(`${trade.docId}#${trade.rowIndex} transactionDate ${trade.transactionDate} rejected`);
      continue;
    }
    kept.push(notificationDate === trade.notificationDate ? trade : { ...trade, notificationDate });
  }
  return { trades: kept, dropped };
}

export function unresolvedUntilResolution(printedTicker: string | null): Pick<PoliticalTradeRow, "resolvedTicker" | "resolutionStatus" | "resolutionReason"> {
  return printedTicker
    ? { resolvedTicker: null, resolutionStatus: "printed", resolutionReason: null }
    : { resolvedTicker: null, resolutionStatus: "unresolved", resolutionReason: "no ticker printed" };
}

export interface RawDisclosureSource {
  sourceUrl: string;
  rawArchiveKey: string;
  rawSha256: string;
}

export interface HouseExtraction {
  result: PtrDocumentResult;
  parseMethod: "text" | "scan";
  model: string;
  contractVersion: string;
  ocrArchiveKey: string | null;
  processedAt: Date;
}

export interface SenateReportSource extends RawDisclosureSource {
  reportId: string;
  firstName: string;
  lastName: string;
  submittedDate: string;
  reportTitle: string;
  processedAt: Date;
}

export interface SenatePaperExtractionRecord {
  result: PtrDocumentResult;
  model: string;
  contractVersion: string;
  ocrArchiveKey: string | null;
}

const EXTRACTED_ACTIONS: Readonly<Record<string, PoliticalAction>> = { P: "purchase", S: "sale", E: "exchange", [PTR_UNMARKED]: "unmarked" };
const SENATE_ACTIONS: Readonly<Record<string, { action: PoliticalAction; partialSale: boolean }>> = {
  Purchase: { action: "purchase", partialSale: false },
  "Sale (Full)": { action: "sale", partialSale: false },
  "Sale (Partial)": { action: "sale", partialSale: true },
  Exchange: { action: "exchange", partialSale: false },
};
const SENATE_OWNERS: Readonly<Record<string, PoliticalOwner>> = {
  Self: "self", Spouse: "spouse", Joint: "joint", Child: "dependent_child",
};
const STATUTORY_AMOUNTS = new Set<string>(PTR_AMOUNT_CATEGORIES.map((category) => category.label));

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isOwner(value: unknown): value is PoliticalOwner {
  return (PTR_OWNERS as readonly unknown[]).includes(value);
}

function extractedTrade(
  identity: Pick<PoliticalTradeRow, "chamber" | "docId" | "filerFirst" | "filerLast" | "availabilitySource">,
  source: RawDisclosureSource,
  base: Pick<PoliticalTradeRow, "filingDate" | "availableAt">,
  row: Record<string, unknown>,
  rowIndex: number
): PoliticalTradeRow {
  const code = stringOrNull(row.transaction_type_code);
  const action = code ? EXTRACTED_ACTIONS[code] : undefined;
  if (!action) throw new Error(`row ${rowIndex + 1} has transaction type "${code}"`);
  if (!isOwner(row.owner)) throw new Error(`row ${rowIndex + 1} has no stated owner`);
  if (typeof row.partial_sale !== "boolean") throw new Error(`row ${rowIndex + 1} has no stated partial_sale`);
  const assetDescription = stringOrNull(row.asset_description);
  const amountBracket = stringOrNull(row.amount_bracket);
  if (!assetDescription || !amountBracket) throw new Error(`row ${rowIndex + 1} has no asset description or amount`);
  const ticker = stringOrNull(row.ticker);
  const bounds = ptrAmountBounds(row.amount_category, row.amount_exact);
  return {
    ...identity,
    ...base,
    rowIndex,
    sourceTransactionId: stringOrNull(row.source_transaction_id),
    owner: row.owner,
    ownerCodeRaw: stringOrNull(row.owner_code),
    action,
    partialSale: row.partial_sale,
    actionCodeRaw: stringOrNull(row.transaction_type_raw),
    transactionDate: isIsoCalendarDate(row.transaction_date_iso) ? row.transaction_date_iso : null,
    notificationDate: isIsoCalendarDate(row.notification_date_iso) ? row.notification_date_iso : null,
    assetDescription,
    printedTicker: ticker,
    ...unresolvedUntilResolution(ticker),
    assetTypeCode: stringOrNull(row.asset_type_code),
    assetTypeLabel: null,
    amountBracket,
    amountLow: bounds.low,
    amountHigh: bounds.high,
    capGainsOver200: typeof row.cap_gains_over_200 === "boolean" ? row.cap_gains_over_200 : null,
    comment: stringOrNull(row.transaction_description),
    filingStatus: stringOrNull(row.filing_status),
    ...source,
  };
}

function extractedTrades(result: PtrDocumentResult, toTrade: (row: Record<string, unknown>, index: number) => PoliticalTradeRow, now: Date): { trades: PoliticalTradeRow[] } | { failureReason: string } {
  if (result.error) return { failureReason: result.error };
  if (result.invalidRowIndexes.length > 0) {
    return { failureReason: `invalid rows: ${result.invalidRowIndexes.map((index) => ptrRowInvalidReason(result.rows[index] ?? {}) ? `row ${index + 1} ${ptrRowInvalidReason(result.rows[index] ?? {})}` : String(index + 1)).join("; ")}` };
  }
  try {
    return sanitizePoliticalTrades(result.rows.map(toTrade), latestUsablePoliticalDate(now));
  } catch (error) {
    return { failureReason: error instanceof Error ? error.message : String(error) };
  }
}

export function houseFilingRows(filing: HouseIndexFiling, source: RawDisclosureSource, extraction: HouseExtraction): PoliticalFilingRows {
  const filingDate = parseSlashDate(filing.filingDate);
  if (!filingDate) throw new Error(`House filing ${filing.docId} has no filing date`);
  const availableAt = endOfDayNewYork(filingDate);
  const filingRow = (status: "ok" | "failed", failureReason: string | null, extractedRows: number): PoliticalFilingRow => ({
    chamber: "house", docId: filing.docId, filerFirst: filing.first, filerLast: filing.last,
    filerSuffix: stringOrNull(filing.suffix), stateDistrict: stringOrNull(filing.stateDistrict), filingDate, availableAt,
    availabilitySource: HOUSE_AVAILABILITY_SOURCE, ...source, parseMethod: extraction.parseMethod,
    extractionStatus: status, failureReason, extractedRows, extractionModel: extraction.model,
    contractVersion: extraction.contractVersion, ocrArchiveKey: extraction.ocrArchiveKey,
    amendedReportDate: extraction.result.amendedReportDateIso, reportDate: null, processedAt: extraction.processedAt,
  });
  const mapped = extractedTrades(extraction.result, (row, index) => extractedTrade({
    chamber: "house", docId: filing.docId, filerFirst: filing.first, filerLast: filing.last,
    availabilitySource: HOUSE_AVAILABILITY_SOURCE,
  }, source, { filingDate, availableAt }, row, index), extraction.processedAt);
  return "failureReason" in mapped
    ? { filing: filingRow("failed", mapped.failureReason, 0), trades: [] }
    : { filing: filingRow("ok", null, mapped.trades.length), trades: mapped.trades };
}

function senateFilingRow(report: SenateReportSource, parseMethod: "html" | "paper", status: PoliticalExtractionStatus, reason: string | null, count: number, provenance: { model: string; contractVersion: string; ocrArchiveKey: string | null; amendedReportDate: string | null } | null = null): PoliticalFilingRow {
  const filingDate = parseSlashDate(report.submittedDate);
  if (!filingDate) throw new Error(`Senate report ${report.reportId} has no submission date`);
  const title = parseSenateReportTitle(report.reportTitle);
  return {
    chamber: "senate", docId: report.reportId, filerFirst: report.firstName, filerLast: report.lastName,
    filerSuffix: null, stateDistrict: null, filingDate, availableAt: endOfDayNewYork(filingDate),
    availabilitySource: SENATE_AVAILABILITY_SOURCE, sourceUrl: report.sourceUrl, rawArchiveKey: report.rawArchiveKey,
    rawSha256: report.rawSha256, parseMethod, extractionStatus: status, failureReason: reason, extractedRows: count,
    extractionModel: provenance?.model ?? null, contractVersion: provenance?.contractVersion ?? null,
    ocrArchiveKey: provenance?.ocrArchiveKey ?? null,
    amendedReportDate: title?.amendment === "numbered" ? title.reportDate : provenance?.amendedReportDate ?? null,
    reportDate: title?.reportDate ?? null, processedAt: report.processedAt,
  };
}

export function senateFilingWithoutTrades(report: SenateReportSource, parseMethod: "html" | "paper", status: "failed" | "unsupported", reason: string): PoliticalFilingRows {
  return { filing: senateFilingRow(report, parseMethod, status, reason, 0), trades: [] };
}

export function senatePaperFilingRows(report: SenateReportSource, extraction: SenatePaperExtractionRecord): PoliticalFilingRows {
  const base = senateFilingRow(report, "paper", "ok", null, 0, {
    model: extraction.model, contractVersion: extraction.contractVersion, ocrArchiveKey: extraction.ocrArchiveKey,
    amendedReportDate: extraction.result.amendedReportDateIso,
  });
  const mapped = extractedTrades(extraction.result, (row, index) => extractedTrade({
    chamber: "senate", docId: report.reportId, filerFirst: report.firstName, filerLast: report.lastName,
    availabilitySource: SENATE_AVAILABILITY_SOURCE,
  }, report, { filingDate: base.filingDate, availableAt: base.availableAt }, row, index), report.processedAt);
  return "failureReason" in mapped
    ? { filing: { ...base, extractionStatus: "failed", failureReason: mapped.failureReason }, trades: [] }
    : { filing: { ...base, extractedRows: mapped.trades.length }, trades: mapped.trades };
}

/**
 * eFD prints "--" in the Ticker column for some securities and puts the
 * ticker at the head of Asset Name instead: "SPYM - Tradr 2X Long SPY
 * Monthly ETF". Left null, the row can never consolidate with its amendment,
 * because a Senate row has no transaction id and consolidation then keys on
 * ticker and date. Only the first " - " splits, since the ticker itself may
 * hold a hyphen ("BRK-B - Berkshire Hathaway Inc Class B").
 *
 * Two shapes are refused. A corporate bond names its issuer's ticker
 * ("FIS - ... Rate/Coupon: 4.700%"), which would price the bond as the
 * stock. An exchange names two securities in one row ("BBT.F - ...
 * (Exchanged) TFC.F - ... (Received)") and has no single ticker.
 */
const SENATE_ASSET_NAME_TICKER = /^([A-Z][A-Z0-9.]{0,5}(?:-[A-Z])?) - \S/;
const SENATE_EXCHANGE_MARKER = /\((?:Exchanged|Received)\)/;
const SENATE_TICKERED_ASSET_TYPES = new Set(["Stock", "Other", "Cryptocurrency"]);

export function senateTickerFromAssetName(assetName: string, assetType: string): string | null {
  if (!SENATE_TICKERED_ASSET_TYPES.has(assetType)) return null;
  if (SENATE_EXCHANGE_MARKER.test(assetName)) return null;
  return SENATE_ASSET_NAME_TICKER.exec(assetName.trim())?.[1] ?? null;
}

export function senateElectronicFilingRows(report: SenateReportSource, transactions: readonly SenateElectronicTransaction[]): PoliticalFilingRows {
  const base = senateFilingRow(report, "html", "ok", null, 0);
  const problems: string[] = [];
  const title = parseSenateReportTitle(report.reportTitle);
  if (!title) problems.push(`report title "${report.reportTitle}" is not a known eFD title`);
  const trades = transactions.flatMap((transaction, rowIndex): PoliticalTradeRow[] => {
    const action = SENATE_ACTIONS[transaction.transactionType];
    const owner = SENATE_OWNERS[transaction.owner];
    if (!action) problems.push(`row ${transaction.rowNumber} has unknown type "${transaction.transactionType}"`);
    if (!owner) problems.push(`row ${transaction.rowNumber} has unknown owner "${transaction.owner}"`);
    if (!STATUTORY_AMOUNTS.has(transaction.amount)) problems.push(`row ${transaction.rowNumber} has non-statutory amount "${transaction.amount}"`);
    let transactionDate: string | null = null;
    try { transactionDate = parseSlashDate(transaction.transactionDate); } catch (error) { problems.push(String(error)); }
    if (!action || !owner) return [];
    const bounds = ptrAmountBounds(transaction.amount);
    const printedTicker = transaction.ticker ?? senateTickerFromAssetName(transaction.assetName, transaction.assetType);
    return [{
      chamber: "senate", docId: report.reportId, rowIndex, sourceTransactionId: null,
      filerFirst: report.firstName, filerLast: report.lastName, owner, ownerCodeRaw: transaction.owner,
      action: action.action, partialSale: action.partialSale, actionCodeRaw: transaction.transactionType,
      transactionDate, notificationDate: null, filingDate: base.filingDate, availableAt: base.availableAt,
      availabilitySource: SENATE_AVAILABILITY_SOURCE, assetDescription: transaction.assetName,
      printedTicker, ...unresolvedUntilResolution(printedTicker), assetTypeCode: null,
      assetTypeLabel: transaction.assetType, amountBracket: transaction.amount, amountLow: bounds.low,
      amountHigh: bounds.high, capGainsOver200: null, comment: transaction.comment,
      filingStatus: title && title.amendment !== "none" ? "Amended" : null,
      sourceUrl: report.sourceUrl, rawArchiveKey: report.rawArchiveKey, rawSha256: report.rawSha256,
    }];
  });
  if (problems.length > 0) return { filing: { ...base, extractionStatus: "failed", failureReason: problems.join("; ") }, trades: [] };
  const sanitized = sanitizePoliticalTrades(trades, latestUsablePoliticalDate(report.processedAt));
  return { filing: { ...base, extractedRows: sanitized.trades.length }, trades: sanitized.trades };
}
