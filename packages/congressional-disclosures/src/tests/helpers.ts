import { PoliticalFilingRow, PoliticalFilingRows, PoliticalTradeRow } from "../lake/types";

const PROCESSED_AT = new Date("2026-09-19T00:00:00.000Z");

export function filingFixture(overrides: Partial<PoliticalFilingRow> = {}): PoliticalFilingRow {
  return {
    chamber: "house",
    docId: "20018253",
    filerFirst: "Nancy",
    filerLast: "Pelosi",
    filerSuffix: null,
    stateDistrict: "CA12",
    filingDate: "2024-06-15",
    availableAt: new Date("2024-06-16T03:59:59.999Z"),
    availabilitySource: "house_fd_index_filing_date",
    sourceUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20018253.pdf",
    rawArchiveKey: "raw/ab/abcdef.pdf",
    rawSha256: "a".repeat(64),
    parseMethod: "text",
    extractionStatus: "ok",
    failureReason: null,
    extractedRows: 1,
    extractionModel: "test-model",
    contractVersion: "house-ptr-lake-v11",
    ocrArchiveKey: null,
    amendedReportDate: null,
    reportDate: null,
    processedAt: PROCESSED_AT,
    ...overrides,
  };
}

export function tradeFixture(overrides: Partial<PoliticalTradeRow> = {}): PoliticalTradeRow {
  return {
    chamber: "house",
    docId: "20018253",
    rowIndex: 0,
    sourceTransactionId: null,
    filerFirst: "Nancy",
    filerLast: "Pelosi",
    owner: "self",
    ownerCodeRaw: null,
    action: "purchase",
    partialSale: false,
    actionCodeRaw: "P",
    transactionDate: "2024-06-10",
    notificationDate: null,
    filingDate: "2024-06-15",
    availableAt: new Date("2024-06-16T03:59:59.999Z"),
    availabilitySource: "house_fd_index_filing_date",
    assetDescription: "Apple Inc. Common Stock",
    printedTicker: "AAPL",
    resolvedTicker: null,
    resolutionStatus: "printed",
    resolutionReason: null,
    assetTypeCode: null,
    assetTypeLabel: null,
    amountBracket: "$1,001 - $15,000",
    amountLow: 1001,
    amountHigh: 15000,
    capGainsOver200: null,
    comment: null,
    filingStatus: null,
    sourceUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20018253.pdf",
    rawArchiveKey: "raw/ab/abcdef.pdf",
    rawSha256: "a".repeat(64),
    ...overrides,
  };
}

export function filingRowsFixture(overrides: {
  filing?: Partial<PoliticalFilingRow>;
  trades?: Partial<PoliticalTradeRow>[];
} = {}): PoliticalFilingRows {
  const filing = filingFixture(overrides.filing);
  const defaults = overrides.trades ?? [{}];
  return {
    filing,
    trades: defaults.map((trade, index) =>
      tradeFixture({
        chamber: filing.chamber,
        docId: filing.docId,
        filerFirst: filing.filerFirst,
        filerLast: filing.filerLast,
        filingDate: filing.filingDate,
        availableAt: filing.availableAt,
        rowIndex: index,
        ...trade,
      })
    ),
  };
}
