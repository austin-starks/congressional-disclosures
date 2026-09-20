import { numberOcrRows } from "../ocrRowNumbering";

const PAGE_ONE = [
  "NAME: Filer",
  "",
  "| Owner | Asset | Purchase | Sale |",
  "| --- | --- | --- | --- |",
  "| JT | Provide full name | PURCHASE | SALE |",
  "| SP | Apple Inc | ☑ | ☐ |",
  "",
  "Page 1 of 2",
].join("\n");

const PAGE_TWO = [
  "| Owner | Asset | Purchase | Sale |",
  "|:---|---|---|---|",
  "| SP | Microsoft Corp | ☐ | ☑ |",
].join("\n");

describe("ocrRowNumbering", () => {
  it("labels every non-blank line across pages, as a table cell or a line prefix", () => {
    const { pages, rowPages, rowLines, tableRows } = numberOcrRows([PAGE_ONE, PAGE_TWO]);
    expect(pages[0]!.split("\n")).toEqual([
      "[R1] NAME: Filer",
      "",
      "| R2 | Owner | Asset | Purchase | Sale |",
      "| --- | --- | --- | --- | --- |",
      "| R3 | JT | Provide full name | PURCHASE | SALE |",
      "| R4 | SP | Apple Inc | ☑ | ☐ |",
      "",
      "[R5] Page 1 of 2",
    ]);
    expect(pages[1]!.split("\n")).toEqual([
      "| R6 | Owner | Asset | Purchase | Sale |",
      "| --- |:---|---|---|---|",
      "| R7 | SP | Microsoft Corp | ☐ | ☑ |",
    ]);
    expect(rowPages).toEqual([1, 1, 1, 1, 1, 2, 2]);
    expect(rowLines).toEqual([0, 2, 4, 5, 7, 0, 2]);
    expect(tableRows).toEqual([false, true, true, true, false, true, true]);
  });

  it("labels a transaction row that OCR placed above its table's separator (Donalds 8221334 page 2)", () => {
    const { pages } = numberOcrRows([
      [
        "|  Depository Shares (SONY) Synopsys, Inc. Common Stock (SNPS) | $1,0001 - $15,000 | Purchase | 03/27/2024 | Self  |",
        "| --- | --- | --- | --- | --- |",
        "",
        "Sincerely,",
      ].join("\n"),
    ]);
    expect(pages[0]!.split("\n")).toEqual([
      "| R1 |  Depository Shares (SONY) Synopsys, Inc. Common Stock (SNPS) | $1,0001 - $15,000 | Purchase | 03/27/2024 | Self  |",
      "| --- | --- | --- | --- | --- | --- |",
      "",
      "[R2] Sincerely,",
    ]);
  });

  it("is deterministic: the same text always numbers the same way", () => {
    expect(numberOcrRows([PAGE_ONE, PAGE_TWO])).toEqual(numberOcrRows([PAGE_ONE, PAGE_TWO]));
    expect(numberOcrRows(["", "  "])).toEqual({ pages: ["", "  "], rowPages: [], rowLines: [], tableRows: [] });
  });
});
