import { planGapFillAttachment, planOcrTextRequests, planRowWindows } from "../ocrTextPlan";

const HEADER = "| Owner | Asset | Date |";
const SEPARATOR = "| --- | --- | --- |";

/** One text line, one table header and one table row per asset: 2 + assets labels, 1 + assets of them table lines. */
function page(assets: string[]): string {
  return ["NAME: Filer", "", HEADER, SEPARATOR, ...assets.map((asset) => `| SP | ${asset} | 04/01/22 |`)].join("\n");
}

const BUDGET = { maxTableRowsPerWindow: 20, maxRowsPerWindow: 120, maxTableRowsPerRequest: 40, maxAttachmentsPerRequest: 10 };

describe("ocrTextPlan", () => {
  it("cuts labels into windows bounded by table lines and by all labels", () => {
    expect(planRowWindows([], 20, 120)).toEqual([]);
    expect(planRowWindows([false, true, true, true, false, true], 2, 10)).toEqual([
      { first: 1, last: 3, rowCount: 6 },
      { first: 4, last: 6, rowCount: 6 },
    ]);
    expect(planRowWindows([false, false, false, false, false], 2, 2)).toEqual([
      { first: 1, last: 2, rowCount: 5 },
      { first: 3, last: 4, rowCount: 5 },
      { first: 5, last: 5, rowCount: 5 },
    ]);
    expect(() => planRowWindows([true], 0, 10)).toThrow("maxTableRowsPerWindow");
  });

  it("sends a short filing whole with one window over all of its labels", () => {
    const [attachment] = planOcrTextRequests(
      [{ filingId: "short", pages: [page(["A1"]), page(["B1", "B2"])] }],
      BUDGET
    )[0]!;
    expect(attachment!.sourceId).toBe("short");
    expect(attachment!.rowWindow).toEqual({ first: 1, last: 7, rowCount: 7 });
    expect(attachment!.ocrFirstPage).toBe(1);
    expect(attachment!.ocrPages).toHaveLength(2);
    expect(attachment!.ocrPages?.[1]).toContain("| R7 | SP | B2 |");
  });

  it("gives each window of a long filing the neighboring pages as context and packs by table lines", () => {
    const pages = [page(["A1", "A2"]), page(["B1", "B2"]), page(["C1", "C2"]), page(["D1", "D2"])];
    const requests = planOcrTextRequests([{ filingId: "long", pages }], {
      ...BUDGET,
      maxTableRowsPerWindow: 3,
      maxTableRowsPerRequest: 6,
    });
    const attachments = requests.flat();
    expect(
      attachments.map((a) => [a.sourceId, a.rowWindow?.first, a.rowWindow?.last, a.ocrFirstPage, a.ocrPages?.length])
    ).toEqual([
      ["long:w1", 1, 5, 1, 3],
      ["long:w2", 6, 9, 1, 4],
      ["long:w3", 10, 13, 2, 3],
      ["long:w4", 14, 16, 3, 2],
    ]);
    expect(attachments[1]!.chunkIndex).toBe(1);
    expect(attachments[1]!.ocrPages?.[1]).toContain("=== ROW WINDOW R6-R9 BEGINS ===\n| R6 | Owner | Asset | Date |");
    expect(attachments[1]!.ocrPages?.[2]).toContain("[R9] NAME: Filer\n=== ROW WINDOW R6-R9 ENDS ===");
    expect(attachments[1]!.ocrPages?.join("\n").match(/=== ROW WINDOW/g)).toHaveLength(2);

    const gap = planGapFillAttachment(attachments[1]!, { first: 7, last: 8, rowCount: 16 });
    expect([gap.sourceId, gap.ocrFirstPage, gap.ocrPages?.length, gap.rowWindow]).toEqual([
      "long:w2:g7-8",
      1,
      3,
      { first: 7, last: 8, rowCount: 16 },
    ]);
    expect(gap.ocrPages?.[1]).toContain("=== ROW WINDOW R7-R8 BEGINS ===\n| R7 | SP | B1 | 04/01/22 |");
    expect(gap.ocrPages?.join("\n")).not.toContain("R6-R9");
    expect(requests.map((request) => request.map((a) => a.sourceId))).toEqual([
      ["long:w1", "long:w2"],
      ["long:w3", "long:w4"],
    ]);
  });

  it("cuts a filing filed as page images so no window's pages exceed one request's image limit, however few its rows", () => {
    const pages = Array.from({ length: 12 }, (_, index) => page([`Asset ${index + 1}`]));
    const requests = planOcrTextRequests(
      [
        {
          filingId: "letters",
          pages,
          source: {
            kind: "images",
            filed: pages.map((_, index) => Buffer.from(`filed-${index + 1}`)),
            rotations: pages.map(() => 0 as const),
            geometries: pages.map(() => null),
            upright: async (image) => image,
          },
        },
      ],
      { ...BUDGET, maxPagesPerRequest: 10 }
    );
    const attachments = requests.flat();
    expect(attachments.length).toBeGreaterThan(1);
    for (const attachment of attachments) {
      expect(attachment.pageEnd - attachment.pageStart + 1).toBeLessThanOrEqual(10);
    }
    const labels = attachments.flatMap((attachment) =>
      attachment.rowWindow ? [[attachment.rowWindow.first, attachment.rowWindow.last]] : []
    );
    expect(labels[0]![0]!).toBe(1);
    expect(labels[labels.length - 1]![1]!).toBe(attachments[0]!.rowWindow?.rowCount);
  });
});
