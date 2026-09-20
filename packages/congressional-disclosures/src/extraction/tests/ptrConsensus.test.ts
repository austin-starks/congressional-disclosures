import { decidePtrConsensus, idsNeedingThirdRead, ptrDocumentSignature } from "../ptrConsensus";
import type { PtrDocumentResult } from "../ptrExtraction";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_type_code: "P",
    transaction_date: "10/5/20",
    transaction_date_iso: "2020-10-05",
    asset_description: "MICROSOFT CORP GLB 03.625%",
    ticker: null,
    asset_type_code: null,
    amount_bracket: "$1,001 - $15,000",
    amount_category: "$1,001 - $15,000",
    amount_exact: null,
    amount_low: 1001,
    amount_high: 15000,
    ocr_rows: [4],
    ...overrides,
  };
}

function read(id: string, rows: Array<Record<string, unknown>>, extra: Partial<PtrDocumentResult> = {}): PtrDocumentResult {
  return {
    sourceId: id,
    rows,
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows: [],
    continuationRows: [],
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error: null,
    ...extra,
  };
}

describe("ptrConsensus", () => {
  it("compares stated values exactly and ignores printed text and asset spelling", () => {
    const base = ptrDocumentSignature(read("a", [row()]));
    expect(ptrDocumentSignature(read("a", [row({ asset_description: "MICR0SOFT", transaction_date: "10/05/2020" })]))).toBe(base);
    expect(ptrDocumentSignature(read("a", [row({ transaction_date_iso: "2020-10-15" })]))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row({ transaction_type_code: "S" })]))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row({ amount_low: 15001, amount_high: 50000 })]))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row({ ocr_rows: [5] })]))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row({ owner: "spouse" })]))).not.toBe(
      ptrDocumentSignature(read("a", [row({ owner: "not_indicated" })]))
    );
    expect(ptrDocumentSignature(read("a", [row({ partial_sale: true })]))).not.toBe(
      ptrDocumentSignature(read("a", [row({ partial_sale: false })]))
    );
    expect(ptrDocumentSignature(read("a", [row(), row()]))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row()], { nonTransactionRows: [1] }))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row()], { continuationRows: [3] }))).not.toBe(base);
    expect(ptrDocumentSignature(read("a", [row()], { error: "OCR row coverage: rows not accounted for: R3" }))).toBeNull();
  });

  it("accepts agreeing reads, arbitrates a disagreement, and fails when no two agree", () => {
    const ids = ["agree", "split", "chaos", "missing"];
    const first = new Map([
      ["agree", read("agree", [row()])],
      ["split", read("split", [row()])],
      ["chaos", read("chaos", [row()])],
    ]);
    const second = new Map([
      ["agree", read("agree", [row({ asset_description: "other spelling" })])],
      ["split", read("split", [row({ transaction_type_code: "S" })])],
      ["chaos", read("chaos", [row({ transaction_type_code: "S" })])],
      ["missing", read("missing", [row()])],
    ]);
    expect(idsNeedingThirdRead(ids, first, second)).toEqual(["split", "chaos", "missing"]);

    const third = new Map([
      ["split", read("split", [row({ transaction_type_code: "S" })])],
      ["chaos", read("chaos", [row({ transaction_type_code: "E" })])],
    ]);
    const decisions = decidePtrConsensus(ids, [first, second, third]);
    expect(decisions.map((d) => d.outcome)).toEqual(["agreed", "arbitrated", "failed", "failed"]);
    expect(decisions[1]!.result.rows[0]!.transaction_type_code).toBe("S");
    expect(decisions[2]!.result.error).toBe("no two of 3 extraction reads agreed");
    expect(decisions[3]!.result.error).toBe("first two extraction reads disagreed and no later read ran");
  });

  it("lets a later read decide by agreeing with any earlier read", () => {
    const reads = [
      new Map([["chaos", read("chaos", [row()])]]),
      new Map([["chaos", read("chaos", [row({ transaction_type_code: "S" })])]]),
      new Map([["chaos", read("chaos", [row({ transaction_type_code: "E" })])]]),
      new Map([["chaos", read("chaos", [row({ transaction_type_code: "S" })])]]),
    ];
    const [decision] = decidePtrConsensus(["chaos"], reads);
    expect(decision!.outcome).toBe("arbitrated");
    expect(decision!.result.rows[0]!.transaction_type_code).toBe("S");
  });

  describe("row windows", () => {
    const windows = new Map([["w", { first: 4, last: 6, rowCount: 6 }]]);
    const p4 = row({ ocr_rows: [4] });
    const s5 = row({ transaction_type_code: "S", ocr_rows: [5] });
    const b6 = row({ amount_low: 15001, amount_high: 50000, ocr_rows: [6] });
    const once = (result: PtrDocumentResult) => new Map([["w", result]]);
    const summary = (result: PtrDocumentResult) =>
      result.rows.map((r) => [r.transaction_type_code, r.amount_low, r.ocr_rows]);

    it("keeps every transaction two reads state identically when no two whole reads agree", () => {
      const [decision] = decidePtrConsensus(
        ["w"],
        [
          once(read("w", [p4, s5, b6])),
          once(read("w", [p4, row({ transaction_type_code: "P", ocr_rows: [5] }), b6])),
          once(read("w", [row({ amount_low: 15001, amount_high: 50000, ocr_rows: [4] }), s5, row({ ocr_rows: [6] })])),
        ],
        windows
      );
      expect(decision!.outcome).toBe("arbitrated");
      expect(summary(decision!.result)).toEqual([
        ["P", 1001, [4]],
        ["S", 1001, [5]],
        ["P", 15001, [6]],
      ]);
      expect(decision!.result.error).toBeNull();
    });

    it("takes a row's disposition only from two reads that state it", () => {
      const [decision] = decidePtrConsensus(
        ["w"],
        [
          once(read("w", [p4, s5], { nonTransactionRows: [6] })),
          once(read("w", [p4, row({ transaction_type_code: "P", ocr_rows: [5] })], { nonTransactionRows: [6] })),
          once(read("w", [p4, s5, b6])),
        ],
        windows
      );
      expect(decision!.outcome).toBe("arbitrated");
      expect(summary(decision!.result)).toEqual([
        ["P", 1001, [4]],
        ["S", 1001, [5]],
      ]);
      expect(decision!.result.nonTransactionRows).toEqual([6]);
    });

    it("fails the window when a row has no two reads that agree", () => {
      const [decision] = decidePtrConsensus(
        ["w"],
        [
          once(read("w", [p4, s5, b6])),
          once(read("w", [p4, row({ transaction_type_code: "P", ocr_rows: [5] }), b6])),
          once(read("w", [p4, row({ transaction_type_code: "E", ocr_rows: [5] }), row({ ocr_rows: [6] })])),
        ],
        windows
      );
      expect(decision!.outcome).toBe("failed");
      expect(decision!.result.error).toMatch(/^no two of 3 extraction reads agreed row by row: /);
      expect(decision!.result.error).toContain("R5");
    });

    it("never assembles a row from fields of different reads", () => {
      // Each read slips on a different field of R5; no two state the whole row alike.
      const [decision] = decidePtrConsensus(
        ["w"],
        [
          once(read("w", [p4, s5, b6])),
          once(read("w", [p4, row({ transaction_type_code: "P", amount_low: 15001, amount_high: 50000, ocr_rows: [5] }), b6])),
          once(read("w", [p4, row({ transaction_type_code: "S", amount_low: 15001, amount_high: 50000, ocr_rows: [5] }), b6])),
        ],
        windows
      );
      expect(decision!.outcome).toBe("failed");
    });

    it("never votes rows for a source without a row window", () => {
      const [decision] = decidePtrConsensus(["w"], [
        once(read("w", [p4, s5, b6])),
        once(read("w", [p4, row({ transaction_type_code: "P", ocr_rows: [5] }), b6])),
        once(read("w", [row({ amount_low: 15001, amount_high: 50000, ocr_rows: [4] }), s5, row({ ocr_rows: [6] })])),
      ]);
      expect(decision!.outcome).toBe("failed");
      expect(decision!.result.error).toBe("no two of 3 extraction reads agreed");
    });
  });
});
