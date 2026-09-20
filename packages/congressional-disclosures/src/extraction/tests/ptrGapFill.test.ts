import type { PtrDocumentResult, PtrRowWindow } from "../ptrExtraction";
import { gapFillRanges, mergeGapFills } from "../ptrGapFill";
import { ocrCoverageError } from "../ptrRowCoverage";

const WINDOW: PtrRowWindow = { first: 1, last: 6, rowCount: 6 };

function transaction(ocrRows: number[]): Record<string, unknown> {
  return {
    transaction_type_code: "P",
    transaction_date: "04/01/22",
    transaction_date_iso: "2022-04-01",
    asset_description: "Example Asset",
    ticker: null,
    asset_type_code: null,
    amount_bracket: "$1,001 - $15,000",
    amount_category: "$1,001 - $15,000",
    amount_exact: null,
    ocr_rows: ocrRows,
  };
}

/** A read of `window`, carrying the coverage error parsing would give it unless `error` is supplied. */
function read(
  sourceId: string,
  window: PtrRowWindow,
  rows: Array<Record<string, unknown>>,
  lists: { nonTransactionRows?: number[]; continuationRows?: number[]; error?: string | null } = {}
): PtrDocumentResult {
  const nonTransactionRows = lists.nonTransactionRows ?? [];
  const continuationRows = lists.continuationRows ?? [];
  return {
    sourceId,
    rows,
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows,
    continuationRows,
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error:
      lists.error !== undefined
        ? lists.error
        : ocrCoverageError({ sourceId, window, rows, nonTransactionRows, continuationRows }),
  };
}

describe("ptrGapFill", () => {
  it("asks for a gap read only when rows without a disposition are the read's sole defect", () => {
    expect(gapFillRanges(WINDOW, read("w", WINDOW, [transaction([1]), transaction([3]), transaction([6])]))).toEqual([
      { first: 2, last: 2, rowCount: 6 },
      { first: 4, last: 5, rowCount: 6 },
    ]);
    const contradiction = read("w", WINDOW, [transaction([1]), transaction([2]), transaction([6])], {
      nonTransactionRows: [2],
    });
    expect(gapFillRanges(WINDOW, contradiction)).toEqual([]);
    const omitted = read("w", WINDOW, [], { error: "response omitted source_id" });
    expect(gapFillRanges(WINDOW, omitted)).toEqual([]);
    expect(gapFillRanges(WINDOW, read("w", WINDOW, [transaction([1, 2, 3, 4, 5, 6])]))).toEqual([]);
  });

  it("merges a gap read and proves the window again", () => {
    const base = read("w", WINDOW, [transaction([1]), transaction([2]), transaction([6])]);
    const gap = { first: 3, last: 5, rowCount: 6 };
    const merged = mergeGapFills(WINDOW, base, [
      { window: gap, result: read("w:g3-5", gap, [transaction([5])], { nonTransactionRows: [4], continuationRows: [3] }) },
    ]);
    expect(merged.error).toBeNull();
    expect(merged.rows.map((row) => row.ocr_rows)).toEqual([[1], [2, 3], [5], [6]]);
    expect(merged.nonTransactionRows).toEqual([4]);
    expect(merged.continuationRows).toEqual([]);
    expect(merged.invalidRowIndexes).toEqual([]);
  });

  it("fails a merge whose continuation has no transaction directly above it, or whose gap read failed", () => {
    const base = read("w", WINDOW, [transaction([1]), transaction([6])], { nonTransactionRows: [2] });
    const gap = { first: 3, last: 5, rowCount: 6 };
    const orphan = mergeGapFills(WINDOW, base, [
      { window: gap, result: read("w:g3-5", gap, [], { nonTransactionRows: [4, 5], continuationRows: [3] }) },
    ]);
    expect(orphan.error).toBe("OCR row coverage: gap read R3-R5 continues R2, which no transaction includes");

    const missing = mergeGapFills(WINDOW, base, [{ window: gap, result: undefined }]);
    expect(missing.error).toBe(`${base.error}; gap read R3-R5: no result`);
    expect(missing.rows).toBe(base.rows);
  });
});
