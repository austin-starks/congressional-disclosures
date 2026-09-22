import {
  buildPtrExtractionBody,
  buildPtrResponseSchema,
  isValidPtrRow,
  parsePtrExtractionResponse,
  ptrAmountBounds,
  ptrBatchIdempotencyKey,
  ptrExtractionInstructions,
  ptrRowInvalidReason,
  ptrRowNeedsReview,
  PTR_EXACT_AMOUNT,
  PTR_EXACT_AMOUNT_MAX,
  PTR_ISO_DATE_PATTERN,
  PTR_UNMARKED,
  ptrSourceExpectations,
} from "../ptrExtraction";

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_type_code: "P",
    transaction_date: "01/13/2016",
    asset_description: "Apple Inc. (AAPL) [ST]",
    ticker: "AAPL",
    asset_type_code: "ST",
    amount_bracket: "$250,001 - $500,000",
    amount_category: "$250,001 - $500,000",
    amount_exact: null,
    transaction_date_iso: "2016-01-13",
    ocr_rows: [],
    ...overrides,
  };
}

function response(documents: unknown): Record<string, unknown> {
  return {
    model: "openai/gpt-5.6-luna",
    choices: [{ message: { content: JSON.stringify({ documents }) } }],
  };
}

function document(
  sourceId: string,
  rows: unknown[],
  statement: string | null = null,
  amendedReportDate: string | null = null
): Record<string, unknown> {
  return {
    source_id: sourceId,
    no_transactions_statement: statement,
    amended_report_date: amendedReportDate,
    amended_report_date_iso: null,
    non_transaction_rows: [],
    continuation_rows: [],
    rows,
  };
}

type SchemaNode = Record<string, unknown>;

function documentItemSchema(schema: Record<string, unknown>): SchemaNode {
  const documents = (schema.properties as SchemaNode).documents as SchemaNode;
  return documents.items as SchemaNode;
}

function rowItemSchema(schema: Record<string, unknown>): SchemaNode {
  const rows = (documentItemSchema(schema).properties as SchemaNode)
    .rows as SchemaNode;
  return rows.items as SchemaNode;
}

