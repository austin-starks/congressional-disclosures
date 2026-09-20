import { planOcrTextRequests } from "../ocrTextPlan";
import { parsePtrExtractionResponse, ptrSourceExpectations, type PtrBatchResult } from "../ptrExtraction";
import {
  MAP_READ_LABELS,
  runExtractionReads,
  runMapReduceReads,
  type ReadPass,
  type RunReadRequests,
} from "../ptrReadPasses";
import type { PlannedPtrAttachment } from "../ptrRequestPlan";

/** Labels: R1 text line, R2 column labels, R3 and R4 transactions, R5 page footer. */
const PAGE = [
  "NAME: Filer",
  "",
  "| Owner | Asset | Date |",
  "| --- | --- | --- |",
  "| SP | Apple Inc | 04/01/22 |",
  "| SP | Microsoft Corp | 04/02/22 |",
  "",
  "Page 1 of 1",
].join("\n");

const BUDGET = { maxTableRowsPerWindow: 20, maxRowsPerWindow: 120, maxTableRowsPerRequest: 40, maxAttachmentsPerRequest: 10 };

interface Answer {
  rows: Array<Record<string, unknown>>;
  nonTransactionRows: number[];
}

function transaction(code: string, ocrRows: number[]): Record<string, unknown> {
  return {
    transaction_type_code: code,
    transaction_date: "04/01/22",
    transaction_date_iso: "2022-04-01",
    asset_description: "Asset",
    ticker: null,
    asset_type_code: null,
    amount_bracket: "$1,001 - $15,000",
    amount_category: "$1,001 - $15,000",
    amount_exact: null,
    ocr_rows: ocrRows,
  };
}

function requests(): PlannedPtrAttachment[][] {
  return planOcrTextRequests([{ filingId: "f", pages: [PAGE] }], BUDGET);
}

function batch(request: PlannedPtrAttachment[], answer: (sourceId: string) => Answer): PtrBatchResult {
  const documents = request.map((attachment) => {
    const { rows, nonTransactionRows } = answer(attachment.sourceId);
    return {
      source_id: attachment.sourceId,
      no_transactions_statement: null,
      amended_report_date: null,
      amended_report_date_iso: null,
      non_transaction_rows: nonTransactionRows,
      continuation_rows: [],
      rows,
    };
  });
  const rawResponse = { choices: [{ message: { content: JSON.stringify({ documents }) } }] };
  const parsed = parsePtrExtractionResponse(
    rawResponse,
    request.map((attachment) => attachment.sourceId),
    ptrSourceExpectations(request)
  );
  return {
    ...parsed,
    contractVersion: "test",
    requestedModel: "test",
    servedModel: "test",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    latencyMs: 1,
    rawResponse,
  };
}

function fakeRun(answers: (sourceId: string, read: ReadPass) => Answer, calls: string[]): RunReadRequests {
  return async (planned, read) =>
    planned.map((request) => {
      calls.push(`${read.pass}${read.gap ? "g" : ""}:${request.map((attachment) => attachment.sourceId).join(",")}`);
      return {
        attachments: request.map(({ sourceId, filingId, pageStart, pageEnd, totalPages, rowWindow }) => ({
          sourceId,
          filingId,
          pageStart,
          pageEnd,
          totalPages,
          ...(rowWindow ? { rowWindow } : {}),
        })),
        result: batch(request, (sourceId) => answers(sourceId, read)),
      };
    });
}

