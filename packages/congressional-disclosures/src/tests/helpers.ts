import { identifyFilingRows, identifyPoliticalRows, type IdentifiedFilingRows } from "../identity/apply";
import { MemberResolver } from "../identity/resolve";
import type { Legislator, LegislatorsSnapshot, MemberOverride } from "../identity/types";
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

function rep(bioguide: string, first: string, last: string, state: string, district: number | null, start = "2001-01-03", end = "2027-01-03"): Legislator {
  return {
    bioguide, first, middle: null, nickname: null, last, officialFull: `${first} ${last}`,
    terms: [{ type: "rep", start, end, state, district }],
  };
}

/** The members the fixtures file as: a small, fixed stand-in for congress-legislators. */
export const TEST_LEGISLATORS: LegislatorsSnapshot = {
  commit: "0".repeat(40),
  sha256: { current: "0".repeat(64), historical: "0".repeat(64) },
  legislators: [
    rep("P000197", "Nancy", "Pelosi", "CA", 12, "1987-06-02"),
    rep("L000551", "Barbara", "Lee", "CA", 13, "1998-04-07"),
    rep("H000338", "Orrin", "Hatch", "UT", null),
    rep("F000062", "Dianne", "Feinstein", "CA", null),
    {
      bioguide: "E000001", first: "Jamie", middle: null, nickname: null, last: "Example", officialFull: "Jamie Example",
      terms: [{ type: "sen", start: "2019-01-03", end: "2031-01-03", state: "ZZ", district: null }],
    },
    {
      bioguide: "D000001", first: "Jane", middle: null, nickname: null, last: "Doe", officialFull: "Jane Doe",
      terms: [{ type: "sen", start: "2019-01-03", end: "2031-01-03", state: "ZZ", district: null }],
    },
  ],
};

export function testResolver(overrides: readonly MemberOverride[] = []): MemberResolver {
  return new MemberResolver(TEST_LEGISLATORS, overrides);
}

/** A fixture filing and its trades, identified against `TEST_LEGISLATORS`. */
export function identifiedRowsFixture(overrides: Parameters<typeof filingRowsFixture>[0] = {}): IdentifiedFilingRows {
  return identifyFilingRows(filingRowsFixture(overrides), testResolver());
}

export function identifiedLake(
  filings: readonly PoliticalFilingRow[],
  trades: readonly PoliticalTradeRow[],
): ReturnType<typeof identifyPoliticalRows> {
  return identifyPoliticalRows(filings, trades, testResolver());
}
