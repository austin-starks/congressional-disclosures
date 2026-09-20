import { readFileSync } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";

import type { PtrDocumentResult } from "../ptrExtraction";
import {
  mergePtrFilingResults,
  planPtrRequests,
  ptrPageRangeSourceId,
  type PtrAttachmentMeta,
} from "../ptrRequestPlan";

async function pdfWithPages(count: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) document.addPage([200, 200]);
  return Buffer.from(await document.save());
}

async function pageCount(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

function result(
  sourceId: string,
  rows: number,
  overrides: Partial<PtrDocumentResult> = {}
): PtrDocumentResult {
  return {
    sourceId,
    rows: Array.from({ length: rows }, (_, index) => ({ row: `${sourceId}-${index}` })),
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows: [],
    continuationRows: [],
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error: null,
    ...overrides,
  };
}

describe("ptrRequestPlan", () => {
  describe("planPtrRequests", () => {
    it("keeps short filings whole and splits long filings into page ranges", async () => {
      const requests = await planPtrRequests(
        [
          { filingId: "short", pdf: await pdfWithPages(2) },
          { filingId: "long", pdf: await pdfWithPages(5) },
        ],
        { maxPagesPerAttachment: 2, maxPagesPerRequest: 100, maxAttachmentsPerRequest: 10 }
      );
      const attachments = requests.flat();
      expect(attachments.map((attachment) => attachment.sourceId)).toEqual([
        "short",
        ptrPageRangeSourceId("long", 1, 2),
        ptrPageRangeSourceId("long", 3, 4),
        ptrPageRangeSourceId("long", 5, 5),
      ]);
      expect(attachments[0]!.pages).toBeUndefined();
      expect(attachments[3]!.pages).toEqual({ start: 5, end: 5, total: 5 });
      expect(await pageCount(attachments[1]!.pdf!)).toBe(2);
      expect(await pageCount(attachments[3]!.pdf!)).toBe(1);
    });

    it("splits an encrypted House filing through the injected decryptor into page ranges", async () => {
      // A real electronic House PTR: RC4-encrypted, as every one sampled on 2026-09-16 was.
      // pdf-lib copied pages out of these as blank pages with no text. The decryptor itself
      // (PDFium in the system this port came from) is an injected port here; the original
      // test also asserted the copied ranges keep their text, which needs that system's PDF
      // text extractor and stayed behind with it.
      const pdf = readFileSync(path.join(__dirname, "fixtures", "house-ptr-20025000-encrypted.pdf"));
      expect((await PDFDocument.load(pdf, { ignoreEncryption: true })).isEncrypted).toBe(true);
      const decrypted: Buffer[] = [];
      const decrypt = async (encrypted: Buffer): Promise<Buffer> => {
        decrypted.push(encrypted);
        return pdfWithPages(2);
      };

      const [request] = await planPtrRequests(
        [{ filingId: "20025000", pdf, maxPagesPerAttachment: 1, decrypt }],
        { maxPagesPerAttachment: 1000, maxPagesPerRequest: 100, maxAttachmentsPerRequest: 10 }
      );
      expect(request!.map((attachment) => attachment.sourceId)).toEqual([
        ptrPageRangeSourceId("20025000", 1, 1),
        ptrPageRangeSourceId("20025000", 2, 2),
      ]);
      expect(decrypted).toEqual([pdf]);
      await expect(
        planPtrRequests(
          [{ filingId: "20025000", pdf, maxPagesPerAttachment: 1 }],
          { maxPagesPerAttachment: 1000, maxPagesPerRequest: 100, maxAttachmentsPerRequest: 10 }
        )
      ).rejects.toThrow("no PDF decryptor");
    });

    it("packs requests by page budget and attachment count", async () => {
      const filings = await Promise.all(
        [3, 3, 3, 1].map(async (pages, index) => ({
          filingId: `f${index}`,
          pdf: await pdfWithPages(pages),
        }))
      );
      const byPages = await planPtrRequests(filings, {
        maxPagesPerAttachment: 10,
        maxPagesPerRequest: 6,
        maxAttachmentsPerRequest: 10,
      });
      expect(byPages.map((request) => request.map((a) => a.filingId))).toEqual([
        ["f0", "f1"],
        ["f2", "f3"],
      ]);
      const byCount = await planPtrRequests(filings, {
        maxPagesPerAttachment: 10,
        maxPagesPerRequest: 100,
        maxAttachmentsPerRequest: 3,
      });
      expect(byCount.map((request) => request.length)).toEqual([3, 1]);
    });

    it("packs by estimated rows, because rows are what an answer runs out of room for", async () => {
      // Pages are a proxy and it breaks on density. Filing 20016481 prints 9.0 rows a page, so a
      // 10-page request asks for ~90 rows against the 40 the OCR path was measured at — which is
      // why every page budget tried on the dense filings truncated. Three 3-page filings fit the
      // page budget easily and must still be split, because together they are 90 rows.
      const filings = await Promise.all(
        [0, 1, 2].map(async (index) => ({
          filingId: `dense${index}`,
          pdf: await pdfWithPages(3),
          estimatedRows: 30,
        }))
      );

      const requests = await planPtrRequests(filings, {
        maxPagesPerAttachment: 10,
        maxPagesPerRequest: 100,
        maxAttachmentsPerRequest: 10,
        maxRowsPerRequest: 40,
      });

      expect(requests.map((request) => request.map((a) => a.filingId))).toEqual([
        ["dense0"],
        ["dense1"],
        ["dense2"],
      ]);
    });

    it("falls back to the page budget for a filing with no row estimate", async () => {
      const filings = await Promise.all(
        [0, 1].map(async (index) => ({ filingId: `f${index}`, pdf: await pdfWithPages(2) }))
      );

      const requests = await planPtrRequests(filings, {
        maxPagesPerAttachment: 10,
        maxPagesPerRequest: 100,
        maxAttachmentsPerRequest: 10,
        maxRowsPerRequest: 40,
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.map((a) => a.filingId)).toEqual(["f0", "f1"]);
    });

    it("sends a page larger than the request budget on its own", async () => {
      const requests = await planPtrRequests(
        [{ filingId: "big", pdf: await pdfWithPages(4) }],
        { maxPagesPerAttachment: 10, maxPagesPerRequest: 2, maxAttachmentsPerRequest: 5 }
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]![0]!.sourceId).toBe("big");
    });

    it("lets a filing override the attachment size", async () => {
      const requests = await planPtrRequests(
        [
          { filingId: "text", pdf: await pdfWithPages(3) },
          { filingId: "scan", pdf: await pdfWithPages(3), maxPagesPerAttachment: 1 },
        ],
        { maxPagesPerAttachment: 10, maxPagesPerRequest: 100, maxAttachmentsPerRequest: 10 }
      );
      expect(requests.flat().map((attachment) => attachment.sourceId)).toEqual([
        "text",
        ptrPageRangeSourceId("scan", 1, 1),
        ptrPageRangeSourceId("scan", 2, 2),
        ptrPageRangeSourceId("scan", 3, 3),
      ]);
    });

    it("rejects a non-positive budget", async () => {
      await expect(
        planPtrRequests([], {
          maxPagesPerAttachment: 0,
          maxPagesPerRequest: 1,
          maxAttachmentsPerRequest: 1,
        })
      ).rejects.toThrow("maxPagesPerAttachment");
    });
  });

  describe("mergePtrFilingResults", () => {
    const ranges: PtrAttachmentMeta[] = [
      {
        sourceId: "doc:p3-4",
        filingId: "doc",
        pageStart: 3,
        pageEnd: 4,
        totalPages: 4,
        pages: { start: 3, end: 4, total: 4 },
      },
      {
        sourceId: "doc:p1-2",
        filingId: "doc",
        pageStart: 1,
        pageEnd: 2,
        totalPages: 4,
        pages: { start: 1, end: 2, total: 4 },
      },
    ];

    it("concatenates ranges in page order and offsets row indexes", () => {
      const [merged] = mergePtrFilingResults(
        ranges,
        new Map([
          ["doc:p1-2", result("doc:p1-2", 2, { amendedReportDate: "11/08/2024" })],
          ["doc:p3-4", result("doc:p3-4", 3, { invalidRowIndexes: [0], reviewRowIndexes: [2] })],
        ])
      );
      expect(merged!.sourceId).toBe("doc");
      expect(merged!.rows.map((row) => row.row)).toEqual([
        "doc:p1-2-0",
        "doc:p1-2-1",
        "doc:p3-4-0",
        "doc:p3-4-1",
        "doc:p3-4-2",
      ]);
      expect(merged!.invalidRowIndexes).toEqual([2]);
      expect(merged!.reviewRowIndexes).toEqual([4]);
      expect(merged!.amendedReportDate).toBe("11/08/2024");
      expect(merged!.error).toBeNull();
    });

    it("merges OCR row windows in window order and proves their row coverage", () => {
      const windows: PtrAttachmentMeta[] = [1, 0].map((chunkIndex) => ({
        sourceId: `doc:w${chunkIndex + 1}`,
        filingId: "doc",
        pageStart: 1,
        pageEnd: 2,
        totalPages: 2,
        chunkIndex,
        rowWindow: { first: chunkIndex * 2 + 1, last: chunkIndex * 2 + 2, rowCount: 4 },
      }));
      const complete = new Map([
        ["doc:w1", result("doc:w1", 0, { rows: [{ row: "a", ocr_rows: [2, 3] }], nonTransactionRows: [1] })],
        ["doc:w2", result("doc:w2", 0, { rows: [{ row: "b", ocr_rows: [4] }], continuationRows: [3] })],
      ]);
      const [merged] = mergePtrFilingResults(windows, complete);
      expect(merged!.error).toBeNull();
      expect(merged!.rows.map((row) => row.row)).toEqual(["a", "b"]);
      expect(merged!.nonTransactionRows).toEqual([1]);

      const gap = new Map([
        ["doc:w1", result("doc:w1", 0, { rows: [{ row: "a", ocr_rows: [2] }], nonTransactionRows: [1] })],
        ["doc:w2", result("doc:w2", 0, { rows: [{ row: "b", ocr_rows: [4] }] })],
      ]);
      expect(mergePtrFilingResults(windows, gap)[0]!.error).toBe(
        "OCR row coverage: doc:w2 gives no disposition for R3"
      );
    });

    it("checks coverage on a whole OCR filing read in one window", () => {
      const whole: PtrAttachmentMeta[] = [
        {
          sourceId: "doc",
          filingId: "doc",
          pageStart: 1,
          pageEnd: 1,
          totalPages: 1,
          rowWindow: { first: 1, last: 2, rowCount: 2 },
        },
      ];
      const [merged] = mergePtrFilingResults(
        whole,
        new Map([["doc", result("doc", 0, { rows: [{ row: "a", ocr_rows: [2] }] })]])
      );
      expect(merged!.error).toBe("OCR row coverage: doc gives no disposition for R1");
    });

    it("fails the filing when any range fails or is missing", () => {
      const [merged] = mergePtrFilingResults(
        ranges,
        new Map([["doc:p1-2", result("doc:p1-2", 2, { error: "response omitted source_id" })]])
      );
      expect(merged!.error).toContain("pages 1-2: response omitted source_id");
      expect(merged!.error).toContain("pages 3-4: no extraction result");
    });

    it("treats ranges with no rows and no statement as an unexplained empty filing", () => {
      const [merged] = mergePtrFilingResults(
        ranges,
        new Map([
          ["doc:p1-2", result("doc:p1-2", 0)],
          ["doc:p3-4", result("doc:p3-4", 0)],
        ])
      );
      expect(merged!.error).toBe(
        "document returned no rows and no no-transactions statement"
      );
    });

    it("passes a whole-document result through under the filing id", () => {
      const [merged] = mergePtrFilingResults(
        [{ sourceId: "whole", filingId: "whole", pageStart: 1, pageEnd: 1, totalPages: 1 }],
        new Map([["whole", result("whole", 1)]])
      );
      expect(merged!.rows).toHaveLength(1);
      expect(merged!.error).toBeNull();
    });
  });
});