describe("ptrReadPasses", () => {
  it("gap-reads rows a read left without a disposition, then accepts agreeing reads", async () => {
    const calls: string[] = [];
    const rows = [transaction("P", [3]), transaction("S", [4])];
    const run = fakeRun((sourceId, read) => {
      if (sourceId === "f:g5-5") return { rows: [], nonTransactionRows: [5] };
      return { rows, nonTransactionRows: read.pass === 1 ? [1, 2] : [1, 2, 5] };
    }, calls);
    const { outcomes, consensus } = await runExtractionReads(requests(), 2, run);
    expect(calls).toEqual(["1:f", "1g:f:g5-5", "2:f"]);
    expect(consensus).toMatchObject({ agreed: 1, arbitrated: 0, failed: 0, laterReads:0, gapReads: 1 });
    const [document] = outcomes[0]!.result?.documents ?? [];
    expect(document!.error).toBeNull();
    expect(document!.nonTransactionRows).toEqual([1, 2, 5]);
  });

  it("reads an attachment a third time when its two reads disagree", async () => {
    const calls: string[] = [];
    const run = fakeRun(
      (_sourceId, read) => ({
        rows: [transaction(read.pass === 2 ? "E" : "P", [3]), transaction("S", [4])],
        nonTransactionRows: [1, 2, 5],
      }),
      calls
    );
    const { outcomes, consensus } = await runExtractionReads(requests(), 2, run);
    expect(calls).toEqual(["1:f", "2:f", "3:f"]);
    expect(consensus).toMatchObject({ agreed: 0, arbitrated: 1, failed: 0, laterReads:1, gapReads: 0 });
    expect(outcomes[0]!.result?.documents[0]!.rows[0]!.transaction_type_code).toBe("P");
  });

  it("decides a row window row by row when each read slips on a different row", async () => {
    const calls: string[] = [];
    const run = fakeRun(
      (_sourceId, read) => ({
        rows: [transaction(read.pass === 2 ? "E" : "P", [3]), transaction(read.pass === 3 ? "E" : "S", [4])],
        nonTransactionRows: [1, 2, 5],
      }),
      calls
    );
    const { outcomes, consensus } = await runExtractionReads(requests(), 2, run);
    expect(calls).toEqual(["1:f", "2:f", "3:f"]);
    expect(consensus).toMatchObject({ agreed: 0, arbitrated: 1, failed: 0, laterReads:1 });
    const [document] = outcomes[0]!.result?.documents ?? [];
    expect(document!.error).toBeNull();
    expect(document!.rows.map((row) => row.transaction_type_code)).toEqual(["P", "S"]);
  });

  it("reads an undecided window again until a later read agrees with an earlier one", async () => {
    const calls: string[] = [];
    const byPass: Record<number, [string, string]> = { 1: ["P", "S"], 2: ["E", "P"], 3: ["S", "E"], 4: ["P", "S"] };
    const run = fakeRun(
      (_sourceId, read) => ({
        rows: [transaction(byPass[read.pass]![0]!, [3]), transaction(byPass[read.pass]![1]!, [4])],
        nonTransactionRows: [1, 2, 5],
      }),
      calls
    );
    const { outcomes, consensus } = await runExtractionReads(requests(), 2, run);
    expect(calls).toEqual(["1:f", "2:f", "3:f", "4:f"]);
    expect(consensus).toMatchObject({ agreed: 0, arbitrated: 1, failed: 0, laterReads: 2 });
    expect(outcomes[0]!.result?.documents[0]!.rows.map((row) => row.transaction_type_code)).toEqual(["P", "S"]);
  });

  it("stops at the read limit and fails a window no two reads agree on", async () => {
    const calls: string[] = [];
    // Every read states a different date on each row, so no two reads agree on any row.
    const run = fakeRun(
      (_sourceId, read) => ({
        rows: [
          { ...transaction("P", [3]), transaction_date_iso: `2022-04-0${read.pass}` },
          { ...transaction("S", [4]), transaction_date_iso: `2022-04-1${read.pass}` },
        ],
        nonTransactionRows: [1, 2, 5],
      }),
      calls
    );
    const { consensus } = await runExtractionReads(requests(), 2, run);
    expect(calls).toEqual(["1:f", "2:f", "3:f", "4:f", "5:f"]);
    expect(consensus).toMatchObject({ agreed: 0, arbitrated: 0, failed: 1, laterReads: 3 });
  });

  it("map-reduces a scan: its OCR text, each filed page alone, and a reconciling read of a page they disagree on", async () => {
    const filed = (): PlannedPtrAttachment[][] =>
      planOcrTextRequests([{ filingId: "f", pages: [PAGE], source: { kind: "images", filed: [Buffer.from("page-1")], rotations: [0], geometries: [null], upright: async (image) => image } }], {
        ...BUDGET,
        maxPagesPerRequest: 10,
      });
    const dated = (code: string, ocrRows: number[], iso: string): Record<string, unknown> => ({
      ...transaction(code, ocrRows),
      transaction_date_iso: iso,
    });
    const recording = (answer: (sourceId: string, read: ReadPass) => Answer) => {
      const seen: Array<{ pass: number; ocrText: boolean; images: number; priorReads: string[] }> = [];
      const run: RunReadRequests = async (planned, read) => {
        seen.push(
          ...planned.flat().map((attachment) => ({
            pass: read.pass,
            ocrText: attachment.ocrPages !== undefined,
            images: attachment.pageImages?.length ?? 0,
            priorReads: attachment.priorReads?.map((prior) => prior.label) ?? [],
          }))
        );
        return fakeRun(answer, [])(planned, read);
      };
      return { run, seen };
    };

    // The OCR text copies one date down the column, the filed page read misreads the second row's day, and the
    // reconciling read gives the printed dates, one of which neither map read gave.
    const disputed = recording((_sourceId, read) => {
      if (read.pass === 2) return { rows: [dated("P", [], "2022-04-13"), dated("S", [], "2022-04-19")], nonTransactionRows: [] };
      const dates = read.pass === 1 ? ["2021-04-21", "2021-04-21"] : ["2022-04-13", "2022-04-21"];
      return { rows: [dated("P", [3], dates[0]!), dated("S", [4], dates[1]!)], nonTransactionRows: [1, 2, 5] };
    });
    const { outcomes, consensus } = await runMapReduceReads(filed(), disputed.run, BUDGET);
    expect([...disputed.seen].sort((left, right) => left.pass - right.pass)).toEqual([
      { pass: 1, ocrText: true, images: 0, priorReads: [] },
      { pass: 2, ocrText: false, images: 1, priorReads: [] },
      { pass: 3, ocrText: true, images: 1, priorReads: [MAP_READ_LABELS.text, MAP_READ_LABELS.source] },
    ]);
    expect(consensus).toMatchObject({ agreed: 0, arbitrated: 1, failed: 0, laterReads: 1 });
    expect(outcomes[0]!.result?.documents[0]!.rows.map((row) => row.transaction_date_iso)).toEqual([
      "2022-04-13",
      "2022-04-21",
    ]);

    // Reads that list the same transactions for the page are accepted without a reconciling read.
    const agreeing = recording((_sourceId, read) =>
      read.pass === 2
        ? { rows: [dated("S", [], "2022-04-21"), dated("P", [], "2022-04-13")], nonTransactionRows: [] }
        : { rows: [dated("P", [3], "2022-04-13"), dated("S", [4], "2022-04-21")], nonTransactionRows: [1, 2, 5] }
    );
    const agreed = await runMapReduceReads(filed(), agreeing.run, BUDGET);
    expect(agreeing.seen.map((call) => call.pass).sort()).toEqual([1, 2]);
    expect(agreed.consensus).toMatchObject({ agreed: 1, arbitrated: 0, failed: 0, laterReads: 0 });
  });

  it("returns a single read without consensus", async () => {
    const calls: string[] = [];
    const run = fakeRun(() => ({ rows: [transaction("P", [3]), transaction("S", [4])], nonTransactionRows: [1, 2, 5] }), calls);
    const { outcomes, consensus } = await runExtractionReads(requests(), 1, run);
    expect(calls).toEqual(["1:f"]);
    expect(consensus).toBeNull();
    expect(outcomes[0]!.result?.documents[0]!.error).toBeNull();
  });
});
