import crypto from "crypto";

import type { CompletionClient, CompletionUsage } from "./ports";
import { normalizeOcrWindowRead, ocrCoverageError } from "./ptrRowCoverage";
import { rawImageFileType } from "./utils/rawImageFileType";

/**
 * Schema-bound extraction of House Periodic Transaction Reports, one attachment at a time;
 * amendments are linked to what they amend in a later deterministic step. Row-defining
 * fields are never null: an unmarked type or amount is the explicit value `unmarked`.
 */
export type PtrExtractionContract = "minimal" | "lake";

export const PTR_EXTRACTION_CONTRACT_VERSIONS: Readonly<
  Record<PtrExtractionContract, string>
> = {
  minimal: "house-ptr-minimal-v11",
  lake: "house-ptr-lake-v11",
};

/**
 * The form a request reads. Senate paper reports get their own wording and contract
 * versions, so tuning them cannot move a House row the way House contract v12's
 * wording did (designs/2026-09-14-political-disclosure-lake.md).
 */
export type PtrFormFamily = "house" | "senate_paper";

export const SENATE_PAPER_CONTRACT_VERSIONS: Readonly<Record<PtrExtractionContract, string>> = {
  minimal: "senate-paper-ptr-minimal-v3",
  lake: "senate-paper-ptr-lake-v3",
};

export function ptrContractVersion(contract: PtrExtractionContract, form: PtrFormFamily = "house"): string {
  return (form === "senate_paper" ? SENATE_PAPER_CONTRACT_VERSIONS : PTR_EXTRACTION_CONTRACT_VERSIONS)[contract];
}

export const PTR_UNMARKED = "unmarked";
/** Direct origin: requests take 30-100s and the public host's proxy times them out. */
export const PTR_EXTRACTION_NEXUSGENAI_ORIGIN = "https://nexusgenai-web.fly.dev/api";
/** Dates the model states as YYYY-MM-DD, so no code ever parses a printed date. */
export const PTR_ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
export const PTR_EXACT_AMOUNT = "Exact amount";
/**
 * Largest amount printed as a single figure. Reportable amounts are categories, so a lone
 * figure under this is the filer's own entry and one over it is half of a split range.
 */
export const PTR_EXACT_AMOUNT_MAX = 999.99;
/**
 * Who holds a transaction's asset. The House Ethics instruction guide: include
 * "SP" for spouse, "DC" for dependent children, or "JT" for jointly held
 * property, and filers "may indicate" it, so a blank owner cell is
 * `not_indicated`, never self. Senate reports print Self, Spouse, Joint or Child.
 */
export const PTR_OWNERS = ["self", "spouse", "joint", "dependent_child", "not_indicated"] as const;
export const PTR_TICKER_PATTERN = "^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$";
export const PTR_ASSET_TYPE_CODE_PATTERN = "^[A-Za-z0-9]+$";
export const PTR_SOURCE_TRANSACTION_ID_PATTERN = "^[A-Za-z0-9-]+$";

const TRANSACTION_TYPE_CODES = ["P", "S", "E", PTR_UNMARKED] as const;

const REQUIRED_STRING_FIELDS = ["asset_description", "amount_bracket"] as const;

/**
 * A multi-row transaction prints its date once, on the row that starts it; the rows after
 * it in the same transaction print a blank Date cell. Those continuation rows carry no
 * printed date of their own, so `transaction_date` may be null — the published trade takes
 * its date from `transaction_date_iso`, which nulls with it and is null-safe downstream
 * (`sanitizePoliticalTrades` skips date checks on null). An empty string is the model's
 * rendering of a blank cell and means the same thing.
 */
