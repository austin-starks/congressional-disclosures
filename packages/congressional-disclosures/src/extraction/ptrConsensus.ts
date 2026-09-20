import {
  isIsoCalendarDate,
  isValidPtrRow,
  ptrRowNeedsReview,
  type PtrDocumentResult,
  type PtrRowWindow,
} from "./ptrExtraction";
import { ocrCoverageError } from "./ptrRowCoverage";

/**
 * Consensus over independent extraction reads. Misreads on scanned forms are random, so a
 * second independent read removes them where prompt tuning cannot: two reads that agree
 * on every row-defining field are accepted, further reads run while a document stays
 * undecided, and a document no two reads agree on fails for a later retry.
 *
 * Fields are compared by exact equality on constrained values the model stated; asset
 * names are excluded because OCR spells them differently. A row window may be decided
 * transaction by transaction, but agreement is always whole-row: voting field by field
 * accepted wrong rows (designs/2026-09-14-political-disclosure-lake.md).
 */
export type PtrReadMap = ReadonlyMap<string, PtrDocumentResult>;

export interface PtrConsensusDecision {
  id: string;
  /** "agreed" on the first two reads, "arbitrated" by a third (as a whole read or row by row), or "failed". */
  outcome: "agreed" | "arbitrated" | "failed";
  result: PtrDocumentResult;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The row fields two reads must agree on, in the order `ptrRowSignatureFields` returns them. */
export const PTR_ROW_SIGNATURE_FIELDS = [
  "transaction_type_code",
  "transaction_date_iso",
  "amount_low",
  "amount_high",
  "ticker",
  "asset_type_code",
  "owner",
  "partial_sale",
  "source_transaction_id",
  "ocr_rows",
] as const;

export function ptrRowSignatureFields(row: Record<string, unknown>): unknown[] {
  const cited = Array.isArray(row.ocr_rows)
    ? row.ocr_rows.filter((value): value is number => Number.isInteger(value)).sort((a, b) => a - b)
    : [];
  return [
    text(row.transaction_type_code),
    isIsoCalendarDate(row.transaction_date_iso) ? row.transaction_date_iso : null,
    typeof row.amount_low === "number" ? row.amount_low : null,
    typeof row.amount_high === "number" ? row.amount_high : null,
    text(row.ticker),
    text(row.asset_type_code),
    typeof row.owner === "string" ? row.owner : null,
    typeof row.partial_sale === "boolean" ? row.partial_sale : null,
    text(row.source_transaction_id),
    cited,
  ];
}

function rowSignature(row: Record<string, unknown>): string {
  return JSON.stringify(ptrRowSignatureFields(row));
}

/** Order-sensitive signature of a read; a failed read has none. */
export function ptrDocumentSignature(result: PtrDocumentResult): string | null {
  if (result.error) return null;
  return JSON.stringify({
    empty: result.rows.length === 0 && Boolean(result.noTransactionsStatement),
    rows: result.rows.map(rowSignature),
    nonTransactionRows: [...result.nonTransactionRows].sort((a, b) => a - b),
    continuationRows: [...result.continuationRows].sort((a, b) => a - b),
  });
}

export function readsAgree(left: PtrDocumentResult | undefined, right: PtrDocumentResult | undefined): boolean {
  if (!left || !right) return false;
  const signature = ptrDocumentSignature(left);
  return signature !== null && signature === ptrDocumentSignature(right);
}

/** Ids whose first two reads disagree or are missing, and so need a third read. */
export function idsNeedingThirdRead(ids: readonly string[], first: PtrReadMap, second: PtrReadMap): string[] {
  return ids.filter((id) => !readsAgree(first.get(id), second.get(id)));
}

export function failedPtrResult(id: string, reason: string): PtrDocumentResult {
  return {
    sourceId: id,
    rows: [],
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows: [],
    continuationRows: [],
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error: reason,
  };
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** The first OCR row label a transaction cites; past every label when it cites none. */
export function firstCitedRow(row: Record<string, unknown>): number {
  const cited = ptrRowSignatureFields(row)[PTR_ROW_SIGNATURE_FIELDS.length - 1];
  return Array.isArray(cited) && cited.length > 0 ? Number(cited[0]) : Number.MAX_SAFE_INTEGER;
}

/** Row labels that at least two reads put in the same list. */
function sharedRows(reads: readonly PtrDocumentResult[], pick: (read: PtrDocumentResult) => readonly number[]): number[] {
  const lists = reads.map((read) => new Set(pick(read)));
  return [...new Set(lists.flatMap((list) => [...list]))]
    .filter((row) => lists.filter((list) => list.has(row)).length >= 2)
    .sort((a, b) => a - b);
}

function voteWindow(
  id: string,
  window: PtrRowWindow,
  reads: readonly PtrDocumentResult[]
): { result: PtrDocumentResult } | { error: string } {
  const usable = reads.filter((read) => !read.error);
  if (usable.length < 2) return { error: "fewer than two reads passed their own checks" };
  const signatures = usable.map((read) => read.rows.map(rowSignature));
  const counts = signatures.map(countValues);
  const kept = new Map<string, number>();
  const rows: Array<Record<string, unknown>> = [];
  usable.forEach((read, readIndex) => {
    read.rows.forEach((row, rowIndex) => {
      const signature = signatures[readIndex]![rowIndex]!;
      // Copies of a transaction that at least two reads share: the second-highest count.
      const shared = counts.map((count) => count.get(signature) ?? 0).sort((a, b) => b - a)[1] ?? 0;
      const copies = kept.get(signature) ?? 0;
      if (copies < shared) {
        rows.push(row);
        kept.set(signature, copies + 1);
      }
    });
  });
  rows.sort((left, right) => firstCitedRow(left) - firstCitedRow(right));
  const nonTransactionRows = sharedRows(usable, (read) => read.nonTransactionRows);
  const continuationRows = sharedRows(usable, (read) => read.continuationRows);
  const coverage = ocrCoverageError({ sourceId: id, window, rows, nonTransactionRows, continuationRows });
  if (coverage) return { error: coverage };
  return {
    result: {
      sourceId: id,
      rows,
      noTransactionsStatement:
        rows.length === 0 ? usable.find((read) => read.rows.length === 0)?.noTransactionsStatement ?? null : null,
      amendedReportDate: usable[0]!.amendedReportDate,
      amendedReportDateIso: usable[0]!.amendedReportDateIso,
      nonTransactionRows,
      continuationRows,
      invalidRowIndexes: rows.flatMap((row, index) => (isValidPtrRow(row) ? [] : [index])),
      reviewRowIndexes: rows.flatMap((row, index) => (ptrRowNeedsReview(row) ? [index] : [])),
      error: null,
    },
  };
}

/** Most reads an attachment gets: two, a third when they disagree, more while undecided. */
export const MAX_EXTRACTION_READS = 5;

/**
 * Decide every id from its reads in order (`reads[0]` is the first read). A later read
 * that agrees with any earlier read decides the id. `windows` holds the row window of
 * every id read from numbered OCR text; those ids may also be decided row by row.
 */
export function decidePtrConsensus(
  ids: readonly string[],
  reads: readonly PtrReadMap[],
  windows: ReadonlyMap<string, PtrRowWindow> = new Map()
): PtrConsensusDecision[] {
  const failed = (id: string, reason: string): PtrConsensusDecision => ({
    id,
    outcome: "failed",
    result: failedPtrResult(id, reason),
  });
  return ids.map((id): PtrConsensusDecision => {
    const all = reads.map((read) => read.get(id));
    const [a, b] = all;
    if (a && readsAgree(a, b)) return { id, outcome: "agreed", result: a };
    const later = all.slice(2);
    if (!later.some(Boolean)) return failed(id, "first two extraction reads disagreed and no later read ran");
    for (const [offset, read] of later.entries()) {
      if (read && all.slice(0, offset + 2).some((earlier) => readsAgree(read, earlier))) {
        return { id, outcome: "arbitrated", result: read };
      }
    }
    const present = all.filter((read): read is PtrDocumentResult => Boolean(read));
    const window = windows.get(id);
    if (!window) return failed(id, `no two of ${present.length} extraction reads agreed`);
    const vote = voteWindow(id, window, present);
    if ("result" in vote) return { id, outcome: "arbitrated", result: vote.result };
    return failed(id, `no two of ${present.length} extraction reads agreed row by row: ${vote.error}`);
  });
}

/** A transaction's signature without the OCR row labels it cites. */
function pageRowSignature(row: Record<string, unknown>): string {
  return JSON.stringify(ptrRowSignatureFields(row).slice(0, PTR_ROW_SIGNATURE_FIELDS.length - 1));
}

/**
 * True when a read of numbered OCR text and a read of the filed page list the same transactions for one page
 * (`runMapReduceReads` in `ptrReadPasses.ts`): the same signatures on every field but the row labels, which a read of
 * the filed page does not have, each as many times. Order is left out, since one read orders a page's transactions by
 * row label and the other by where they are printed.
 */
export function pageReadsAgree(
  textRows: ReadonlyArray<Record<string, unknown>>,
  sourceRows: ReadonlyArray<Record<string, unknown>>
): boolean {
  const text = textRows.map(pageRowSignature).sort();
  const source = sourceRows.map(pageRowSignature).sort();
  return text.length === source.length && text.every((signature, index) => signature === source[index]);
}
