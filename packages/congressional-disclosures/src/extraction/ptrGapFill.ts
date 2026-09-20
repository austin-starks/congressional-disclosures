import {
  isValidPtrRow,
  ptrRowNeedsReview,
  type PtrDocumentResult,
  type PtrRowWindow,
} from "./ptrExtraction";
import {
  inspectOcrWindowRead,
  ocrCoverageError,
  rowRanges,
  type OcrWindowRead,
} from "./ptrRowCoverage";

/**
 * Fallback for a row window read whose only defect is rows without a disposition,
 * usually page furniture: those rows are read again on their own with window context,
 * merged back, and the merged read must pass row coverage again. Contradictions and
 * failed requests go to another full read instead.
 */
export interface GapFillRead {
  window: PtrRowWindow;
  /** Undefined when the gap read produced no result for this range. */
  result: PtrDocumentResult | undefined;
}

type CitedRow = Record<string, unknown> & { ocr_rows: number[] };

function windowRead(window: PtrRowWindow, result: PtrDocumentResult): OcrWindowRead {
  return {
    sourceId: result.sourceId,
    window,
    rows: result.rows,
    nonTransactionRows: result.nonTransactionRows,
    continuationRows: result.continuationRows,
  };
}

function withCitations(row: Record<string, unknown>): CitedRow {
  const cited = Array.isArray(row.ocr_rows)
    ? row.ocr_rows.filter((value): value is number => Number.isInteger(value))
    : [];
  return { ...row, ocr_rows: cited };
}

/** Row ranges to read again; none when the read has any defect other than rows without a disposition. */
export function gapFillRanges(window: PtrRowWindow, result: PtrDocumentResult): PtrRowWindow[] {
  const read = windowRead(window, result);
  const { unaccounted, problems } = inspectOcrWindowRead(read);
  if (unaccounted.length === 0 || problems.length > 0 || result.error !== ocrCoverageError(read)) return [];
  return rowRanges(unaccounted).map(([first, last]) => ({ first, last, rowCount: window.rowCount }));
}

/**
 * The window read with its gap reads merged in, proved again. A gap read's
 * continuation rows extend the one transaction that includes the row directly
 * above the gap; with no such transaction, or more than one, the merge fails.
 */
export function mergeGapFills(
  window: PtrRowWindow,
  base: PtrDocumentResult,
  fills: readonly GapFillRead[]
): PtrDocumentResult {
  const label = (fill: GapFillRead): string => `gap read R${fill.window.first}-R${fill.window.last}`;
  const failures = fills.flatMap((fill) => {
    if (!fill.result) return [`${label(fill)}: no result`];
    return fill.result.error ? [`${label(fill)}: ${fill.result.error}`] : [];
  });
  if (failures.length > 0) {
    return { ...base, error: [base.error, ...failures].filter((part) => part).join("; ") };
  }

  const rows = base.rows.map(withCitations);
  const nonTransactionRows = new Set(base.nonTransactionRows);
  const continuationRows = new Set(base.continuationRows);
  const problems: string[] = [];
  for (const fill of fills) {
    const result = fill.result;
    if (!result) continue;
    result.nonTransactionRows.forEach((row) => nonTransactionRows.add(row));
    if (result.continuationRows.length > 0) {
      if (fill.window.first === window.first) {
        result.continuationRows.forEach((row) => continuationRows.add(row));
      } else {
        const above = fill.window.first - 1;
        const owners = rows.filter((row) => row.ocr_rows.includes(above));
        if (owners.length === 1) {
          owners[0]!.ocr_rows = [...owners[0]!.ocr_rows, ...result.continuationRows];
        } else {
          problems.push(
            `${label(fill)} continues R${above}, which ${
              owners.length === 0 ? "no transaction" : "more than one transaction"
            } includes`
          );
        }
      }
    }
    rows.push(...result.rows.map(withCitations));
  }
  const firstCited = (row: CitedRow): number =>
    row.ocr_rows.length > 0 ? Math.min(...row.ocr_rows) : Number.POSITIVE_INFINITY;
  rows.sort((left, right) => firstCited(left) - firstCited(right));
  if (rows.length > 0 && base.noTransactionsStatement) {
    problems.push("document returned rows and a no-transactions statement");
  }

  const merged: PtrDocumentResult = {
    ...base,
    rows,
    nonTransactionRows: [...nonTransactionRows].sort((a, b) => a - b),
    continuationRows: [...continuationRows].sort((a, b) => a - b),
    invalidRowIndexes: rows.flatMap((row, index) => (isValidPtrRow(row) ? [] : [index])),
    reviewRowIndexes: rows.flatMap((row, index) => (ptrRowNeedsReview(row) ? [index] : [])),
    error: null,
  };
  return {
    ...merged,
    error:
      problems.length > 0
        ? `OCR row coverage: ${problems.join("; ")}`
        : ocrCoverageError(windowRead(window, merged)),
  };
}
