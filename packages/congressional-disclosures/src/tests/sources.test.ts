import JSZip from "jszip";

import {
  fetchHouseIndexZip as _fetchHouseIndexZip,
  housePeriodicTransactionReports,
  parseHouseIndexTsv,
  parseHouseIndexZip,
} from "../sources/house";
import {
  parseSenateElectronicPtr,
  parseSenateReportTitle,
  senatePaperPageImageUrls,
  senateReportId,
  senateReportKind,
} from "../sources/senate";

void _fetchHouseIndexZip;

const INDEX_2024 = [
  "prefix\tlast\tfirst\tsuffix\tfilingtype\tstatedst\tyear\tfilingdate\tdocid",
  "Hon.\tPelosi\tNancy\t\tP\tCA12\t2024\t06/15/2024\t20018253",
  "Mr.\tSmith\tBob\t\tZ\tTX01\t2024\t06/14/2024\t20018254",
  "Ms.\tLee\tBarbara\t\tP\tCA13\t2024\t07/01/2024\t20018255",
].join("\n");

describe("House Clerk index", () => {
  test("parses filings and filters periodic transaction reports", () => {
    const filings = parseHouseIndexTsv(2024, INDEX_2024);
    expect(filings).toHaveLength(3);
    const ptrs = housePeriodicTransactionReports(filings);
    expect(ptrs.map((filing) => filing.docId)).toEqual(["20018253", "20018255"]);
    expect(ptrs[0]).toMatchObject({
      indexYear: 2024, filingType: "P", filingDate: "06/15/2024",
      prefix: "Hon.", first: "Nancy", last: "Pelosi", stateDistrict: "CA12",
    });
  });

  test("rejects a non-numeric DocID", () => {
    expect(() => parseHouseIndexTsv(2024, "prefix\tlast\tfirst\tsuffix\tfilingtype\tstatedst\tyear\tfilingdate\tdocid\n\t\t\t\tP\t\t2024\t\tnot-a-docid"))
      .toThrow(/non-numeric DocID/);
  });

  test("rejects an index missing a required column", () => {
    expect(() => parseHouseIndexTsv(2024, "prefix\tlast\tfirst\tsuffix\tfilingtype\tyear\tfilingdate\tdocid\n\t\t\t\tP\t2024\t\t1")).toThrow(/missing the statedst column/);
  });

  test("round-trips the index ZIP entry", async () => {
    const zip = new JSZip();
    zip.file("2024FD.txt", INDEX_2024);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const filings = await parseHouseIndexZip(2024, buffer);
    expect(filings).toHaveLength(3);
  });

  test("rejects a ZIP without the year's entry", async () => {
    const zip = new JSZip();
    zip.file("other.txt", INDEX_2024);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(parseHouseIndexZip(2024, buffer)).rejects.toThrow(/no 2024FD.txt/);
  });
});

const ELECTRONIC_HTML = `<html><body>
<table>
  <thead><tr>
    <th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th><th>Asset Name</th>
    <th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th>
  </tr></thead>
  <tbody>
    <tr><td>1</td><td>06/01/2024</td><td>Self</td><td>AAPL</td><td>Apple Inc. Common Stock</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr>
    <tr><td>2</td><td>06/03/2024</td><td>Spouse</td><td>--</td><td>Municipal Bond Fund</td><td>Other</td><td>Sale (Full)</td><td>$15,001 - $50,000</td><td>Sold</td></tr>
  </tbody>
</table>
</body></html>`;

describe("Senate eFD sources", () => {
  test("classifies report paths", () => {
    const ptrPath = "/search/view/ptr/5b2f0c3a-1d4e-4f5a-9b8c-7a6d5e4f3c21/";
    const paperPath = "/search/view/paper/6c3f1d4b-2e5f-4a6b-8c9d-8b7e6f5a4d32/";
    expect(senateReportKind(ptrPath)).toBe("electronic");
    expect(senateReportId(ptrPath)).toBe("5b2f0c3a-1d4e-4f5a-9b8c-7a6d5e4f3c21");
    expect(senateReportKind(paperPath)).toBe("paper");
    expect(() => senateReportKind("/search/view/other/abc/")).toThrow(/Unrecognized Senate report path/);
  });

  test("parses report titles including amendments", () => {
    expect(parseSenateReportTitle("Periodic Transaction Report for 06/10/2024")).toEqual({ reportDate: "2024-06-10", amendment: "none" });
    expect(parseSenateReportTitle("Periodic Transaction Report for 06/10/2024 (Amendment 2)")).toEqual({ reportDate: "2024-06-10", amendment: "numbered" });
    expect(parseSenateReportTitle("Periodic Transaction Report for 06/10/2024 (Amendment)")).toEqual({ reportDate: "2024-06-10", amendment: "unnumbered" });
    expect(parseSenateReportTitle("Some other title")).toBeNull();
  });

  test("parses an electronic PTR table with dashes as null tickers", () => {
    const transactions = parseSenateElectronicPtr(ELECTRONIC_HTML);
    expect(transactions).toEqual([
      {
        rowNumber: 1, transactionDate: "06/01/2024", owner: "Self", ticker: "AAPL",
        assetName: "Apple Inc. Common Stock", assetType: "Stock", transactionType: "Purchase",
        amount: "$1,001 - $15,000", comment: null,
      },
      {
        rowNumber: 2, transactionDate: "06/03/2024", owner: "Spouse", ticker: null,
        assetName: "Municipal Bond Fund", assetType: "Other", transactionType: "Sale (Full)",
        amount: "$15,001 - $50,000", comment: "Sold",
      },
    ]);
  });

  test("rejects unexpected columns", () => {
    const html = ELECTRONIC_HTML.replace("<th>Owner</th>", "<th>Holder</th>");
    expect(() => parseSenateElectronicPtr(html)).toThrow(/Unexpected Senate transaction columns/);
  });

  test("rejects a row with the wrong cell count", () => {
    const html = ELECTRONIC_HTML.replace("<td>$1,001 - $15,000</td><td>--</td></tr>", "<td>$1,001 - $15,000</td></tr>");
    expect(() => parseSenateElectronicPtr(html)).toThrow(/Senate transaction row has \d+ cells/);
  });

  test("collects paper-report page image URLs", () => {
    const html = `<html><body>
      <img class="filingImage" src="/search/view/paper/abc/1.png" />
      <img class="filingImage" src=" /search/view/paper/abc/2.png " />
      <img src="/irrelevant.png" />
    </body></html>`;
    expect(senatePaperPageImageUrls(html)).toEqual([
      "/search/view/paper/abc/1.png",
      "/search/view/paper/abc/2.png",
    ]);
  });
});