function printedTransactionDate(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The value categories 5 U.S.C. §13104(d)(1) allows for a transaction, plus the
 * §13104(e)(1)(F) category for a spouse's or dependent child's asset over
 * $1,000,000. Filers print variants (older forms say $1,000; a 2026 amendment
 * letter printed "$1,0001"), so the model names the category and the bounds are
 * derived here. Electronic House filings also print a single exact amount for some
 * transactions (Pelosi: "$1.00" for options that expired worthless, "$15.00" for a
 * spinoff exchange); those use `PTR_EXACT_AMOUNT` with `amount_exact`.
 */
export const PTR_AMOUNT_CATEGORIES = [
  { label: "$1,001 - $15,000", low: 1001, high: 15000 },
  { label: "$15,001 - $50,000", low: 15001, high: 50000 },
  { label: "$50,001 - $100,000", low: 50001, high: 100000 },
  { label: "$100,001 - $250,000", low: 100001, high: 250000 },
  { label: "$250,001 - $500,000", low: 250001, high: 500000 },
  { label: "$500,001 - $1,000,000", low: 500001, high: 1000000 },
  { label: "$1,000,001 - $5,000,000", low: 1000001, high: 5000000 },
  { label: "$5,000,001 - $25,000,000", low: 5000001, high: 25000000 },
  { label: "$25,000,001 - $50,000,000", low: 25000001, high: 50000000 },
  { label: "Over $50,000,000", low: 50000001, high: null },
  { label: "Spouse/DC Over $1,000,000", low: 1000001, high: null },
] as const;

/** NexusGenAI accepts at most 10 images per request, each up to 4 MB (`controller/openAiPassthroughValidation.ts`). */
export const MAX_PAGE_IMAGES_PER_REQUEST = 10;

const AMOUNT_CATEGORY_LABELS: readonly string[] = [
  ...PTR_AMOUNT_CATEGORIES.map((category) => category.label),
  PTR_EXACT_AMOUNT,
  PTR_UNMARKED,
];

/**
 * Bounds of an amount category: the printed amount for "Exact amount", and both
 * null for "unmarked" or an unknown label.
 */
export function ptrAmountBounds(
  category: unknown,
  exactAmount: unknown = null
): { low: number | null; high: number | null } {
  if (category === PTR_EXACT_AMOUNT) {
    return typeof exactAmount === "number" && Number.isFinite(exactAmount)
      ? { low: exactAmount, high: exactAmount }
      : { low: null, high: null };
  }
  const match = PTR_AMOUNT_CATEGORIES.find((entry) => entry.label === category);
  return match ? { low: match.low, high: match.high } : { low: null, high: null };
}

/** True for a model-stated YYYY-MM-DD that names a real calendar day. */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !new RegExp(PTR_ISO_DATE_PATTERN).test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const SYSTEM_PROMPT =
  "Complete the caller's schema-bound extraction task from every attached PDF. " +
  "Return exactly one document result for every supplied source_id and no other " +
  "source_id. Keep every source fact attributed to the PDF where it is visible. " +
  "Never copy, reuse, or complete a field from another attachment, even when rows " +
  "look similar or an attachment amends another. Preserve source row order and " +
  "repeated complete rows. Join wrapped lines to their logical row, but never merge " +
  "two separately printed rows. Copy literal source text when a string field " +
  "represents a printed fact, using only ASCII characters when the source is " +
  "visibly ASCII. Never invent facts from world knowledge. After the first pass, " +
  "audit every row's transaction type and amount against its own PDF. Return only " +
  "the strict structured response.";

const BASE_INSTRUCTIONS = `Extract every separately printed or written transaction row from every attached U.S. House Periodic Transaction Report. A PDF may be an electronic form, a scanned paper form (often rotated or handwritten), an attached schedule, or a signed letter that amends an earlier report.

For each PDF:
- Use the source_id from the source mapping, never a filename or a guessed filing id.
- Return every transaction row in source order, including rows continued on later pages and on attached schedules. Returning only some rows of a multi-row report is a failed extraction.
- A printed example or sample row, one whose asset name begins with "Example" (such as "Example: Mega Corp. Common Stock", however OCR spells it), is not a transaction, even when dates or marks appear in it. An account, trust, or holding-entity header line with no transaction type, date, or amount of its own is not a transaction. A cover page that only refers to an attached schedule has no rows of its own.
- When the report states that there is nothing to report and lists no transaction, return an empty rows array and copy that statement into no_transactions_statement. Otherwise no_transactions_statement is null.
- amended_report_date is the printed Date of Report Being Amended, or the date of the earlier report that an amendment letter corrects, copied as printed; null when the document does not amend an earlier report.
- amended_report_date_iso is amended_report_date written as YYYY-MM-DD; null when absent or not a complete calendar date.
- transaction_type_code is P for a purchase, S for a sale or partial sale, and E for an exchange, read from the printed code or the checked Type of Transaction column. It is "unmarked" when a transaction row has no type printed or checked. Never infer the type from economic meaning, the asset, or neighboring rows.
- transaction_date is the transaction Date column, copied as printed, never the Notification Date column; null when the row prints no date of its own, the blank Date cell of a row that continues a transaction whose date printed on an earlier row.
- transaction_date_iso is that same date written as YYYY-MM-DD with a four-digit year, so a printed 10/5/20 is 2020-10-05; null when the printed date is not a complete calendar date.
- asset_description is the full asset name exactly as printed or written.
- ticker is an exchange symbol shown with the asset name, either in parentheses such as "(AMZN)" or as a trailing symbol token such as "Avantis Intl AVDV". Use ASCII letters and digits only, never visually similar non-ASCII letters. ticker is null when no symbol is shown.
- asset_type_code is the code printed inside square brackets immediately after the asset name, without the bracket characters (ST, not [ST]); null when the form prints none. Paper forms print no asset type code. The owner column (SP, DC, JT) is never an asset type code, and a word inside the asset name such as STK, COM or SHS is part of asset_description, never an asset type code.
- amount_bracket is the Amount of Transaction text copied as printed, or the label of the checked amount column; "unmarked" when no amount is printed or checked.
- amount_category is the legal value category that amount denotes, one of: ${AMOUNT_CATEGORY_LABELS.join("; ")}. On a checkbox form the checked column's position decides it, even when the printed column label is misread or mistyped. A typo such as "$1,0001 - $15,000" still denotes "$1,001 - $15,000", and older forms that print "$1,000 - $15,000" mean that same category. When the column headed "Transaction in a Spouse or Dependent Child Asset over $1,000,000" is checked and no amount range is, amount_category is "Spouse/DC Over $1,000,000". amount_category is "unmarked" exactly when amount_bracket is "unmarked".
- When the form prints one dollar amount under $1,000 instead of a range, such as "$1.00" for options that expired worthless or "$15.00" for shares received in a spinoff, amount_category is "${PTR_EXACT_AMOUNT}" and amount_exact is that number. Otherwise amount_exact is null. A reportable transaction over $1,000 is always reported by category, so a lone amount of $1,000 or more is part of a range split across lines or pages, such as "$50,001 -" at the bottom of one page and "$100,000" after the next page's column headers; amount_category is then the category that contains that amount.
- A checkbox or check mark is data: read which column is visibly marked.
- ocr_rows, non_transaction_rows and continuation_rows are empty arrays for a source that is not numbered OCR text.`;

const PAGE_IMAGE_INSTRUCTIONS = `
- Some sources arrive as page images instead of a PDF. Each image is one page of that source, in page order, introduced by a text line naming its source_id and page.`;

const OCR_TEXT_INSTRUCTIONS = `
- Some sources arrive as OCR text: the machine-read markdown of each page, in page order, introduced by a line naming its source_id and page. OCR can misread characters, place a checkbox mark in the wrong column, or drop empty table cells, so match each mark to its column by that table's header.
- Every page of one form has the same columns in the same order. OCR sometimes garbles one page's column header: a label repeated or dropped, or fewer header cells than the data rows have. When a page's header is garbled, read that page's columns as the same form's cleanly read header on another page names them, never as the garbled labels say.`;

const OCR_ROW_INSTRUCTIONS = `
- In numbered OCR text every non-blank line carries a row label, R1, R2 and so on, numbered across the whole filing: a table line begins with a cell such as "| R12 |", any other line begins with "[R12]", and a table separator line begins with "| --- |" and has no label. The source mapping names each source's row_window. Give every row label inside that window a disposition:
  - A transaction lists in ocr_rows every row label it was read from, as integers (R23 is 23). A transaction whose first row is inside the window may continue onto rows after it; include those rows too. When OCR joined parts of two transactions into one line, both transactions list that row.
  - A row inside the window that holds no part of a transaction (a column-label row, a letterhead, signature or page line, a blank form row, an example row, an account or trust heading) goes in non_transaction_rows.
  - A row at the start of the window that continues a transaction begun before the window goes in continuation_rows, and that earlier transaction is not returned for this source.
- Return only transactions whose first row is inside row_window. Pages and rows outside the window are context for reading, never rows to return. When a source covers part of a filing, the line "=== ROW WINDOW R21-R40 BEGINS ===" comes directly before the window's first row and "=== ROW WINDOW R21-R40 ENDS ===" directly after its last; a transaction that starts above BEGINS or below ENDS belongs to another source.`;

const OCR_WITH_PDF_INSTRUCTIONS = `
- When a source has both OCR text and a PDF, the PDF is the authority: use the OCR text to read characters, and use the PDF to confirm which column each mark sits in and to correct any misread character.`;

const RECONCILE_INSTRUCTIONS = `
- Some sources were already read twice, in two ways that lose information differently, and the two reads disagree about a page this source's rows sit on. For those, the filed pages come with the source's OCR text: a PDF of the same pages as the OCR text, or each page's image after that page's OCR text. Then come crops of those pages holding this source's own rows, enlarged to the resolution the page was scanned at, each with the table's column headers above the rows. A whole page arrives small enough that narrow checkbox columns cannot be counted reliably, so read every mark's column from the crops: where a crop and a whole page disagree about the column a mark sits in, the crop is right. After them come Read A, made from the OCR text alone, and Read B, made from the filed pages alone without the OCR text, each as the JSON that read returned. Read B read each whole page this source's rows sit on, so it also lists transactions that belong to other row windows; each of its rows names its page, and it has no row labels. Return this source's final reading in the shape a read of numbered OCR text returns, for its row window only.
- The OCR text, and so Read A, loses information in known ways:
  - OCR can write one date down a column of small, similar dates. On a brokerage schedule whose rows print 04/13/22, 04/19/22 and 04/21/22, the OCR text gave 04/21/21 on all 73 rows of the page.
  - OCR can put a checkbox mark in a neighboring table cell on some rows while other rows of the same table stay aligned. On one Senate form the OCR text put four rows' amount marks one column right of where they are printed, while the ten rows below them were placed correctly.
  - OCR can give a row an extra empty cell, so a mark falls under the wrong header when cells are counted: a Hanesbrands purchase, its X printed under Purchase, came out of the OCR text as a sale.
  - OCR can misread a digit the same way every time: a date printed 5/22/23 was read as 6/22/23, after the date the report was received.
- A read of the filed pages, and so Read B, loses information in other ways:
  - It can miscount narrow amount columns and place a mark one column away from where it is printed: on a photographed Senate form, an X printed under $500,001 - $1,000,000 was read as Over $1,000,000***.
  - It can misread small or faint characters, and on a dense page it can skip, repeat or merge rows, or stop before the table ends.
- Read every field of this source's transactions from the filed pages, and each mark's column from the crops: find a mark's column by the header printed directly above it, and read dates, names and amounts as printed. A crop settles what it shows. A value that follows from the form's own rules rather than from one cell, such as an owner code printed once in the column header for rows whose own owner cell is blank, still follows that rule, and a blank cell in a crop is not a reason to drop it. Use the OCR text to find each row and its row label. The two reads show where to look, and neither is the answer: where they differ the filed page decides, and a value neither read gave is right when the filed page shows it.
- Settle from the filed pages which rows are transactions and how rows group into transactions.
- When the filed pages hold no transaction table at all — a cover notice stating the filer has nothing to report, for example — return an empty rows array and copy that statement into no_transactions_statement, exactly as a first read would. An empty rows array with a null statement fails the filing, so a page that lists transactions never takes this path.`;

/** Only a request whose sources carry date findings gets this, so every other read keeps contract v11's text. */
const DATE_FINDINGS_INSTRUCTIONS = `
- Some sources come with date findings: a date a prior read gave that cannot be true alongside the other dates of its row or of the report, such as a transaction dated after the day the report was filed, a transaction or notification a month out of order, or a transaction more than a year before its notification. Such a date is usually a misread digit, and both reads can share the misread: a handwritten 6/1/23 whose 2 ran into the slash was read as 6/1/13 by both, beside a notification date of 7/3/23. Read every date a finding names again from the filed pages and crops, digit by digit, comparing each handwritten digit with the same digit written elsewhere on the form. A finding does not make a date wrong: filers misdate forms, and a date the page plainly prints stays as printed.`;

/**
 * Only a repair read gets these (`ptrReadPasses.ts`): a window whose decided read would fail its filing for one of
 * these reasons is read again with the finding, so every read of a filing that passes keeps contract v11's text.
 */
const ASSET_FINDINGS_INSTRUCTIONS = `
- Some sources come with asset findings: a transaction a prior read gave with no asset name, which fails the filing. Filers often mark a row's asset as the same as the row above instead of writing it again: a ditto mark (" or 〃), a word such as "same" or "do.", an arrow or line drawn down the asset column, or an asset cell left blank on a row that has its own type, date or amount. Read each such row's asset cell again from the filed pages and crops. When it repeats the asset above, asset_description is that asset's name as printed above.`;

const KEPT_DATE_FINDINGS_INSTRUCTIONS = `
- Some sources come with reconciled-date findings: a date a reconciling read gave a row although it cannot be true alongside the report's other dates, where Read A, taken from the OCR text of the same row, gives dates that can. A page read can misread a digit that the OCR and Read A got right: a 3 read as a 9 put notifications printed 03/01/23 six months after the report was filed. Read each such date again from the filed pages and crops, digit by digit, comparing each digit with the same digit printed elsewhere on the form, and return the date the page prints.`;

const EMPTY_READ_FINDINGS_INSTRUCTIONS = `
- Some sources come with an empty-read finding: no read of this report found a transaction or a statement that it has none, which fails the filing. Read the filed pages again. When they hold transactions, return them. When they hold none, such as a notice that the filer has nothing to report, or an amendment or letter that corrects an earlier report without listing a transaction of its own (one that corrects a checked box, or withdraws a transaction the earlier report listed), return an empty rows array and copy the sentence that says so, or that states what the amendment corrects, into no_transactions_statement.`;

const PAGE_RANGE_INSTRUCTIONS = `
- Some attachments are a page range of a longer filing; the source mapping lists their pages. For those, return only the rows printed on those pages and an empty rows array when those pages print no transaction row. A row that starts on the last page of a range belongs to that range.`;

const LAKE_INSTRUCTIONS = `
- source_transaction_id is the transaction ID printed on the row, such as 2000090456 in an electronic filing's ID column, copied exactly as printed; null when the row prints none. A filing or document number is never a transaction ID.
- transaction_type_raw is the printed action text or checked column label, such as "S (partial)", "Partial Sale", or "Purchase"; null only when nothing beyond the code is shown.
- owner_code is the owner code that applies to the row, such as SP, DC, JT, Spouse, or Self: the code printed or written in the row's own owner cell; when that cell is blank and the owner column's header holds one owner code in place of the printed SP DC JT legend, that header code; null otherwise. A header that prints the legend of several codes, such as SP DC JT, gives no row an owner.
- owner is who holds the asset, read from owner_code: "spouse" for SP or Spouse, "dependent_child" for DC, Child or Dependent Child, "joint" for JT or Joint, "self" only when the form prints Self, and "not_indicated" when owner_code is null. The owner indicator is optional on House forms, so a row with no owner code is not_indicated, never self.
- partial_sale is true when the row is marked as a partial sale, such as a checked Partial Sale column, a printed "S (partial)" or "Sale (Partial)"; otherwise false. A partial sale's transaction_type_code is S.
- notification_date is the Notification Date column; null when absent or blank.
- notification_date_iso is notification_date written as YYYY-MM-DD with a four-digit year; null when absent or not a complete calendar date.
- filing_status is the row-level status such as New or Amended. Every row of a report or letter that amends an earlier report is Amended. null when absent.
- transaction_description is the exact description, comment, or margin note printed or written with the row, including option terms; null when absent.
- cap_gains_over_200 is the "Cap. Gains > $200?" mark when the form has that column; null otherwise.`;

const SENATE_PAPER_BASE_INSTRUCTIONS = `Extract every separately printed or written transaction row from every attached U.S. Senate paper Periodic Transaction Report. Each source is the scanned pages of one report filed with the Secretary of the Senate: the "Periodic Disclosure of Financial Transactions" form, typed or handwritten and often rotated, sometimes with a counsel's cover letter before it and attached schedules or broker confirmations after it.

For each source:
- Use the source_id from the source mapping, never a filename or a guessed filing id.
- Return every transaction row in source order, including rows on "TRANSACTIONS (continued)" pages and on attached schedules. Returning only some rows of a multi-row report is a failed extraction.
- The form's printed Example block, IBM Corp. (stock) NYSE and (DC) Microsoft (stock) NASDAQ/OTC with E X A M P L E across the amount columns, is not a transaction wherever it appears.
- An account, trust, or holding-entity header line with no transaction type, date, or amount of its own, such as "(S) Example Family Holdings LLC:", is not a transaction. Each row beneath it is its own transaction.
- A cover letter has no rows of its own. A form row that only points to an attachment, such as "See Attachment", has no row of its own; the attached schedule's rows are the transactions.
- A broker's trade confirmation attached for a transaction the form already lists adds no row.
- When the report states that there is nothing to report and lists no transaction, return an empty rows array and copy that statement into no_transactions_statement. Otherwise no_transactions_statement is null.
- amended_report_date is the date of the earlier report this report amends, copied as printed; null when none is printed. A checked Amendment box gives no date.
- amended_report_date_iso is amended_report_date written as YYYY-MM-DD; null when absent or not a complete calendar date.
- transaction_type_code is P for a purchase, S for a sale, and E for an exchange, read from the checked Purchase, Sale or Exchange column, or from the Purchases or Sales heading a schedule lists the row under. It is "unmarked" when a transaction row has no type checked or stated. Never infer the type from economic meaning, the asset, or neighboring rows.
- transaction_date is the Transaction Date column, copied as printed; null when the row prints no date of its own, the blank Date cell of a row that continues a transaction whose date printed on an earlier row. A date inside the asset name, such as an option's expiration or a bond's maturity, is never the transaction date.
- transaction_date_iso is that same date written as YYYY-MM-DD with a four-digit year, so a printed 6/8/16 is 2016-06-08; null when the printed date is not a complete calendar date.
- asset_description is the full asset name exactly as printed or written, without the owner code.
- On a typed schedule, a row whose description cell is blank continues the asset named on the row above it (the same asset bought or sold again on another date or in another amount); its asset_description is that asset's name as printed above.
- ticker is a stock symbol printed with the asset name, such as "(XYZ)" or the ABC in "(ABC- NASDAQ)". An exchange name (NYSE, NASDAQ, NASDAQ/OTC), a security type such as (stock), and any other marker that is not the security's symbol are not tickers. Use ASCII letters and digits only. ticker is null when no symbol is shown.
- asset_type_code is null. Senate paper forms print no asset type code.
- amount_bracket is the label of the checked Amount of Transaction column, or the amount a schedule prints; "unmarked" when no amount is checked or printed.
- amount_category is the legal value category that amount denotes, one of: ${AMOUNT_CATEGORY_LABELS.join("; ")}. The form's amount columns are, in order: $1,001 - $15,000; $15,001 - $50,000; $50,001 - $100,000; $100,001 - $250,000; $250,001 - $500,000; $500,001 - $1,000,000; Over $1,000,000***; $1,000,001 - $5,000,000; $5,000,001 - $25,000,000; $25,000,001 - $50,000,000; Over $50,000,000. The checked column's position decides the category, even when a printed column label is misread. The Over $1,000,000*** column is for a spouse's or dependent child's asset, so a mark there is "Spouse/DC Over $1,000,000". A schedule's "$1,001-15,000" is "$1,001 - $15,000". amount_category is "unmarked" exactly when amount_bracket is "unmarked".
- amount_exact is null unless the report prints one dollar amount under $1,000 instead of a category; then amount_category is "${PTR_EXACT_AMOUNT}" and amount_exact is that number.
- A checkbox or X mark is data: read which column is visibly marked.
- In OCR text a table row can hold more or fewer empty cells than the column header row, so a mark's column is never found by counting cells from the left edge or from the asset name. Count from the row's own Transaction Date cell instead: the Purchase, Sale and Exchange cells come before it and the amount cells after it, in the form's order. On a page that prints the Example block, calibrate those counts with it: IBM Corp. is marked Purchase and $15,001 - $50,000, and (DC) Microsoft is marked Sale and $100,001 - $250,000, so a transaction's mark that sits the same number of cells before or after its own date as an example's mark is in that example mark's column. For instance, when the IBM Corp. row reads "| IBM Corp. (stock) NYSE | X |  |  | 2 / 1 / 1X |  | X |" and a transaction row reads "| 2 | (S) Example Co. |  | X |  |  | 1/2/20 |  | X |", the transaction's type mark is three cells before its date, as IBM's Purchase mark is, so it is a Purchase, and its amount mark is two cells after its date, as IBM's is, so it is $15,001 - $50,000; the extra empty cell after its asset name is padding. A "TRANSACTIONS (continued)" page prints no Example block: read its rows by that page's own column header, counting from each row's date cell, and never calibrate them with another page's Example block. The letters E X A M P L E across the example rows' amount cells are not marks.
- A footnote printed below the table, marked by a small number before an asset name, is not a transaction. In numbered OCR text its row goes in non_transaction_rows and is never listed in a transaction's ocr_rows, even when that transaction copies the footnote into transaction_description.
- ocr_rows, non_transaction_rows and continuation_rows are empty arrays for a source that is not numbered OCR text.`;

const SENATE_PAPER_LAKE_INSTRUCTIONS = `
- source_transaction_id is null. Senate paper forms print no transaction ID.
- transaction_type_raw is the checked column label or schedule heading, such as "Sale" or "Purchases"; null only when nothing beyond the code is shown.
- owner_code is the owner code printed with the row, from the form's legend (S) Spouse, (DC) Dependent Child, (J) Joint: written before the asset name, alone in a narrow cell before it, or after it as a word such as "(SPOUSE)". Copy it without parentheses, such as S, DC, J or SPOUSE; null when the row prints none.
- owner is who holds the asset, read from owner_code: "spouse" for S or SPOUSE, "dependent_child" for DC, "joint" for J, and "not_indicated" when owner_code is null. A row with no owner code is not_indicated, never self, even when its account names the filer.
- partial_sale is true only when the row itself says the sale was partial; otherwise false. A partial sale's transaction_type_code is S.
- notification_date and notification_date_iso are null. Senate paper forms have no notification date column.
- filing_status is "Amended" for every row of a report whose Amendment box is checked or that says it amends an earlier report; null otherwise.
- transaction_description is a comment or footnote printed for the row, such as option terms or where distributed shares came from; null when absent.
- cap_gains_over_200 is null.`;

interface JsonSchemaProperty {
  type: string | string[];
  enum?: readonly (string | null)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProperty;
}

export interface PtrPageRange {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  total: number;
}

/** Numbered OCR table rows a source must account for (R`first`..R`last` of the filing's R1..R`rowCount`). */
export interface PtrRowWindow {
  first: number;
  last: number;
  rowCount: number;
}

export interface PtrDocumentInput {
  sourceId: string;
  /** Absent for a report filed as page images. */
  pdf?: Buffer;
  /** Set when the attachment is a page range of a longer filing. */
  pages?: PtrPageRange;
  /** Page images in page order, PNG or JPEG. Without OCR text they are sent instead of the PDF. */
  pageImages?: Buffer[];
  /** OCR markdown, one entry per page in page order. Sent instead of the PDF unless ocrWithPdf. */
  ocrPages?: string[];
  /** 1-based page number of `ocrPages[0]`; defaults to the page range start, else 1. */
  ocrFirstPage?: number;
  /** The numbered OCR rows this source must account for. */
  rowWindow?: PtrRowWindow;
  /** Attach the PDF, holding the same pages as the OCR text, after the OCR text. */
  ocrWithPdf?: boolean;
  /** Send each page's image after its OCR text; `pageImages` then holds one image per OCR page. */
  ocrWithPageImages?: boolean;
  /** Crops of the filed pages covering this source's own rows, sent after them for a reconciling read. */
  evidenceImages?: Buffer[];
  /** Both map reads of this source, sent after its OCR text and filed pages for a reconciling read. */
  priorReads?: readonly PtrPriorRead[];
  /** Dates the prior reads gave that cannot all be true (`ptrDateChecks.ts`), stated to the reconciling read. */
  dateFindings?: readonly string[];
  /** Transactions the decided read gave without an asset name, stated to a repair read. */
  assetFindings?: readonly string[];
  /** That no read of the report found a transaction or a no-transactions statement, stated to a repair read. */
  emptyReadFindings?: readonly string[];
  /** Dates a reconciling read kept with a date finding where Read A's row passes, stated to a repair read. */
  keptDateFindings?: readonly string[];
}

/** An earlier read of a source, shown to a reconciling read under `label`. */
export interface PtrPriorRead {
  label: string;
  result: PtrDocumentResult;
}

export interface PtrDocumentResult {
  sourceId: string;
  rows: Array<Record<string, unknown>>;
  noTransactionsStatement: string | null;
  amendedReportDate: string | null;
  amendedReportDateIso: string | null;
  /** Numbered OCR rows the model says are not transactions. */
  nonTransactionRows: number[];
  /** Numbered OCR rows the model says continue a transaction from before its window. */
  continuationRows: number[];
  invalidRowIndexes: number[];
  /** Rows that carry an explicitly unmarked type or amount. Retained, never guessed. */
  reviewRowIndexes: number[];
  error: string | null;
}

export interface PtrParsedResponse {
  documents: PtrDocumentResult[];
  unknownSourceIds: string[];
}

export interface PtrBatchResult extends PtrParsedResponse {
  contractVersion: string;
  requestedModel: string;
  servedModel: string | null;
  usage: CompletionUsage;
  latencyMs: number;
  rawResponse: Record<string, unknown>;
}

export interface ExtractPtrBatchOptions {
  model: string;
  contract: PtrExtractionContract;
  /** House when absent. */
  form?: PtrFormFamily;
  documents: readonly PtrDocumentInput[];
  idempotencyKey?: string;
  /** Client-side ceiling for this request; the transport default applies when absent. */
  timeoutMs?: number;
  /** Provider output cap for this batch; the gateway default applies when absent. */
  maxCompletionTokens?: number;
}

function rowProperties(
  contract: PtrExtractionContract
): Record<string, JsonSchemaProperty> {
  const base: Record<string, JsonSchemaProperty> = {
    transaction_type_code: { type: "string", enum: TRANSACTION_TYPE_CODES },
    transaction_date: { type: ["string", "null"] },
    transaction_date_iso: { type: ["string", "null"], pattern: PTR_ISO_DATE_PATTERN },
    asset_description: { type: "string" },
    ticker: { type: ["string", "null"], pattern: PTR_TICKER_PATTERN },
    asset_type_code: {
      type: ["string", "null"],
      pattern: PTR_ASSET_TYPE_CODE_PATTERN,
    },
    amount_bracket: { type: "string" },
    amount_category: { type: "string", enum: AMOUNT_CATEGORY_LABELS },
    amount_exact: { type: ["number", "null"], minimum: 0, maximum: PTR_EXACT_AMOUNT_MAX },
    ocr_rows: { type: "array", items: { type: "integer" } },
  };
  if (contract === "minimal") return base;
  return {
    ...base,
    source_transaction_id: { type: ["string", "null"], pattern: PTR_SOURCE_TRANSACTION_ID_PATTERN },
    transaction_type_raw: { type: ["string", "null"] },
    owner_code: { type: ["string", "null"] },
    owner: { type: "string", enum: PTR_OWNERS },
    partial_sale: { type: "boolean" },
    notification_date: { type: ["string", "null"] },
    notification_date_iso: { type: ["string", "null"], pattern: PTR_ISO_DATE_PATTERN },
    filing_status: { type: ["string", "null"] },
    transaction_description: { type: ["string", "null"] },
    cap_gains_over_200: { type: ["boolean", "null"] },
  };
}

export function buildPtrResponseSchema(
  contract: PtrExtractionContract,
  sourceIds: readonly string[]
): Record<string, unknown> {
  const properties = rowProperties(contract);
  return {
    type: "object",
    additionalProperties: false,
    required: ["documents"],
    properties: {
      documents: {
        type: "array",
        minItems: sourceIds.length,
        maxItems: sourceIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "source_id",
            "no_transactions_statement",
            "amended_report_date",
            "amended_report_date_iso",
            "non_transaction_rows",
            "continuation_rows",
            "rows",
          ],
          properties: {
            source_id: { type: "string", enum: [...sourceIds] },
            no_transactions_statement: { type: ["string", "null"] },
            amended_report_date: { type: ["string", "null"] },
            amended_report_date_iso: { type: ["string", "null"], pattern: PTR_ISO_DATE_PATTERN },
            non_transaction_rows: { type: "array", items: { type: "integer" } },
            continuation_rows: { type: "array", items: { type: "integer" } },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: Object.keys(properties),
                properties,
              },
            },
          },
        },
      },
    },
  };
}