describe("ptrExtraction", () => {
  describe("buildPtrResponseSchema", () => {
    it("pins the document count and source ids", () => {
      const schema = buildPtrResponseSchema("minimal", ["20004596", "8214491"]);
      const documents = (schema.properties as SchemaNode).documents as SchemaNode;
      expect(documents.minItems).toBe(2);
      expect(documents.maxItems).toBe(2);
      const sourceId = (documentItemSchema(schema).properties as SchemaNode)
        .source_id as SchemaNode;
      expect(sourceId.enum).toEqual(["20004596", "8214491"]);
    });

    it("carries document-level statement and amended-report fields and allows empty rows", () => {
      const item = documentItemSchema(buildPtrResponseSchema("lake", ["1"]));
      expect(item.required).toEqual([
        "source_id",
        "no_transactions_statement",
        "amended_report_date",
        "amended_report_date_iso",
        "non_transaction_rows",
        "continuation_rows",
        "rows",
      ]);
      const rows = (item.properties as SchemaNode).rows as SchemaNode;
      expect(rows.minItems).toBeUndefined();
    });

    it("keeps row-defining fields present and represents unmarked marks explicitly", () => {
      for (const contract of ["minimal", "lake"] as const) {
        const properties = rowItemSchema(
          buildPtrResponseSchema(contract, ["1"])
        ).properties as Record<string, SchemaNode>;
        expect(properties.transaction_type_code!.type).toBe("string");
        expect(properties.transaction_type_code!.enum).toContain(PTR_UNMARKED);
        expect(properties.transaction_date!.type).toEqual(["string", "null"]);
        expect(properties.amount_bracket!.type).toBe("string");
        expect(properties.amount_category!.enum).toEqual(
          expect.arrayContaining([
            "$1,001 - $15,000",
            "Over $50,000,000",
            "Spouse/DC Over $1,000,000",
            PTR_UNMARKED,
          ])
        );
        expect(properties.amount_low).toBeUndefined();
        expect(properties.amount_category!.enum).toContain(PTR_EXACT_AMOUNT);
        expect(properties.amount_exact!.type).toEqual(["number", "null"]);
        expect(properties.amount_exact!.maximum).toBe(PTR_EXACT_AMOUNT_MAX);
        expect(properties.amount_exact!.minimum).toBe(0);
        expect(properties.transaction_date_iso!.pattern).toBe(PTR_ISO_DATE_PATTERN);
        expect(properties.ocr_rows!.type).toBe("array");
        expect(properties.asset_type_code!.pattern).toBe("^[A-Za-z0-9]+$");
      }
    });

    it("adds optional printed roles only to the lake contract", () => {
      const minimal = rowItemSchema(buildPtrResponseSchema("minimal", ["1"]));
      const lake = rowItemSchema(buildPtrResponseSchema("lake", ["1"]));
      expect(minimal.required).not.toContain("owner_code");
      expect(lake.required).toEqual(
        expect.arrayContaining([
          "owner_code",
          "notification_date",
          "filing_status",
          "transaction_description",
          "transaction_type_raw",
          "cap_gains_over_200",
          "owner",
          "partial_sale",
        ])
      );
      const properties = lake.properties as Record<string, SchemaNode>;
      expect(properties.owner!.enum).toEqual(["self", "spouse", "joint", "dependent_child", "not_indicated"]);
      expect(properties.partial_sale!.type).toBe("boolean");
      expect(minimal.required).not.toContain("owner");
    });
  });

  describe("buildPtrExtractionBody", () => {
    it("attaches one PDF per document with a matching source mapping", () => {
      const body = buildPtrExtractionBody("openai/gpt-5.6-luna", "minimal", [
        { sourceId: "a", pdf: Buffer.from("%PDF-a") },
        { sourceId: "b", pdf: Buffer.from("%PDF-b") },
      ]);
      const messages = body.messages as Array<Record<string, unknown>>;
      const content = messages[1]!.content as Array<Record<string, unknown>>;
      expect(content.filter((part) => part.type === "file")).toHaveLength(2);
      expect(String(content[0]!.text)).toContain('"source_id":"b"');
      expect(String(content[0]!.text)).not.toContain("page range of a longer filing");
    });

    it("marks page-range attachments in the mapping and instructions", () => {
      const body = buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", [
        {
          sourceId: "doc:p3-4",
          pdf: Buffer.from("%PDF"),
          pages: { start: 3, end: 4, total: 16 },
        },
      ]);
      const messages = body.messages as Array<Record<string, unknown>>;
      const text = String((messages[1]!.content as Array<Record<string, unknown>>)[0]!.text);
      expect(text).toContain('"pages":"3-4 of 16"');
      expect(text).toContain("page range of a longer filing");
    });

    it("sends page images instead of the PDF when a document carries them", () => {
      const body = buildPtrExtractionBody("openai/gpt-5.6-luna", "minimal", [
        {
          sourceId: "doc:p3-4",
          pdf: Buffer.from("%PDF"),
          pages: { start: 3, end: 4, total: 16 },
          pageImages: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x04])],
        },
      ]);
      const messages = body.messages as Array<Record<string, unknown>>;
      const content = messages[1]!.content as Array<Record<string, unknown>>;
      expect(content.filter((part) => part.type === "file")).toHaveLength(0);
      expect(content.filter((part) => part.type === "image_url")).toHaveLength(2);
      expect(content.map((part) => part.text).filter(Boolean)).toEqual(
        expect.arrayContaining([
          "source_id doc:p3-4, page 3:",
          "source_id doc:p3-4, page 4:",
        ])
      );
      expect(String(content[0]!.text)).toContain("arrive as page images");
    });

    it("names the row window and labels OCR pages from their first page", () => {
      const body = buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", [
        {
          sourceId: "doc:w2",
          pdf: Buffer.from("%PDF"),
          ocrPages: ["| R21 | DC | Pepsico |", "| R40 | DC | Coke |"],
          ocrFirstPage: 3,
          rowWindow: { first: 21, last: 40, rowCount: 95 },
        },
      ]);
      const content = (body.messages as Array<Record<string, unknown>>)[1]!.content as Array<
        Record<string, unknown>
      >;
      const text = String(content[0]!.text);
      expect(text).toContain('"row_window":"R21-R40 of R95"');
      expect(text).toContain("Give every row label inside that window a disposition");
      expect(content.map((part) => part.text)).toContain(
        "source_id doc:w2, page 4, OCR text:\n| R40 | DC | Coke |"
      );
    });

    it("sends OCR text instead of the PDF, and both when asked", () => {
      const partsOf = (body: Record<string, unknown>) =>
        (body.messages as Array<Record<string, unknown>>)[1]!.content as Array<
          Record<string, unknown>
        >;
      const ocrOnly = partsOf(
        buildPtrExtractionBody("openai/gpt-5.6-luna", "minimal", [
          {
            sourceId: "doc",
            pdf: Buffer.from("%PDF"),
            ocrPages: ["| Asset | P |", "page two"],
          },
        ])
      );
      expect(ocrOnly.filter((part) => part.type === "file")).toHaveLength(0);
      expect(ocrOnly.map((part) => part.text)).toEqual(
        expect.arrayContaining([
          "source_id doc, page 1, OCR text:\n| Asset | P |",
          "source_id doc, page 2, OCR text:\npage two",
        ])
      );
      expect(String(ocrOnly[0]!.text)).toContain("arrive as OCR text");
      expect(String(ocrOnly[0]!.text)).not.toContain("the PDF is the authority");

      const withPdf = partsOf(
        buildPtrExtractionBody("openai/gpt-5.6-luna", "minimal", [
          {
            sourceId: "doc",
            pdf: Buffer.from("%PDF"),
            ocrPages: ["page one"],
            ocrWithPdf: true,
          },
        ])
      );
      expect(withPdf.filter((part) => part.type === "file")).toHaveLength(1);
      expect(String(withPdf[0]!.text)).toContain("the PDF is the authority");
    });

    it("lists every schema field in the instructions", () => {
      expect(ptrExtractionInstructions("lake")).toContain("owner_code");
      expect(ptrExtractionInstructions("minimal")).not.toContain("owner_code");
      expect(ptrExtractionInstructions("minimal")).toContain("amended_report_date");
    });

    it("words a Senate paper request as its own contract and sends its OCR text without a PDF", () => {
      const documents = [{ sourceId: "report", ocrPages: ["| R1 | (S) Example Co. (stock) | X |"] }];
      const messages = buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", documents, "senate_paper")
        .messages as Array<Record<string, unknown>>;
      const content = messages[1]!.content as Array<Record<string, unknown>>;
      expect(content.filter((part) => part.type === "file")).toHaveLength(0);
      expect(String(content[0]!.text)).toContain("U.S. Senate paper Periodic Transaction Report");
      expect(ptrExtractionInstructions("lake")).not.toContain("Senate paper");
      expect(ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "lake", documents, "senate_paper")).not.toBe(
        ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "lake", documents)
      );
      expect(() => buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", [{ sourceId: "bare" }])).toThrow(
        "bare has no PDF to attach"
      );
    });

    it("sends a reconciling read each page image after that page's OCR text, then both map reads", () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const read = {
        sourceId: "report",
        rows: [],
        noTransactionsStatement: "Nothing to report",
        amendedReportDate: null,
        amendedReportDateIso: null,
        nonTransactionRows: [],
        continuationRows: [],
        invalidRowIndexes: [],
        reviewRowIndexes: [],
        error: null,
      };
      const body = buildPtrExtractionBody(
        "openai/gpt-5.6-luna",
        "lake",
        [
          {
            sourceId: "report",
            ocrPages: ["page one", "page two"],
            pageImages: [jpeg, jpeg],
            ocrWithPageImages: true,
            priorReads: [
              { label: "Read A", result: read },
              { label: "Read B", result: read },
            ],
          },
        ],
        "senate_paper"
      );
      const content = (body.messages as Array<Record<string, unknown>>)[1]!.content as Array<Record<string, unknown>>;
      expect(content.slice(1).map((part) => part.type)).toEqual(["text", "image_url", "text", "image_url", "text", "text"]);
      expect(String((content[2]!.image_url as Record<string, unknown>).url)).toMatch(/^data:image\/jpeg;base64,/);
      expect(String(content[0]!.text)).toContain("a value neither read gave is right when the filed page shows it");
      expect(() =>
        buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", [
          { sourceId: "short", ocrPages: ["page one", "page two"], pageImages: [jpeg], ocrWithPageImages: true },
        ])
      ).toThrow("short has 1 page images for 2 OCR pages");
    });

    it("states date findings to a reconciling read and adds their instruction only when a source carries them", () => {
      const read = {
        sourceId: "report",
        rows: [],
        noTransactionsStatement: null,
        amendedReportDate: null,
        amendedReportDateIso: null,
        nonTransactionRows: [],
        continuationRows: [],
        invalidRowIndexes: [],
        reviewRowIndexes: [],
        error: null,
      };
      const reconcile = (dateFindings?: readonly string[]) =>
        buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", [
          {
            sourceId: "report",
            ocrPages: ["page one"],
            priorReads: [
              { label: "Read A", result: read },
              { label: "Read B", result: read },
            ],
            ...(dateFindings ? { dateFindings } : {}),
          },
        ]);
      const parts = (body: Record<string, unknown>) =>
        (body.messages as Array<Record<string, unknown>>)[1]!.content as Array<Record<string, unknown>>;
      const plain = parts(reconcile());
      const finding = "Read A, the row labeled 3: transaction date 2013-06-01 is more than a year before its notification date 2023-07-03";
      const found = parts(reconcile([finding]));
      // Contract v11's wording moves rows when it changes, so a read without findings keeps it exactly.
      const plainText = String(plain[0]!.text);
      const foundText = String(found[0]!.text);
      const bullet = foundText.indexOf("\n- Some sources come with date findings");
      expect(plainText).not.toContain("date findings");
      expect(bullet).toBeGreaterThan(0);
      expect(foundText.slice(0, bullet) + foundText.slice(foundText.indexOf("\n- ", bullet + 1))).toBe(plainText);
      expect(found.at(-1)!.text).toBe(`source_id report, date findings:\n- ${finding}`);
      expect(plain.some((part) => String(part.text ?? "").includes("date findings:"))).toBe(false);

      // A repair read's findings add their own instruction and part; the rest of the text is unchanged.
      for (const [field, heading, instruction] of [
        ["assetFindings", "asset findings", "\n- Some sources come with asset findings"],
        ["emptyReadFindings", "empty-read findings", "\n- Some sources come with an empty-read finding"],
      ] as const) {
        const repair = parts(
          buildPtrExtractionBody("openai/gpt-5.6-luna", "lake", [
            {
              sourceId: "report",
              ocrPages: ["page one"],
              priorReads: [
                { label: "Read A", result: read },
                { label: "Read B", result: read },
              ],
              [field]: ["the row labeled 4 has no asset name"],
            },
          ])
        );
        const repairText = String(repair[0]!.text);
        const start = repairText.indexOf(instruction);
        expect(start).toBeGreaterThan(0);
        expect(plainText).not.toContain(instruction.trim());
        expect(repairText.slice(0, start) + repairText.slice(repairText.indexOf("\n- ", start + 1))).toBe(plainText);
        expect(repair.at(-1)!.text).toBe(`source_id report, ${heading}:\n- the row labeled 4 has no asset name`);
      }
    });

    it("licenses a reconciling read to answer no-transactions on a cover notice", () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const read = {
        sourceId: "report",
        rows: [],
        noTransactionsStatement: null,
        amendedReportDate: null,
        amendedReportDateIso: null,
        nonTransactionRows: [],
        continuationRows: [],
        invalidRowIndexes: [],
        reviewRowIndexes: [],
        error: null,
      };
      const body = buildPtrExtractionBody(
        "openai/gpt-5.6-luna",
        "lake",
        [
          {
            sourceId: "report",
            ocrPages: ["page one"],
            pageImages: [jpeg],
            ocrWithPageImages: true,
            priorReads: [
              { label: "Read A", result: read },
              { label: "Read B", result: read },
            ],
          },
        ],
        "house"
      );
      const content = (body.messages as Array<Record<string, unknown>>)[1]!.content as Array<Record<string, unknown>>;
      expect(String(content[0]!.text)).toContain("copy that statement into no_transactions_statement");
      expect(String(content[0]!.text)).toContain("a page that lists transactions never takes this path");
    });
  });

  describe("isValidPtrRow", () => {
    it("accepts a complete row and a null ticker", () => {
      expect(isValidPtrRow(validRow())).toBe(true);
      expect(isValidPtrRow(validRow({ ticker: null }))).toBe(true);
    });

    it("accepts an unmarked amount only with the unmarked category", () => {
      const unmarked = validRow({
        amount_bracket: PTR_UNMARKED,
        amount_category: PTR_UNMARKED,
      });
      expect(isValidPtrRow(unmarked)).toBe(true);
      expect(isValidPtrRow(validRow({ amount_bracket: PTR_UNMARKED }))).toBe(false);
      expect(isValidPtrRow(validRow({ amount_category: PTR_UNMARKED }))).toBe(false);
    });

    it("accepts an exact printed amount only with its number", () => {
      const exact = { amount_bracket: "$1.00", amount_category: PTR_EXACT_AMOUNT };
      expect(isValidPtrRow(validRow({ ...exact, amount_exact: 1 }))).toBe(true);
      expect(isValidPtrRow(validRow(exact))).toBe(false);
      expect(isValidPtrRow(validRow({ amount_exact: 1 }))).toBe(false);
      const exactCategory = { amount_category: PTR_EXACT_AMOUNT };
      expect(isValidPtrRow(validRow({ ...exactCategory, amount_bracket: "$15.00", amount_exact: 15 }))).toBe(true);
      expect(isValidPtrRow(validRow({ ...exactCategory, amount_bracket: "$100,000", amount_exact: 100000 }))).toBe(false);
      expect(isValidPtrRow(validRow({ ...exactCategory, amount_bracket: "$1,000", amount_exact: 1000 }))).toBe(false);
    });

    it("requires a known owner and a boolean partial mark, kept on whatever type the filer marked it", () => {
      expect(isValidPtrRow(validRow({ owner: "not_indicated", partial_sale: false }))).toBe(true);
      expect(isValidPtrRow(validRow({ owner: "SP" }))).toBe(false);
      expect(isValidPtrRow(validRow({ partial_sale: "yes" }))).toBe(false);
      expect(isValidPtrRow(validRow({ transaction_type_code: "S", partial_sale: true }))).toBe(true);
      // Khanna's attached statements (house:9116142) mark a Partial Transaction column on purchases.
      expect(isValidPtrRow(validRow({ transaction_type_code: "P", partial_sale: true }))).toBe(true);
    });

    it("requires a real ISO calendar date or null, and integer OCR row citations", () => {
      expect(isValidPtrRow(validRow({ transaction_date_iso: null }))).toBe(true);
      expect(isValidPtrRow(validRow({ transaction_date_iso: "2020-02-30" }))).toBe(false);
      expect(isValidPtrRow(validRow({ transaction_date_iso: "10/5/20" }))).toBe(false);
      expect(isValidPtrRow(validRow({ ocr_rows: [3, 4] }))).toBe(true);
      expect(isValidPtrRow(validRow({ ocr_rows: ["R3"] }))).toBe(false);
      expect(isValidPtrRow(validRow({ ocr_rows: undefined }))).toBe(false);
    });

    it("rejects a spaced ticker, a bracketed asset code, a non-statutory amount, and an unknown code", () => {
      expect(isValidPtrRow(validRow({ ticker: "EX M" }))).toBe(false);
      expect(isValidPtrRow(validRow({ asset_type_code: "[ST]" }))).toBe(false);
      expect(
        isValidPtrRow(validRow({ amount_category: "$15,001 - $30,000" }))
      ).toBe(false);
      expect(isValidPtrRow(validRow({ transaction_type_code: "X" }))).toBe(false);
    });
  });

  describe("ptrRowInvalidReason", () => {
    it("names the field that rejected the row, and shows the value", () => {
      // A boolean discarded this at fourteen rejection points, so a filing reported only
      // "invalid rows: 1108" — one message for fourteen unrelated defects, none of them fixable
      // from the message. Each reason must name its own field or the bucket stays untriageable.
      const reasons = [
        validRow({ transaction_type_code: "Q" }),
        validRow({ asset_description: "   " }),
        validRow({ amount_category: "$3 - $4" }),
        validRow({ transaction_date_iso: "2020-02-30" }),
        validRow({ ticker: "A B" }),
      ].map((row) => ptrRowInvalidReason(row));

      expect(reasons[0]).toContain("transaction_type_code");
      expect(reasons[1]).toContain("asset_description");
      expect(reasons[2]).toContain("amount_category");
      expect(reasons[3]).toContain("transaction_date_iso");
      expect(reasons[4]).toContain("ticker");
      expect(reasons.every((reason) => reason !== null)).toBe(true);
    });

    it("returns null for a row that is publishable", () => {
      expect(ptrRowInvalidReason(validRow({}))).toBeNull();
    });

    it("accepts a null printed date and rejects garbage that is neither a date nor null", () => {
      // The 2026-09-18-retry round's largest house residue was `transaction_date is ""`:
      // continuation rows of multi-row transactions print a blank Date cell, and "" is the
      // model's rendering of blank. Null is the published representation for those rows.
      expect(ptrRowInvalidReason(validRow({ transaction_date: null }))).toBeNull();
      expect(ptrRowInvalidReason(validRow({ transaction_date: "" }))).toContain("transaction_date");
      expect(ptrRowInvalidReason(validRow({ transaction_date: 42 }))).toContain("transaction_date");
    });
  });

  describe("ptrRowNeedsReview", () => {
    it("flags unmarked types and amounts", () => {
      expect(ptrRowNeedsReview(validRow())).toBe(false);
      expect(ptrRowNeedsReview(validRow({ transaction_type_code: PTR_UNMARKED }))).toBe(true);
      expect(
        ptrRowNeedsReview(
          validRow({ amount_bracket: PTR_UNMARKED, amount_category: PTR_UNMARKED })
        )
      ).toBe(true);
    });
  });

  describe("ptrAmountBounds", () => {
    it("derives bounds from the legal category, open-ended above the top ranges", () => {
      expect(ptrAmountBounds("$1,001 - $15,000")).toEqual({ low: 1001, high: 15000 });
      expect(ptrAmountBounds("Over $50,000,000")).toEqual({
        low: 50000001,
        high: null,
      });
      expect(ptrAmountBounds("Spouse/DC Over $1,000,000")).toEqual({
        low: 1000001,
        high: null,
      });
      expect(ptrAmountBounds(PTR_UNMARKED)).toEqual({ low: null, high: null });
      expect(ptrAmountBounds(PTR_EXACT_AMOUNT, 15)).toEqual({ low: 15, high: 15 });
      expect(ptrAmountBounds(PTR_EXACT_AMOUNT, null)).toEqual({ low: null, high: null });
    });
  });

  describe("parsePtrExtractionResponse", () => {
    it("maps rows to requested ids and flags invalid and review rows", () => {
      const parsed = parsePtrExtractionResponse(
        response([
          document("a", [
            validRow(),
            validRow({ ticker: "EX M" }),
            validRow({ transaction_type_code: PTR_UNMARKED }),
          ]),
          document("b", [validRow()], null, "11/08/2024"),
        ]),
        ["a", "b"]
      );
      expect(parsed.documents[0]).toMatchObject({
        sourceId: "a",
        invalidRowIndexes: [1],
        reviewRowIndexes: [2],
        error: null,
      });
      expect(parsed.documents[1]!.amendedReportDate).toBe("11/08/2024");
      expect(parsed.documents[0]!.rows[0]).toMatchObject({
        amount_low: 250001,
        amount_high: 500000,
      });
    });

    it("normalizes a blank printed date to null, not an invalid row", () => {
      const parsed = parsePtrExtractionResponse(
        response([
          document("a", [
            validRow({ transaction_date: "" }),
            validRow({ transaction_date: null }),
            validRow({ ticker: "EX M" }),
          ]),
        ]),
        ["a"]
      );
      expect(parsed.documents[0]!.rows[0]!.transaction_date).toBeNull();
      expect(parsed.documents[0]!.rows[1]!.transaction_date).toBeNull();
      // The blank-date rows are valid now; only the genuinely bad row is flagged.
      expect(parsed.documents[0]!.invalidRowIndexes).toEqual([2]);
    });

    it("accepts an empty whole document only with its own statement, and an empty page range always", () => {
      const parsed = parsePtrExtractionResponse(
        response([
          document("a", [], "Nothing to report for November 2020"),
          document("b", []),
          document("c", [validRow()], "Nothing to report"),
          document("d:p1-2", []),
        ]),
        ["a", "b", "c", "d:p1-2"],
        ptrSourceExpectations([
          { sourceId: "a" },
          { sourceId: "b" },
          { sourceId: "c" },
          { sourceId: "d:p1-2", pages: { start: 1, end: 2, total: 4 } },
        ])
      );
      expect(parsed.documents.map((d) => d.error)).toEqual([
        null,
        "document returned no rows and no no-transactions statement",
        "document returned rows and a no-transactions statement",
        null,
      ]);
    });

    it("reads the document-level ISO date and row lists", () => {
      const parsed = parsePtrExtractionResponse(
        response([
          {
            ...document("a", [validRow()]),
            amended_report_date_iso: "2024-11-08",
            non_transaction_rows: [1, 2],
            continuation_rows: [3],
          },
        ]),
        ["a"],
        ptrSourceExpectations([{ sourceId: "a", rowWindow: { first: 1, last: 3, rowCount: 3 } }])
      );
      expect(parsed.documents[0]).toMatchObject({
        amendedReportDateIso: "2024-11-08",
        nonTransactionRows: [1, 2],
        continuationRows: [3],
      });
    });

    it("drops row lists and citations from a source that is not numbered OCR text", () => {
      const parsed = parsePtrExtractionResponse(
        response([{ ...document("pdf", [validRow({ ocr_rows: [4] })]), continuation_rows: [6] }]),
        ["pdf"],
        ptrSourceExpectations([{ sourceId: "pdf" }])
      );
      expect(parsed.documents[0]).toMatchObject({ nonTransactionRows: [], continuationRows: [], error: null });
      expect(parsed.documents[0]!.rows[0]!.ocr_rows).toEqual([]);
    });

    it("fails a row window read that leaves a row without a disposition", () => {
      const expectations = ptrSourceExpectations([
        { sourceId: "partial", rowWindow: { first: 3, last: 4, rowCount: 6 } },
        { sourceId: "quiet", rowWindow: { first: 5, last: 6, rowCount: 6 } },
        { sourceId: "whole", rowWindow: { first: 1, last: 2, rowCount: 2 } },
      ]);
      const parsed = parsePtrExtractionResponse(
        response([
          document("partial", [validRow({ ocr_rows: [3] })]),
          { ...document("quiet", []), non_transaction_rows: [5, 6] },
          { ...document("whole", []), non_transaction_rows: [1, 2] },
        ]),
        ["partial", "quiet", "whole"],
        expectations
      );
      expect(parsed.documents.map((result) => result.error)).toEqual([
        "OCR row coverage: partial gives no disposition for R4",
        null,
        "document returned no rows and no no-transactions statement",
      ]);
    });

    it("turns omitted and duplicated documents into per-document errors", () => {
      const parsed = parsePtrExtractionResponse(
        response([
          document("a", [validRow()]),
          document("a", [validRow()]),
          document("zzz", [validRow()]),
        ]),
        ["a", "b"]
      );
      expect(parsed.documents.map((d) => d.error)).toEqual([
        "conflicting duplicate results for source_id",
        "response omitted source_id",
      ]);
      expect(parsed.unknownSourceIds).toEqual(["zzz"]);
    });

    it("fails every document on an unparseable response instead of throwing", () => {
      const parsed = parsePtrExtractionResponse(
        { choices: [{ message: { content: "not json" } }] },
        ["a", "b"]
      );
      expect(parsed.documents.every((d) => d.error !== null)).toBe(true);
    });
  });

  describe("ptrBatchIdempotencyKey", () => {
    it("changes when the PDF bytes, the OCR text, or the contract change", () => {
      const documents = [{ sourceId: "a", pdf: Buffer.from("one") }];
      const base = ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents);
      expect(ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents)).toBe(base);
      expect(ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "lake", documents)).not.toBe(base);
      expect(
        ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", [
          { sourceId: "a", pdf: Buffer.from("two") },
        ])
      ).not.toBe(base);
      expect(
        ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", [
          { sourceId: "a", pdf: Buffer.from("one"), ocrPages: ["page"] },
        ])
      ).not.toBe(base);
    });

    it("is stable without a cap and changes with one, so repeats agree on sameness", () => {
      const documents = [{ sourceId: "a", pdf: Buffer.from("one") }];
      const base = ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents);
      expect(ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents, "house")).toBe(base);
      expect(
        ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents, "house", 32768)
      ).not.toBe(base);
      expect(
        ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents, "house", 32768)
      ).toBe(
        ptrBatchIdempotencyKey("openai/gpt-5.6-luna", "minimal", documents, "house", 32768)
      );
    });
  });

  describe("buildPtrExtractionBody max_completion_tokens", () => {
    const documents = [{ sourceId: "a", pdf: Buffer.from("%PDF-a") }];

    it("omits the cap when unset, preserving today's requests byte for byte", () => {
      const body = buildPtrExtractionBody("openai/gpt-5.6-luna", "minimal", documents);
      expect(body).not.toHaveProperty("max_completion_tokens");
    });

    it("forwards an explicit cap", () => {
      const body = buildPtrExtractionBody("openai/gpt-5.6-luna", "minimal", documents, "house", 32768);
      expect(body).toMatchObject({ max_completion_tokens: 32768 });
    });
  });
});
