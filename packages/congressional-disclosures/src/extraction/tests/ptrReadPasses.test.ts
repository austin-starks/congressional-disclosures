import { planOcrTextRequests } from "../ocrTextPlan";
import { parsePtrExtractionResponse, ptrSourceExpectations, type PtrBatchResult } from "../ptrExtraction";
import {
  EMPTY_READ_FINDING,
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
  statement?: string;
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
    const { rows, nonTransactionRows, statement } = answer(attachment.sourceId);
    return {
      source_id: attachment.sourceId,
      no_transactions_statement: statement ?? null,
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

  it("reconciles a page both map reads agree on when a date cannot be true, and states why", async () => {
    // Kelly 8219843: OCR read a handwritten 6/1/23 as 6/1/13, the filed page read agreed, and nothing disputed a
    // transaction ten years before the notification date printed beside it.
    const planned = (): PlannedPtrAttachment[][] =>
      planOcrTextRequests(
        [
          {
            filingId: "f",
            pages: [PAGE],
            filedOn: "2023-07-18",
            source: { kind: "images", filed: [Buffer.from("page-1")], rotations: [0], geometries: [null], upright: async (image) => image },
          },
        ],
        { ...BUDGET, maxPagesPerRequest: 10 }
      );
    const dated = (code: string, ocrRows: number[], transactionIso: string): Record<string, unknown> => ({
      ...transaction(code, ocrRows),
      transaction_date_iso: transactionIso,
      notification_date_iso: "2023-07-03",
    });
    const findings: Array<readonly string[]> = [];
    const answer = (_sourceId: string, read: ReadPass): Answer => {
      if (read.pass === 2) return { rows: [dated("S", [], "2013-06-01"), dated("S", [], "2023-06-02")], nonTransactionRows: [] };
      const first = read.pass === 3 ? "2023-06-01" : "2013-06-01";
      return { rows: [dated("S", [3], first), dated("S", [4], "2023-06-02")], nonTransactionRows: [1, 2, 5] };
    };
    const run: RunReadRequests = async (requests, read) => {
      for (const attachment of requests.flat()) {
        if (read.pass === 3) findings.push(attachment.dateFindings ?? []);
      }
      return fakeRun(answer, [])(requests, read);
    };

    const { outcomes, consensus } = await runMapReduceReads(planned(), run, BUDGET);
    expect(findings).toEqual([
      [
        `${MAP_READ_LABELS.text}, the row labeled 3: transaction date 2013-06-01 is more than a year before its notification date 2023-07-03`,
        `${MAP_READ_LABELS.source}, a row on page 1 (Asset): transaction date 2013-06-01 is more than a year before its notification date 2023-07-03`,
      ],
    ]);
    expect(consensus).toMatchObject({ agreed: 0, arbitrated: 1, failed: 0 });
    expect(outcomes[0]!.result?.documents[0]!.rows.map((row) => row.transaction_date_iso)).toEqual([
      "2023-06-01",
      "2023-06-02",
    ]);
  });

  it("keeps agreeing map reads when the reconciling read a date finding asked for fails, and fails a real disagreement", async () => {
    const planned = (): PlannedPtrAttachment[][] =>
      planOcrTextRequests(
        [
          {
            filingId: "f",
            pages: [PAGE],
            filedOn: "2014-09-12",
            source: { kind: "images", filed: [Buffer.from("page-1")], rotations: [0], geometries: [null], upright: async (image) => image },
          },
        ],
        { ...BUDGET, maxPagesPerRequest: 10 }
      );
    // Rogers 8216588 types a notification of 08/29/20 on a 2014 report: a finding every read shares, printed that way.
    const typo = (code: string, ocrRows: number[], transactionIso: string): Record<string, unknown> => ({
      ...transaction(code, ocrRows),
      transaction_date_iso: transactionIso,
      notification_date_iso: "2020-08-29",
    });
    const answer = (sourceB: string) => (_sourceId: string, read: ReadPass): Answer => {
      if (read.pass === 2) return { rows: [typo("P", [], "2014-08-12"), typo("P", [], sourceB)], nonTransactionRows: [] };
      return { rows: [typo("P", [3], "2014-08-12"), typo("P", [4], "2014-08-26")], nonTransactionRows: [1, 2, 5] };
    };
    const failingReconcile = (sourceB: string): RunReadRequests => async (requests, read) =>
      read.pass === 3 ? [] : fakeRun(answer(sourceB), [])(requests, read);

    const kept = await runMapReduceReads(planned(), failingReconcile("2014-08-26"), BUDGET);
    expect(kept.consensus).toMatchObject({ agreed: 1, arbitrated: 0, failed: 0 });
    expect(kept.outcomes[0]!.result?.documents[0]!.rows.map((row) => row.transaction_date_iso)).toEqual([
      "2014-08-12",
      "2014-08-26",
    ]);

    const failed = await runMapReduceReads(planned(), failingReconcile("2014-06-26"), BUDGET);
    expect(failed.consensus).toMatchObject({ agreed: 0, arbitrated: 0, failed: 1 });
  });

  describe("a page the page read lists more transactions on than the OCR text holds rows", () => {
    // Khanna 8218338 page 21: both OCR reads gave only the column headers of a page Read B lists 70 transactions on, so
    // those rows were never read, and nothing compared the two.
    const twoPages = (): PlannedPtrAttachment[][] =>
      planOcrTextRequests(
        [
          {
            filingId: "f",
            pages: [PAGE, ""],
            source: {
              kind: "images",
              filed: [Buffer.from("page-1"), Buffer.from("page-2")],
              rotations: [0, 0],
              geometries: [null, null],
              upright: async (image) => image,
            },
          },
        ],
        { ...BUDGET, maxPagesPerRequest: 10 }
      );
    const reads = (pageTwoRows: number) => (sourceId: string, read: ReadPass): Answer => {
      if (read.pass === 2) {
        return sourceId === "f:s2"
          ? { rows: Array.from({ length: pageTwoRows }, () => transaction("P", [])), nonTransactionRows: [] }
          : { rows: [transaction("P", []), transaction("S", [])], nonTransactionRows: [] };
      }
      return { rows: [transaction("P", [3]), transaction("S", [4])], nonTransactionRows: [1, 2, 5] };
    };

    it("fails the filing when the page read lists transactions there", async () => {
      const calls: string[] = [];
      const { outcomes, consensus } = await runMapReduceReads(twoPages(), fakeRun(reads(3), calls), BUDGET);
      expect(consensus).toMatchObject({ failed: 1 });
      expect(outcomes[0]!.result?.documents[0]!.error).toContain(
        `${MAP_READ_LABELS.source} lists more transactions than the OCR text holds rows on page 2 (3 listed, 0 OCR table rows)`
      );
      expect(calls.some((call) => call.startsWith("3:") || call.startsWith("4:"))).toBe(false);
    });

    it("accepts the filing when the page read lists no more than two rows the OCR text lacks", async () => {
      const { consensus } = await runMapReduceReads(twoPages(), fakeRun(reads(2), []), BUDGET);
      expect(consensus).toMatchObject({ agreed: 1, failed: 0 });
    });
  });

  describe("repair reads", () => {
    const planned = (): PlannedPtrAttachment[][] =>
      planOcrTextRequests(
        [
          {
            filingId: "f",
            pages: [PAGE],
            source: { kind: "images", filed: [Buffer.from("page-1")], rotations: [0], geometries: [null], upright: async (image) => image },
          },
        ],
        { ...BUDGET, maxPagesPerRequest: 10 }
      );
    const withAsset = (row: Record<string, unknown>, asset: string): Record<string, unknown> => ({ ...row, asset_description: asset });

    it("reads a window again when both reads agree on a row with no asset name, and takes the repeated asset", async () => {
      // Lance 9108075: row 2's asset cell is a ditto mark under a DJIA put, and both reads left it blank.
      const repairs: Array<readonly string[]> = [];
      const answer = (_sourceId: string, read: ReadPass): Answer => {
        const ocrRows = (row: number): number[] => (read.pass === 2 ? [] : [row]);
        const second = read.pass === 4 ? "DJIA Index Option Put" : "";
        return {
          rows: [withAsset(transaction("P", ocrRows(3)), "DJIA Index Option Put"), withAsset(transaction("S", ocrRows(4)), second)],
          nonTransactionRows: read.pass === 2 ? [] : [1, 2, 5],
        };
      };
      const run: RunReadRequests = async (requests, read) => {
        for (const attachment of requests.flat()) if (read.pass === 4) repairs.push(attachment.assetFindings ?? []);
        return fakeRun(answer, [])(requests, read);
      };

      const { outcomes, consensus } = await runMapReduceReads(planned(), run, BUDGET);
      expect(repairs).toEqual([["the row labeled 4 has no asset name"]]);
      expect(consensus).toMatchObject({ agreed: 0, arbitrated: 1, failed: 0 });
      expect(outcomes[0]!.result?.documents[0]!.rows.map((row) => row.asset_description)).toEqual([
        "DJIA Index Option Put",
        "DJIA Index Option Put",
      ]);
    });

    it("keeps the decided read when the repair still leaves a row without an asset name", async () => {
      const answer = (_sourceId: string, read: ReadPass): Answer => ({
        rows: [transaction("P", read.pass === 2 ? [] : [3]), withAsset(transaction("S", read.pass === 2 ? [] : [4]), "")],
        nonTransactionRows: read.pass === 2 ? [] : [1, 2, 5],
      });
      const { outcomes, consensus } = await runMapReduceReads(planned(), fakeRun(answer, []), BUDGET);
      expect(consensus).toMatchObject({ agreed: 1, arbitrated: 0 });
      expect(outcomes[0]!.result?.documents[0]!.rows[1]!.asset_description).toBe("");
    });

    it("reads an empty report again with the empty-read finding, and takes the statement the repair copies", async () => {
      // McCaul 9107269: a letter correcting the IPO box of an earlier report, with no transaction of its own.
      const repairs: Array<readonly string[]> = [];
      const answer = (_sourceId: string, read: ReadPass): Answer =>
        read.pass === 4
          ? { rows: [], nonTransactionRows: [1, 2, 3, 4, 5], statement: "the IPO box was inadvertently checked yes" }
          : { rows: [], nonTransactionRows: read.pass === 2 ? [] : [1, 2, 3, 4, 5] };
      const run: RunReadRequests = async (requests, read) => {
        for (const attachment of requests.flat()) if (read.pass === 4) repairs.push(attachment.emptyReadFindings ?? []);
        return fakeRun(answer, [])(requests, read);
      };

      const { outcomes } = await runMapReduceReads(planned(), run, BUDGET);
      expect(repairs).toEqual([[EMPTY_READ_FINDING]]);
      expect(outcomes[0]!.result?.documents[0]!.noTransactionsStatement).toBe("the IPO box was inadvertently checked yes");
    });

    describe("a reconciled date Read A reads without a finding", () => {
      // Khanna 8219417: pages 5 and 7 print 03/01/23, Read A gives it, Read B read 09/01/23, and the reconciling read
      // kept 09/01/23, six months after the report was filed on 3/3/23.
      const filed = (): PlannedPtrAttachment[][] =>
        planOcrTextRequests(
          [
            {
              filingId: "f",
              pages: [PAGE],
              filedOn: "2023-03-03",
              source: { kind: "images", filed: [Buffer.from("page-1")], rotations: [0], geometries: [null], upright: async (image) => image },
            },
          ],
          { ...BUDGET, maxPagesPerRequest: 10 }
        );
      const notified = (ocrRows: number[], notification: string): Record<string, unknown> => ({
        ...transaction("P", ocrRows),
        transaction_date_iso: "2023-02-14",
        notification_date_iso: notification,
      });
      const reads = (repairDate: string) => (_sourceId: string, read: ReadPass): Answer => {
        if (read.pass === 1) return { rows: [notified([3], "2023-03-01"), notified([4], "2023-03-01")], nonTransactionRows: [1, 2, 5] };
        if (read.pass === 2) return { rows: [notified([], "2023-03-01"), notified([], "2023-09-01")], nonTransactionRows: [] };
        const second = read.pass === 3 ? "2023-09-01" : repairDate;
        return { rows: [notified([3], "2023-03-01"), notified([4], second)], nonTransactionRows: [1, 2, 5] };
      };

      it("reads the window again with the kept date stated, and takes the date the repair reads", async () => {
        const repairs: Array<readonly string[]> = [];
        const run: RunReadRequests = async (requests, read) => {
          for (const attachment of requests.flat()) if (read.pass === 4) repairs.push(attachment.keptDateFindings ?? []);
          return fakeRun(reads("2023-03-01"), [])(requests, read);
        };

        const { outcomes, consensus } = await runMapReduceReads(filed(), run, BUDGET);
        expect(repairs).toEqual([
          [
            `the row labeled 4: notification date 2023-09-01 is more than a month after the report was filed on 2023-03-03, ` +
              `where ${MAP_READ_LABELS.text} gives transaction date 2023-02-14 and notification date 2023-03-01`,
          ],
        ]);
        expect(consensus).toMatchObject({ arbitrated: 1, failed: 0 });
        expect(outcomes[0]!.result?.documents[0]!.rows.map((row) => row.notification_date_iso)).toEqual([
          "2023-03-01",
          "2023-03-01",
        ]);
      });

      it("keeps the reconciled date when the repair, shown Read A's, keeps it too", async () => {
        // Kelly 9108306: a handwritten 1/17/14 that OCR read as 11/7/14, on a report of dates a year old.
        const { outcomes, consensus } = await runMapReduceReads(filed(), fakeRun(reads("2023-09-01"), []), BUDGET);
        expect(consensus).toMatchObject({ arbitrated: 1, failed: 0 });
        expect(outcomes[0]!.result?.documents[0]!.rows[1]!.notification_date_iso).toBe("2023-09-01");
      });

      it("never repairs for a date Read A leaves blank", async () => {
        // Upton 9113583: Read A gave the row no transaction date, which no date check can flag.
        const calls: string[] = [];
        const blank = (sourceId: string, read: ReadPass): Answer => {
          const answer = reads("2023-03-01")(sourceId, read);
          if (read.pass !== 1) return answer;
          return { ...answer, rows: [answer.rows[0]!, { ...answer.rows[1]!, notification_date_iso: null }] };
        };
        await runMapReduceReads(filed(), fakeRun(blank, calls), BUDGET);
        expect(calls.some((call) => call.startsWith("4:"))).toBe(false);
      });

      it("leaves a reconciled date Read A flags too, since the page may print it", async () => {
        const calls: string[] = [];
        const flagged = (_sourceId: string, read: ReadPass): Answer =>
          read.pass === 2
            ? { rows: [notified([], "2023-09-01"), notified([], "2023-03-01")], nonTransactionRows: [] }
            : { rows: [notified([3], "2023-09-01"), notified([4], "2023-03-01")], nonTransactionRows: [1, 2, 5] };
        const { consensus } = await runMapReduceReads(filed(), fakeRun(flagged, calls), BUDGET);
        expect(calls.some((call) => call.startsWith("4:"))).toBe(false);
        expect(consensus).toMatchObject({ arbitrated: 1, failed: 0 });
      });
    });

    it("never repairs a filing whose reads already pass", async () => {
      const calls: string[] = [];
      const answer = (_sourceId: string, read: ReadPass): Answer => ({
        rows: [transaction("P", read.pass === 2 ? [] : [3]), transaction("S", read.pass === 2 ? [] : [4])],
        nonTransactionRows: read.pass === 2 ? [] : [1, 2, 5],
      });
      await runMapReduceReads(planned(), fakeRun(answer, calls), BUDGET);
      expect(calls.some((call) => call.startsWith("4:"))).toBe(false);
    });
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