/** Which source forms a request carries, so the instructions describe only those. */
export interface PtrSourceForms {
  pageRanges?: boolean;
  pageImages?: boolean;
  ocrText?: boolean;
  ocrRowWindows?: boolean;
  ocrWithPdf?: boolean;
  priorReads?: boolean;
  dateFindings?: boolean;
  assetFindings?: boolean;
  emptyReadFindings?: boolean;
  keptDateFindings?: boolean;
}

export function ptrExtractionInstructions(
  contract: PtrExtractionContract,
  sources: PtrSourceForms = {},
  form: PtrFormFamily = "house"
): string {
  const fields = Object.keys(rowProperties(contract)).join(", ");
  const senatePaper = form === "senate_paper";
  const base = senatePaper ? SENATE_PAPER_BASE_INSTRUCTIONS : BASE_INSTRUCTIONS;
  const lake = senatePaper ? SENATE_PAPER_LAKE_INSTRUCTIONS : LAKE_INSTRUCTIONS;
  return (
    `${base}${sources.pageRanges ? PAGE_RANGE_INSTRUCTIONS : ""}` +
    `${sources.pageImages ? PAGE_IMAGE_INSTRUCTIONS : ""}` +
    `${sources.ocrText ? OCR_TEXT_INSTRUCTIONS : ""}` +
    `${sources.ocrRowWindows ? OCR_ROW_INSTRUCTIONS : ""}` +
    `${sources.ocrWithPdf && !sources.priorReads ? OCR_WITH_PDF_INSTRUCTIONS : ""}` +
    `${sources.priorReads ? RECONCILE_INSTRUCTIONS : ""}` +
    `${sources.priorReads && sources.dateFindings ? DATE_FINDINGS_INSTRUCTIONS : ""}` +
    `${sources.priorReads && sources.assetFindings ? ASSET_FINDINGS_INSTRUCTIONS : ""}` +
    `${sources.priorReads && sources.emptyReadFindings ? EMPTY_READ_FINDINGS_INSTRUCTIONS : ""}` +
    `${sources.priorReads && sources.keptDateFindings ? KEPT_DATE_FINDINGS_INSTRUCTIONS : ""}` +
    `${contract === "lake" ? lake : ""}` +
    `\n- Use null only for a genuinely absent optional field, never to avoid reading a visible value.\n\n` +
    `Return one JSON object with a documents array. Include every mapped source_id exactly once, with its no_transactions_statement, amended_report_date, amended_report_date_iso, non_transaction_rows, continuation_rows, and rows. ` +
    `Every row must contain exactly: ${fields}.`
  );
}

