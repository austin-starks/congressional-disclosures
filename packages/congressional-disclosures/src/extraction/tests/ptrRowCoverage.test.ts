import {
  normalizeOcrWindowRead,
  rowRanges,
  verifyOcrRowCoverage,
  verifyOcrWindowRead,
  type OcrWindowRead,
} from "../ptrRowCoverage";

function transaction(ocrRows: unknown): Record<string, unknown> {
  return { transaction_type_code: "P", ocr_rows: ocrRows };
}

function read(
  sourceId: string,
  first: number,
  last: number,
  rows: Array<Record<string, unknown>>,
  nonTransactionRows: number[] = [],
  continuationRows: number[] = []
): OcrWindowRead {
  return { sourceId, window: { first, last, rowCount: 8 }, rows, nonTransactionRows, continuationRows };
}

describe("ptrRowCoverage", () => {
  it("proves a complete account across windows, including a row that wraps into the next window", () => {
    const reads = [
      read("f:w1", 1, 4, [transaction([2]), transaction([3]), transaction([4, 5])], [1]),
      read("f:w2", 5, 8, [transaction([6]), transaction([8])], [7], [5]),
    ];
    expect(verifyOcrRowCoverage(8, reads)).toEqual([]);
  });

  it("groups rows into ranges of consecutive labels", () => {
    expect(rowRanges([9, 4, 3, 5, 4])).toEqual([
      [3, 5],
      [9, 9],
    ]);
  });

  it("reduces a window read to what its window owns", () => {
    const normalized = normalizeOcrWindowRead(
      read("f:w2", 5, 8, [transaction([3, 4, 5]), transaction([6]), transaction([9])], [2, 7], [1])
    );
    expect(normalized.rows).toEqual([transaction([6])]);
    expect(normalized.continuationRows).toEqual([5]);
    expect(normalized.nonTransactionRows).toEqual([7]);
    expect(verifyOcrWindowRead(normalized)).toEqual(["f:w2 gives no disposition for R8"]);
  });

  it("accepts one OCR row read into two transactions when OCR joined them", () => {
    expect(verifyOcrWindowRead(read("f", 1, 3, [transaction([1, 2]), transaction([2])], [3]))).toEqual([]);
  });

  it("fails a read that stopped partway: rows with no disposition, as ranges", () => {
    const reads = [read("f:w1", 1, 4, [transaction([2])], [1]), read("f:w2", 5, 8, [transaction([8])])];
    expect(verifyOcrRowCoverage(8, reads)).toEqual([
      "f:w1 gives no disposition for R3-R4",
      "f:w2 gives no disposition for R5-R7",
    ]);
  });

  it("rejects contradictions, uncited transactions and rows outside the window or filing", () => {
    const reads = [
      read("f:w1", 1, 4, [transaction([1, 2]), transaction([])], [2, 3, 6]),
      read("f:w2", 5, 8, [transaction([4, 5]), transaction([6, 7, 8]), transaction([9])]),
    ];
    expect(verifyOcrRowCoverage(8, reads)).toEqual([
      "f:w1 transaction 2 cites no OCR rows",
      "f:w1 lists R6 as not a transaction, outside its window",
      "f:w1 reads R2 into a transaction and also lists it as not a transaction",
      "f:w1 gives no disposition for R4",
      "f:w2 transaction 1 starts at R4, outside its window R5-R8",
      "f:w2 transaction 3 cites R9, outside the filing's R1-R8",
      "f:w2 transaction 3 starts at R9, outside its window R5-R8",
      "f:w1 lists R6 as not a transaction, but a transaction from another window includes it",
    ]);
  });

  it("rejects a continuation no earlier transaction backs, and rows that fall in no window", () => {
    const reads = [
      read("f:w1", 1, 4, [transaction([1]), transaction([2]), transaction([3]), transaction([4])]),
      read("f:w2", 5, 7, [transaction([6])], [7], [5, 7]),
    ];
    expect(verifyOcrRowCoverage(8, reads)).toEqual([
      "f:w2 lists R7 as both a continuation and not a transaction",
      "f:w2 lists R5, R7 as a continuation, but no transaction that started before its window includes it",
      "rows in no window: R8",
    ]);
  });
});
