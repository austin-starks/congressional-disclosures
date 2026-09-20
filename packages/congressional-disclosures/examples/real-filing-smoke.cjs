#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Deliberately require the compiled package entrypoint, never a source file.
const disclosures = require("../dist/index.js");

const FILING_ID = "20025000";
const FIXTURE = path.resolve(
  __dirname,
  "../src/extraction/tests/fixtures/house-ptr-20025000-encrypted.pdf"
);
const BUDGET = {
  maxTableRowsPerWindow: 40,
  maxRowsPerWindow: 80,
  maxTableRowsPerRequest: 80,
  maxAttachmentsPerRequest: 4,
  maxPagesPerRequest: 4,
};

const PAGE_TEXT = [
  "Filing ID #20025000 — Hon. Jonathan Jackson — filed 05/07/2024",
  "| Owner | Asset | Type | Transaction Date | Notification Date | Amount |",
  "| --- | --- | --- | --- | --- | --- |",
  "| JT | ConocoPhillips Common Stock (COP) [ST] | P | 04/02/2024 | 05/06/2024 | $15,001 - $50,000 |",
  "| JT | Hexcel Corporation Common Stock (HXL) [ST] | S | 04/24/2024 | 05/06/2024 | $15,001 - $50,000 |",
  "| JT | JP Morgan Chase & Co. Common Stock (JPM) [ST] | P | 04/24/2024 | 05/06/2024 | $15,001 - $50,000 |",
  "| JT | lululemon athletica inc. - Common Stock (LULU) [ST] | S | 04/02/2024 | 05/06/2024 | $15,001 - $50,000 |",
].join("\n");
const SIGNATURE_TEXT = "Digitally Signed: Hon. Jonathan Jackson, 05/07/2024";

function renderPages(pdf, directory) {
  const input = path.join(directory, "filing.pdf");
  const prefix = path.join(directory, "page");
  require("node:fs").writeFileSync(input, pdf);
  execFileSync("pdftoppm", ["-png", "-r", "96", input, prefix], { stdio: "pipe" });
  return readdirSync(directory)
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => readFileSync(path.join(directory, name)));
}