/** A findings list as one prompt part after a source's prior reads; none when the list is empty. */
function findingsPart(
  sourceId: string,
  heading: string,
  findings: readonly string[] | undefined
): Array<Record<string, unknown>> {
  if (!findings?.length) return [];
  return [{ type: "text", text: `source_id ${sourceId}, ${heading}:\n${findings.map((finding) => `- ${finding}`).join("\n")}` }];
}

/** An earlier read as the model returned it, with the reason it failed its own checks when it did. */
function priorReadJson(result: PtrDocumentResult): Record<string, unknown> {
  return {
    no_transactions_statement: result.noTransactionsStatement,
    amended_report_date: result.amendedReportDate,
    amended_report_date_iso: result.amendedReportDateIso,
    non_transaction_rows: result.nonTransactionRows,
    continuation_rows: result.continuationRows,
    rows: result.rows,
    ...(result.error ? { failed_checks: result.error } : {}),
  };
}

function attachmentLabel(document: PtrDocumentInput, index: number): string {
  const name = `source-${index + 1}`;
  if (document.ocrPages) {
    const read = document.ocrWithPdf
      ? `${name}.pdf and ${name} OCR text`
      : document.ocrWithPageImages
        ? `${name} OCR text and page images`
        : `${name} OCR text`;
    return document.priorReads?.length
      ? `${read}, then ${document.priorReads.map((prior) => prior.label).join(" and ")}`
      : read;
  }
  return document.pageImages ? `${name} page images` : `${name}.pdf`;
}

