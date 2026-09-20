import { PDFDocument } from "pdf-lib";

import { extractHouseFilings, type OcrPageRead } from "../houseFilingExtraction";
import { parsePtrExtractionResponse, ptrSourceExpectations, type PtrBatchResult } from "../ptrExtraction";
import type { RunReadRequests } from "../ptrReadPasses";
import type { PlannedPtrAttachment } from "../ptrRequestPlan";

/** Labels: R1 text line, R2 column labels, R3 and R4 transactions, R5 page footer. */
const SCAN_PAGE = [
  "NAME: Filer",
  "",
  "| Owner | Asset | Date |",
  "| --- | --- | --- |",
  "| SP | Apple Inc | 04/01/22 |",
  "| SP | Microsoft Corp | 04/02/22 |",
  "",
  "Page 1 of 1",
].join("\n");

const BUDGETS = {
  pdf: { maxPagesPerAttachment: 1000, maxPagesPerRequest: 40, maxAttachmentsPerRequest: 10 },
  ocrText: { maxTableRowsPerWindow: 20, maxRowsPerWindow: 120, maxTableRowsPerRequest: 40, maxAttachmentsPerRequest: 10 },
};

const OCR_PAGE: OcrPageRead = {
  rotation: 270,
  scores: [
    { rotation: 0, confidentLetters: 3 },
    { rotation: 90, confidentLetters: 6 },
    { rotation: 180, confidentLetters: 4 },
    { rotation: 270, confidentLetters: 160 },
  ],
  decidedBy: "letters",
  payload: { pages: [{ index: 0, markdown: SCAN_PAGE }] },
  checkPayload: { pages: [{ index: 0, markdown: SCAN_PAGE }] },
  markdown: SCAN_PAGE,
};

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

async function onePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  return Buffer.from(await document.save());
}

/** A complete read of every source: the scan's labeled rows, the same transactions read from its filed page, or one transaction for a PDF. */
function batch(request: PlannedPtrAttachment[]): PtrBatchResult {
  const documents = request.map((attachment) => ({
    source_id: attachment.sourceId,
    no_transactions_statement: null,
    amended_report_date: null,
    amended_report_date_iso: null,
    non_transaction_rows: attachment.rowWindow ? [1, 2, 5] : [],
    continuation_rows: [],
    rows: attachment.rowWindow
      ? [transaction("P", [3]), transaction("S", [4])]
      : attachment.pages
        ? [transaction("P", []), transaction("S", [])]
        : [transaction("P", [])],
  }));
  const rawResponse = { choices: [{ message: { content: JSON.stringify({ documents }) } }] };
  return {
    ...parsePtrExtractionResponse(
      rawResponse,
      request.map((attachment) => attachment.sourceId),
      ptrSourceExpectations(request)
    ),
    contractVersion: "test",
    requestedModel: "test",
    servedModel: "test",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    latencyMs: 1,
    rawResponse,
  };
}

const run: RunReadRequests = async (requests) =>
  requests.map((request) => ({
    attachments: request.map(({ sourceId, filingId, pageStart, pageEnd, totalPages, rowWindow }) => ({
      sourceId,
      filingId,
      pageStart,
      pageEnd,
      totalPages,
      ...(rowWindow ? { rowWindow } : {}),
    })),
    result: batch(request),
  }));