async function transcribeTwice(image, text, keys) {
  const client = {
    async complete(request) {
      keys.push(request.idempotencyKey);
      return {
        payload: { choices: [{ message: { content: text } }] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
  const transcribe = disclosures.createEngineTranscriber(client, "smoke/fake-engine");
  const [first, second] = await Promise.all([transcribe(image, 1), transcribe(image, 2)]);
  assert.equal(disclosures.ocrReadsDisagreement(first, second), null);
  assert.notEqual(keys.at(-2), keys.at(-1), "the two physical reads must not share an idempotency key");
  const readOneRetryKeyIndex = keys.length;
  await transcribe(image, 1);
  assert.equal(keys[readOneRetryKeyIndex], keys[readOneRetryKeyIndex - 2], "a retry must replay its own read");
  return first;
}

function transactionRows(pages) {
  const numbered = disclosures.numberOcrRows(pages);
  const labels = numbered.pages
    .flatMap((page) => page.split("\n"))
    .flatMap((line) => {
      const match = /^\| R(\d+) \| JT \|/.exec(line);
      return match ? [Number(match[1])] : [];
    });
  assert.deepEqual(labels.length, 4, "the real filing smoke transcription must contain four trades");
  const values = [
    ["P", "04/02/2024", "2024-04-02", "ConocoPhillips Common Stock (COP) [ST]", "COP"],
    ["S", "04/24/2024", "2024-04-24", "Hexcel Corporation Common Stock (HXL) [ST]", "HXL"],
    ["P", "04/24/2024", "2024-04-24", "JP Morgan Chase & Co. Common Stock (JPM) [ST]", "JPM"],
    ["S", "04/02/2024", "2024-04-02", "lululemon athletica inc. - Common Stock (LULU) [ST]", "LULU"],
  ];
  const rows = values.map(([type, printedDate, isoDate, asset, ticker], index) => ({
    transaction_type_code: type,
    transaction_date: printedDate,
    transaction_date_iso: isoDate,
    asset_description: asset,
    ticker,
    asset_type_code: "ST",
    amount_bracket: "$15,001 - $50,000",
    amount_category: "$15,001 - $50,000",
    amount_exact: null,
    amount_low: 15001,
    amount_high: 50000,
    ocr_rows: [labels[index]],
  }));
  const cited = new Set(labels);
  const nonTransactionRows = numbered.rowPages
    .map((_, index) => index + 1)
    .filter((label) => !cited.has(label));
  return { rows, nonTransactionRows };
}

function batchResult(attachments, extractedRows, nonTransactionRows) {
  const documents = attachments.map((attachment) => {
    const sourcePage = /:s(\d+)$/.exec(attachment.sourceId)?.[1];
    const rows = sourcePage === "2"
      ? []
      : extractedRows.map((row) => ({ ...row, ocr_rows: sourcePage ? [] : row.ocr_rows }));
    return {
      sourceId: attachment.sourceId,
      rows,
      noTransactionsStatement: null,
      amendedReportDate: null,
      amendedReportDateIso: null,
      nonTransactionRows: sourcePage ? [] : nonTransactionRows,
      continuationRows: [],
      invalidRowIndexes: [],
      reviewRowIndexes: [],
      error: null,
    };
  });
  return {
    documents,
    unknownSourceIds: [],
    contractVersion: "real-filing-smoke",
    requestedModel: "smoke/fake-extractor",
    servedModel: "smoke/fake-extractor",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    latencyMs: 0,
    rawResponse: {},
  };
}

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "congressional-disclosures-smoke-"));
  try {
    const pdf = readFileSync(FIXTURE);
    const plannedPdf = await disclosures.planPtrRequests(
      [{ filingId: FILING_ID, pdf }],
      { maxPagesPerAttachment: 10, maxPagesPerRequest: 10, maxAttachmentsPerRequest: 1 }
    );
    assert.equal(plannedPdf.flat()[0].totalPages, 2, "the public planner must read the real encrypted PDF");

    const pageImages = renderPages(pdf, directory);
    assert.equal(pageImages.length, 2, "the real filing must render to two pages");
    const keys = [];
    const pages = [
      await transcribeTwice(pageImages[0], PAGE_TEXT, keys),
      await transcribeTwice(pageImages[1], SIGNATURE_TEXT, keys),
    ];
    const requests = disclosures.planOcrTextRequests(
      [{
        filingId: FILING_ID,
        pages,
        source: {
          kind: "images",
          filed: pageImages,
          rotations: [0, 0],
          geometries: [null, null],
          upright: async (image) => image,
        },
      }],
      BUDGET
    );
    const { rows, nonTransactionRows } = transactionRows(pages);
    const run = async (planned) => planned.map((attachments) => ({
      attachments: attachments.map(({ sourceId, filingId, pageStart, pageEnd, totalPages, rowWindow }) => ({
        sourceId,
        filingId,
        pageStart,
        pageEnd,
        totalPages,
        ...(rowWindow ? { rowWindow } : {}),
      })),
      result: batchResult(attachments, rows, nonTransactionRows),
    }));
    const extraction = await disclosures.runMapReduceReads(requests, run, BUDGET);
    assert.deepEqual(extraction.consensus, {
      agreed: 1,
      arbitrated: 0,
      failed: 0,
      laterReads: 0,
      gapReads: 0,
      promptTokens: 0,
      completionTokens: 0,
    });

    const document = extraction.outcomes[0].result.documents[0];
    assert.equal(document.rows.length, 4);
    const trades = document.rows.map((row, rowIndex) => ({
      chamber: "house",
      docId: FILING_ID,
      rowIndex,
      filingDate: "2024-05-07",
      transactionDate: row.transaction_date_iso,
      notificationDate: "2024-05-06",
      amountLow: row.amount_low,
      amountHigh: row.amount_high,
      resolutionStatus: "printed",
      resolvedTicker: null,
    }));
    const events = trades.map((trade) => ({
      eventId: `house:${FILING_ID}:${trade.rowIndex}`,
      chamber: "house",
      sourceDocId: FILING_ID,
      contributorRowIds: JSON.stringify([`${FILING_ID}:${trade.rowIndex}`]),
    }));
    const integrity = disclosures.auditPoliticalIntegrity({
      now: new Date("2024-05-08T00:00:00.000Z"),
      filings: [{ chamber: "house", docId: FILING_ID, filingDate: "2024-05-07", extractionStatus: "ok" }],
      trades,
      events,
      indexed: [{ chamber: "house", docId: FILING_ID }],
      receipts: [{ chamber: "house", docId: FILING_ID }],
      shardKeys: {
        political_filings: { 2024: ["political_filings/2024/smoke.parquet"] },
        political_trades: { 2024: ["political_trades/2024/smoke.parquet"] },
        political_trade_events: { 2024: ["political_trade_events/2024/smoke.parquet"] },
      },
    });
    assert.equal(integrity.passed, true, JSON.stringify(integrity.findings));
    process.stdout.write(
      `PASS real filing ${FILING_ID}: 2 pages, ${document.rows.length} trades, independent OCR keys, map-reduce agreement, integrity green\n`
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