export function buildPtrExtractionBody(
  model: string,
  contract: PtrExtractionContract,
  documents: readonly PtrDocumentInput[],
  form: PtrFormFamily = "house",
  /**
   * Opt-in provider output cap, forwarded as `max_completion_tokens`. Absent
   * leaves completion length to the gateway default; the planner's row packing
   * is what keeps answers under it either way.
   */
  maxCompletionTokens?: number
): Record<string, unknown> {
  const sourceIds = documents.map((document) => document.sourceId);
  const mapping = documents.map((document, index) => ({
    attachment: attachmentLabel(document, index),
    source_id: document.sourceId,
    ...(document.pages
      ? { pages: `${document.pages.start}-${document.pages.end} of ${document.pages.total}` }
      : {}),
    ...(document.rowWindow
      ? {
          row_window: `R${document.rowWindow.first}-R${document.rowWindow.last} of R${document.rowWindow.rowCount}`,
        }
      : {}),
  }));
  const sources: PtrSourceForms = {
    pageRanges: documents.some((document) => document.pages),
    pageImages: documents.some(
      (document) => document.pageImages && !document.ocrPages
    ),
    ocrText: documents.some((document) => document.ocrPages),
    ocrRowWindows: documents.some((document) => document.rowWindow),
    ocrWithPdf: documents.some(
      (document) => document.ocrPages && document.ocrWithPdf
    ),
    priorReads: documents.some((document) => (document.priorReads?.length ?? 0) > 0),
    dateFindings: documents.some((document) => (document.dateFindings?.length ?? 0) > 0),
    assetFindings: documents.some((document) => (document.assetFindings?.length ?? 0) > 0),
    emptyReadFindings: documents.some((document) => (document.emptyReadFindings?.length ?? 0) > 0),
    keptDateFindings: documents.some((document) => (document.keptDateFindings?.length ?? 0) > 0),
  };
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text:
        `# Source mapping\n${JSON.stringify(mapping)}\n\n` +
        `# Task instructions\n${ptrExtractionInstructions(contract, sources, form)}`,
    },
    ...documents.flatMap((document, index): Array<Record<string, unknown>> => {
      const firstPage = document.ocrFirstPage ?? document.pages?.start ?? 1;
      const pdfPart = (): Record<string, unknown> => {
        if (!document.pdf) throw new Error(`${document.sourceId} has no PDF to attach`);
        return {
          type: "file",
          file: {
            filename: `source-${index + 1}.pdf`,
            file_data: `data:application/pdf;base64,${document.pdf.toString(
              "base64"
            )}`,
          },
        };
      };
      if (document.ocrPages) {
        const pageImages = document.ocrWithPageImages ? document.pageImages ?? [] : [];
        if (document.ocrWithPageImages && pageImages.length !== document.ocrPages.length) {
          throw new Error(
            `${document.sourceId} has ${pageImages.length} page images for ${document.ocrPages.length} OCR pages`
          );
        }
        return [
          ...document.ocrPages.flatMap((markdown, pageOffset): Array<Record<string, unknown>> => [
            {
              type: "text",
              text: `source_id ${document.sourceId}, page ${
                firstPage + pageOffset
              }, OCR text:\n${markdown}`,
            },
            ...(document.ocrWithPageImages
              ? [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${rawImageFileType(pageImages[pageOffset]!).contentType};base64,${pageImages[
                        pageOffset
                      ]!.toString("base64")}`,
                    },
                  },
                ]
              : []),
          ]),
          ...(document.ocrWithPdf ? [pdfPart()] : []),
          ...(document.evidenceImages ?? []).flatMap((image, crop): Array<Record<string, unknown>> => [
            {
              type: "text",
              text:
                `source_id ${document.sourceId}, its own rows enlarged from the filed page, ` +
                `crop ${crop + 1} of ${document.evidenceImages?.length ?? 0}:`,
            },
            {
              type: "image_url",
              image_url: { url: `data:${rawImageFileType(image).contentType};base64,${image.toString("base64")}` },
            },
          ]),
          ...(document.priorReads ?? []).map((prior) => ({
            type: "text",
            text: `source_id ${document.sourceId}, ${prior.label}:\n${JSON.stringify(priorReadJson(prior.result))}`,
          })),
          ...findingsPart(document.sourceId, "date findings", document.dateFindings),
          ...findingsPart(document.sourceId, "asset findings", document.assetFindings),
          ...findingsPart(document.sourceId, "empty-read findings", document.emptyReadFindings),
          ...findingsPart(document.sourceId, "reconciled-date findings", document.keptDateFindings),
        ];
      }
      if (!document.pageImages) return [pdfPart()];
      return document.pageImages.flatMap((image, pageOffset) => [
        {
          type: "text",
          text: `source_id ${document.sourceId}, page ${firstPage + pageOffset}:`,
        },
        {
          type: "image_url",
          image_url: { url: `data:${rawImageFileType(image).contentType};base64,${image.toString("base64")}` },
        },
      ]);
    }),
  ];
  return {
    model,
    temperature: 0,
    ...(maxCompletionTokens !== undefined ? { max_completion_tokens: maxCompletionTokens } : {}),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "extract_ptr_documents",
        strict: true,
        schema: buildPtrResponseSchema(contract, sourceIds),
      },
    },
  };
}

export function responseText(response: Record<string, unknown>): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first: unknown = choices[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("model response omitted choices[0]");
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("model response omitted choices[0].message");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return "";
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  throw new Error("model response omitted textual content");
}

/** A rejected value, short enough for a failure message and safe on a long asset name. */
function showRowValue(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "string") {
    return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * Why a row cannot be published, or null when it can.
 *
 * The reason is known here and recorded nowhere else. Returning a boolean discarded it at
 * fourteen separate rejection points, so a filing came back as `invalid rows: 1108` — one
 * message standing for fourteen unrelated defects, which nobody can act on and no amount of
 * re-extraction explains. Name the field and show the value that failed.
 */
export function ptrRowInvalidReason(row: Record<string, unknown>): string | null {
  const code = row.transaction_type_code;
  if (
    typeof code !== "string" ||
    !(TRANSACTION_TYPE_CODES as readonly string[]).includes(code)
  ) {
    return `transaction_type_code ${showRowValue(code)} is not one of ${TRANSACTION_TYPE_CODES.join(", ")}`;
  }
  if (printedTransactionDate(row.transaction_date) === null && row.transaction_date != null) {
    return `transaction_date ${showRowValue(row.transaction_date)} is neither a printed date nor null`;
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = row[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return `${field} is ${showRowValue(value)}`;
    }
  }
  const category = row.amount_category;
  if (typeof category !== "string" || !AMOUNT_CATEGORY_LABELS.includes(category)) {
    return `amount_category ${showRowValue(category)} is not a legal value category`;
  }
  if ((row.amount_bracket === PTR_UNMARKED) !== (category === PTR_UNMARKED)) {
    return `amount_bracket ${showRowValue(row.amount_bracket)} and amount_category ${showRowValue(category)} disagree about being ${PTR_UNMARKED}`;
  }
  const exactAmount = row.amount_exact;
  const hasExactAmount =
    typeof exactAmount === "number" && Number.isFinite(exactAmount);
  if ((category === PTR_EXACT_AMOUNT) !== hasExactAmount) {
    return `amount_category ${showRowValue(category)} does not match amount_exact ${showRowValue(exactAmount)}`;
  }
  if (hasExactAmount && (exactAmount < 0 || exactAmount > PTR_EXACT_AMOUNT_MAX)) {
    return `amount_exact ${exactAmount} is outside 0..${PTR_EXACT_AMOUNT_MAX}`;
  }
  const isoDate = row.transaction_date_iso;
  if (isoDate !== null && !isIsoCalendarDate(isoDate)) {
    return `transaction_date_iso ${showRowValue(isoDate)} is not a calendar date`;
  }
  if (!Array.isArray(row.ocr_rows) || !row.ocr_rows.every((value) => Number.isInteger(value))) {
    return `ocr_rows ${showRowValue(row.ocr_rows)} is not a list of integers`;
  }
  if ("owner" in row && !(PTR_OWNERS as readonly unknown[]).includes(row.owner)) {
    return `owner ${showRowValue(row.owner)} is not a known owner`;
  }
  if ("partial_sale" in row) {
    if (typeof row.partial_sale !== "boolean") {
      return `partial_sale ${showRowValue(row.partial_sale)} is not a boolean`;
    }
  }
  const ticker = row.ticker;
  if (ticker !== null && ticker !== undefined) {
    if (
      typeof ticker !== "string" ||
      !new RegExp(PTR_TICKER_PATTERN).test(ticker)
    ) {
      return `ticker ${showRowValue(ticker)} does not match ${PTR_TICKER_PATTERN}`;
    }
  }
  const assetTypeCode = row.asset_type_code;
  if (assetTypeCode !== null && assetTypeCode !== undefined) {
    if (
      typeof assetTypeCode !== "string" ||
      !new RegExp(PTR_ASSET_TYPE_CODE_PATTERN).test(assetTypeCode)
    ) {
      return `asset_type_code ${showRowValue(assetTypeCode)} does not match ${PTR_ASSET_TYPE_CODE_PATTERN}`;
    }
  }
  const sourceTransactionId = row.source_transaction_id;
  if (sourceTransactionId !== null && sourceTransactionId !== undefined) {
    if (
      typeof sourceTransactionId !== "string" ||
      !new RegExp(PTR_SOURCE_TRANSACTION_ID_PATTERN).test(sourceTransactionId)
    ) {
      return `source_transaction_id ${showRowValue(sourceTransactionId)} does not match ${PTR_SOURCE_TRANSACTION_ID_PATTERN}`;
    }
  }
  return null;
}

export function isValidPtrRow(row: Record<string, unknown>): boolean {
  return ptrRowInvalidReason(row) === null;
}

export function ptrRowNeedsReview(row: Record<string, unknown>): boolean {
  return (
    row.transaction_type_code === PTR_UNMARKED ||
    row.amount_category === PTR_UNMARKED
  );
}

function emptyResult(sourceId: string, error: string | null): PtrDocumentResult {
  return {
    sourceId,
    rows: [],
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows: [],
    continuationRows: [],
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function integerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isInteger(item))
    : [];
}

/** Attach the bounds of a row's amount category; a row without one is left as returned. */
function withAmountBounds(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.amount_category !== "string") return row;
  const bounds = ptrAmountBounds(row.amount_category, row.amount_exact);
  return { ...row, amount_low: bounds.low, amount_high: bounds.high };
}

/** A blank or absent printed date becomes null: the continuation rows of a multi-row transaction print none. */
function withNullBlankDate(row: Record<string, unknown>): Record<string, unknown> {
  const value = row.transaction_date;
  if (value === undefined) return { ...row, transaction_date: null };
  if (typeof value === "string" && value.trim().length === 0) return { ...row, transaction_date: null };
  return row;
}

interface ParsedDocument {
  rows: Array<Record<string, unknown>>;
  noTransactionsStatement: string | null;
  amendedReportDate: string | null;
  amendedReportDateIso: string | null;
  nonTransactionRows: number[];
  continuationRows: number[];
}

export interface PtrSourceExpectation {
  /** A page range or a partial row window may legitimately hold no transaction. */
  emptyAllowed: boolean;
  /** Numbered OCR rows the read must give a disposition. */
  rowWindow?: PtrRowWindow;
}

export function ptrSourceExpectations(
  sources: ReadonlyArray<Pick<PtrDocumentInput, "sourceId" | "pages" | "rowWindow">>
): Map<string, PtrSourceExpectation> {
  return new Map(
    sources.map((source): [string, PtrSourceExpectation] => [
      source.sourceId,
      {
        emptyAllowed: Boolean(
          source.pages ||
            (source.rowWindow &&
              (source.rowWindow.first !== 1 || source.rowWindow.last !== source.rowWindow.rowCount))
        ),
        ...(source.rowWindow ? { rowWindow: source.rowWindow } : {}),
      },
    ])
  );
}

/**
 * Map a structured response back onto the requested source ids. A missing,
 * duplicated, or unparseable document becomes a per-document error rather
 * than a thrown exception, so the caller can re-run exactly that subset. A
 * whole document may be empty only with its own no-transactions statement, and
 * a row window read must give every row in its window a disposition.
 */
export function parsePtrExtractionResponse(
  response: Record<string, unknown>,
  sourceIds: readonly string[],
  expectations: ReadonlyMap<string, PtrSourceExpectation> = new Map()
): PtrParsedResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText(response));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      documents: sourceIds.map((id) =>
        emptyResult(id, `unparseable response: ${message}`)
      ),
      unknownSourceIds: [],
    };
  }
  const documents =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).documents
      : undefined;
  if (!Array.isArray(documents)) {
    return {
      documents: sourceIds.map((id) =>
        emptyResult(id, "structured response omitted documents[]")
      ),
      unknownSourceIds: [],
    };
  }

  const requested = new Set(sourceIds);
  const seen = new Map<string, ParsedDocument>();
  const duplicates = new Set<string>();
  const unknownSourceIds: string[] = [];
  for (const document of documents) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      continue;
    }
    const record = document as Record<string, unknown>;
    const sourceId = record.source_id;
    if (typeof sourceId !== "string") continue;
    if (!requested.has(sourceId)) {
      unknownSourceIds.push(sourceId);
      continue;
    }
    if (seen.has(sourceId)) {
      duplicates.add(sourceId);
      continue;
    }
    seen.set(sourceId, {
      rows: Array.isArray(record.rows)
        ? record.rows
            .filter(
              (row: unknown): row is Record<string, unknown> =>
                Boolean(row) && typeof row === "object" && !Array.isArray(row)
            )
            .map(withNullBlankDate)
            .map(withAmountBounds)
        : [],
      noTransactionsStatement: nonEmptyString(record.no_transactions_statement),
      amendedReportDate: nonEmptyString(record.amended_report_date),
      amendedReportDateIso: isIsoCalendarDate(record.amended_report_date_iso)
        ? record.amended_report_date_iso
        : null,
      nonTransactionRows: integerArray(record.non_transaction_rows),
      continuationRows: integerArray(record.continuation_rows),
    });
  }

  return {
    documents: sourceIds.map((sourceId): PtrDocumentResult => {
      if (duplicates.has(sourceId)) {
        return emptyResult(sourceId, "conflicting duplicate results for source_id");
      }
      const document = seen.get(sourceId);
      if (!document) return emptyResult(sourceId, "response omitted source_id");
      const expectation = expectations.get(sourceId);
      // Row labels exist only in numbered OCR text; elsewhere a stray row list is dropped
      // so it cannot keep otherwise identical reads from agreeing. A row window read keeps
      // only what its window owns (`normalizeOcrWindowRead`).
      const { noTransactionsStatement, amendedReportDate, amendedReportDateIso } = document;
      const owned = expectation?.rowWindow
        ? normalizeOcrWindowRead({
            sourceId,
            window: expectation.rowWindow,
            rows: document.rows,
            nonTransactionRows: document.nonTransactionRows,
            continuationRows: document.continuationRows,
          })
        : null;
      const rows = owned ? [...owned.rows] : document.rows.map((row) => ({ ...row, ocr_rows: [] }));
      const nonTransactionRows = owned ? [...owned.nonTransactionRows] : [];
      const continuationRows = owned ? [...owned.continuationRows] : [];
      let error: string | null = null;
      if (rows.length === 0 && !noTransactionsStatement && !expectation?.emptyAllowed) {
        error = "document returned no rows and no no-transactions statement";
      } else if (rows.length > 0 && noTransactionsStatement) {
        error = "document returned rows and a no-transactions statement";
      } else if (expectation?.rowWindow) {
        error = ocrCoverageError({
          sourceId,
          window: expectation.rowWindow,
          rows,
          nonTransactionRows,
          continuationRows,
        });
      }
      return {
        sourceId,
        rows,
        noTransactionsStatement,
        amendedReportDate,
        amendedReportDateIso,
        nonTransactionRows,
        continuationRows,
        invalidRowIndexes: rows.flatMap((row, index) =>
          isValidPtrRow(row) ? [] : [index]
        ),
        reviewRowIndexes: rows.flatMap((row, index) =>
          ptrRowNeedsReview(row) ? [index] : []
        ),
        error,
      };
    }),
    unknownSourceIds,
  };
}

export function ptrBatchIdempotencyKey(
  model: string,
  contract: PtrExtractionContract,
  documents: readonly PtrDocumentInput[],
  form: PtrFormFamily = "house",
  /**
   * A repeat at a different cap must not replay the earlier winner: the
   * gateway keys repeats too, so both sides agree on what "same" means.
   */
  maxCompletionTokens?: number
): string {
  const hash = crypto.createHash("sha256");
  hash.update(ptrContractVersion(contract, form));
  hash.update("\0");
  hash.update(String(model));
  if (maxCompletionTokens !== undefined) {
    hash.update("\0");
    hash.update(`max-completion-tokens:${maxCompletionTokens}`);
  }
  for (const document of documents) {
    hash.update("\0");
    hash.update(document.sourceId);
    hash.update("\0");
    if (document.pdf) hash.update(crypto.createHash("sha256").update(document.pdf).digest());
    for (const image of [...(document.pageImages ?? []), ...(document.evidenceImages ?? [])]) {
      hash.update(crypto.createHash("sha256").update(image).digest());
    }
    for (const page of document.ocrPages ?? []) {
      hash.update(crypto.createHash("sha256").update(page).digest());
    }
    hash.update(JSON.stringify([document.ocrFirstPage ?? null, document.rowWindow ?? null]));
    if (document.ocrWithPdf) hash.update("ocr-with-pdf");
    if (document.ocrWithPageImages) hash.update("ocr-with-page-images");
    if (document.priorReads?.length) {
      hash.update(JSON.stringify(document.priorReads.map((prior) => [prior.label, priorReadJson(prior.result)])));
    }
    if (document.dateFindings?.length) hash.update(JSON.stringify(["date-findings", document.dateFindings]));
    if (document.assetFindings?.length) hash.update(JSON.stringify(["asset-findings", document.assetFindings]));
    if (document.emptyReadFindings?.length) {
      hash.update(JSON.stringify(["empty-read-findings", document.emptyReadFindings]));
    }
    if (document.keptDateFindings?.length) {
      hash.update(JSON.stringify(["kept-date-findings", document.keptDateFindings]));
    }
  }
  return `ptr-extraction-${hash.digest("hex")}`;
}

export async function extractPtrBatch(
  client: CompletionClient,
  options: ExtractPtrBatchOptions
): Promise<PtrBatchResult> {
  if (options.documents.length === 0) {
    throw new Error("extractPtrBatch requires at least one document");
  }
  const sourceIds = options.documents.map((document) => document.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("extractPtrBatch received duplicate source ids");
  }
  const started = Date.now();
  const { usage, payload } = await client.complete({
    model: options.model,
    body: buildPtrExtractionBody(
      options.model,
      options.contract,
      options.documents,
      options.form,
      options.maxCompletionTokens
    ),
    idempotencyKey:
      options.idempotencyKey ??
      ptrBatchIdempotencyKey(
        options.model,
        options.contract,
        options.documents,
        options.form,
        options.maxCompletionTokens
      ),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxCompletionTokens !== undefined
      ? { maxCompletionTokens: options.maxCompletionTokens }
      : {}),
  });
  const parsed = parsePtrExtractionResponse(
    payload,
    sourceIds,
    ptrSourceExpectations(options.documents)
  );
  return {
    ...parsed,
    contractVersion: ptrContractVersion(options.contract, options.form),
    requestedModel: String(options.model),
    servedModel:
      typeof payload.model === "string" ? payload.model : null,
    usage,
    latencyMs: Date.now() - started,
    rawResponse: payload,
  };
}