describe("houseFilingExtraction", () => {
  it("sends a text-layer PDF as a PDF and a scan through upright OCR and its upright filed page, then decides both", async () => {
    const textPdf = await onePagePdf();
    const scanPdf = await onePagePdf();
    const ocrLabels: string[] = [];
    const sent: PlannedPtrAttachment[] = [];
    const { extractions, consensus } = await extractHouseFilings(
      [
        { filingId: "text", pdf: textPdf },
        { filingId: "scan", pdf: scanPdf },
      ],
      {
        readPath: async (pdf) => (pdf === scanPdf ? "page_image_ocr" : "text_layer"),
        renderPages: async () => [{ image: Buffer.from("page-1"), checkImage: Buffer.from("page-1-check") }],
        ocrPage: async (_page, label) => {
          ocrLabels.push(label);
          return OCR_PAGE;
        },
        run: async (requests, read) => {
          sent.push(...requests.flat());
          return run(requests, read);
        },
      },
      BUDGETS,
      2
    );

    expect(ocrLabels).toEqual(["scan page 1"]);
    // The scan's filed page is read without its OCR text, turned upright as the orientation vote turned it.
    const sourceRead = sent.find((attachment) => attachment.sourceId === "scan:s1");
    expect(sourceRead?.ocrPages).toBeUndefined();
    expect((await PDFDocument.load(sourceRead?.pdf ?? Buffer.alloc(0))).getPage(0).getRotation().angle).toBe(270);
    expect(
      extractions.map((extraction) => [
        extraction.filingId,
        extraction.parseMethod,
        extraction.result.error,
        extraction.result.rows.length,
      ])
    ).toEqual([
      ["text", "text", null, 1],
      ["scan", "scan", null, 2],
    ]);
    expect(extractions[0]!.ocrPages).toBeNull();
    expect(extractions[1]!.ocrPages?.[0]!.rotation).toBe(270);
    expect(consensus).toMatchObject({ agreed: 2, arbitrated: 0, failed: 0, laterReads: 0, gapReads: 0 });
  });

  it("halves a text-layer filing's page ranges until no read is cut off at the token limit", async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page < 4; page++) document.addPage([200, 200]);
    const longPdf = Buffer.from(await document.save());
    const shortPdf = await onePagePdf();
    const sent: string[] = [];
    const { extractions } = await extractHouseFilings(
      [
        { filingId: "long", pdf: longPdf },
        { filingId: "short", pdf: shortPdf },
      ],
      {
        readPath: async () => "text_layer",
        renderPages: async () => [],
        ocrPage: async () => OCR_PAGE,
        run: async (requests, read) => {
          sent.push(...requests.flat().map((attachment) => attachment.sourceId));
          const outcomes = await run(requests, read);
          return outcomes.map((outcome) =>
            outcome.attachments.some((attachment) => attachment.filingId === "long" && attachment.pageEnd > attachment.pageStart)
              ? { attachments: outcome.attachments, result: null, truncated: true }
              : outcome
          );
        },
      },
      BUDGETS,
      2
    );

    expect(extractions.map((extraction) => [extraction.filingId, extraction.result.error, extraction.result.rows.length])).toEqual([
      ["long", null, 8],
      ["short", null, 1],
    ]);
    expect([...new Set(sent)].filter((sourceId) => sourceId.startsWith("long"))).toEqual([
      "long",
      "long:p1-2",
      "long:p3-4",
      "long:p1-1",
      "long:p2-2",
      "long:p3-3",
      "long:p4-4",
    ]);
  });

  it("narrows the request budget on truncation, so a retry never re-packs the halves it just split", async () => {
    // An output token limit is spent on the whole request's answer, not on one attachment. The
    // budget packs a filing's halves straight back into a single request, so halving only the
    // attachment leaves the model with the same rows to emit and it truncates again. House filing
    // 20016481 failed every pass on 2026-09-16 this way: 62 pages, halved down the ladder, each
    // round re-packed and truncated after a full paid generation.
    const document = await PDFDocument.create();
    for (let page = 0; page < 8; page++) document.addPage([200, 200]);
    const densePdf = Buffer.from(await document.save());
    const sentRequests: string[] = [];
    const { extractions } = await extractHouseFilings(
      [{ filingId: "dense", pdf: densePdf }],
      {
        readPath: async () => "text_layer",
        renderPages: async () => [],
        ocrPage: async () => OCR_PAGE,
        run: async (requests, read) => {
          const outcomes = await run(requests, read);
          return outcomes.map((outcome, index) => {
            const pages = requests[index]!.reduce(
              (total, attachment) => total + (attachment.pageEnd - attachment.pageStart + 1),
              0
            );
            sentRequests.push(
              `read${read.pass}${read.gap ? "g" : ""} ${requests[index]!.map((a) => a.sourceId).join("+")} pages=${pages}`
            );
            return pages > 2 ? { attachments: outcome.attachments, result: null, truncated: true } : outcome;
          });
        },
      },
      BUDGETS,
      2
    );

    // Every request after the whole-filing attempt carries exactly one attachment. Before the
    // retry narrowed the request budget too, the halves re-packed into one 40-page request and
    // asked the model for the same rows again, so each rung paid for two doomed generations
    // before anything shrank.
    expect(sentRequests.filter((request) => request.includes("+"))).toEqual([]);
    expect(sentRequests).toContain("read1 dense:p1-4 pages=4");
    expect(extractions.map((extraction) => [extraction.filingId, extraction.result.error])).toEqual([
      ["dense", null],
    ]);
  });

  it("fails only the scan whose OCR fails and still extracts the others", async () => {
    const goodScan = await onePagePdf();
    const badScan = await onePagePdf();
    const { extractions } = await extractHouseFilings(
      [
        { filingId: "bad", pdf: badScan },
        { filingId: "good", pdf: goodScan },
      ],
      {
        readPath: async () => "page_image_ocr",
        renderPages: async (pdf) => [{ image: Buffer.from(pdf === badScan ? "bad" : "good"), checkImage: Buffer.from("check") }],
        ocrPage: async (page) => {
          if (page.image.toString() === "bad") throw new Error("tesseract 5.3.0 installed; the orientation vote was measured on 5.5.0");
          return OCR_PAGE;
        },
        run,
      },
      BUDGETS,
      1
    );
    expect(extractions.map((extraction) => [extraction.filingId, extraction.parseMethod, extraction.result.error])).toEqual([
      ["bad", "scan", "OCR failed: tesseract 5.3.0 installed; the orientation vote was measured on 5.5.0"],
      ["good", "scan", null],
    ]);
  });
});
