import type { PtrRowWindow } from "./ptrExtraction";

/**
 * Proof that an extraction accounted for every labeled OCR row, by arithmetic on the row
 * labels the model stated as transaction, non-transaction or continuation. A window read
 * must dispose of every row inside it; across a filing every row falls in some window and
 * every continuation is backed by an earlier window. A row may belong to two transactions
 * because OCR joins lines. Any failure sends the filing to another read.
 */
export interface OcrWindowRead {
  sourceId: string;
  window: PtrRowWindow;
  rows: ReadonlyArray<Record<string, unknown>>;
  nonTransactionRows: readonly number[];
  continuationRows: readonly number[];
}

function formatRows(rows: Iterable<number>): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!;
  let previous = sorted[0]!;
  for (const row of [...sorted.slice(1), Number.NaN]) {
    if (row === previous + 1) {
      previous = row;
      continue;
    }
    ranges.push(start === previous ? `R${start}` : `R${start}-R${previous}`);
    start = row;
    previous = row;
  }
  return ranges.join(", ");
}

function citedRows(row: Record<string, unknown>): number[] {
  return Array.isArray(row.ocr_rows)
    ? [...new Set(row.ocr_rows.filter((value): value is number => Number.isInteger(value)))]
    : [];
}

function inside(row: number, window: PtrRowWindow): boolean {
  return row >= window.first && row <= window.last;
}

/**
 * A window read reduced to what its window owns. A transaction that starts before
 * the window belongs to an earlier window, so its rows inside this window become
 * continuations, which the filing-level check must still back. A transaction that
 * starts after the window belongs to a later window, and a disposition listed for a
 * row outside the window is that window's to give. Nothing inside the window is
 * dropped, so the proof over the window's own rows is unchanged.
 */
export function normalizeOcrWindowRead(read: OcrWindowRead): OcrWindowRead {
  const { window } = read;
  const continuation = new Set(read.continuationRows.filter((value) => inside(value, window)));
  const rows = read.rows.filter((row) => {
    const cited = citedRows(row);
    if (cited.length === 0) return true;
    const start = Math.min(...cited);
    if (start < window.first) {
      cited.filter((value) => inside(value, window)).forEach((value) => continuation.add(value));
      return false;
    }
    return start <= window.last;
  });
  return {
    ...read,
    rows,
    nonTransactionRows: read.nonTransactionRows.filter((value) => inside(value, window)),
    continuationRows: [...continuation].sort((a, b) => a - b),
  };
}

export interface OcrWindowInspection {
  /** Rows inside the window with no disposition. */
  unaccounted: number[];
  /** Every other inconsistency, as messages. */
  problems: string[];
}

/** Sorted rows as inclusive `[first, last]` ranges of consecutive labels. */
export function rowRanges(rows: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const row of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && row === last[1] + 1) last[1] = row;
    else ranges.push([row, row]);
  }
  return ranges;
}

/** One window's read taken alone: rows it left without a disposition, and any other inconsistency. */
export function inspectOcrWindowRead(read: OcrWindowRead): OcrWindowInspection {
  const { sourceId, window } = read;
  const errors: string[] = [];
  const cited = new Set<number>();
  read.rows.forEach((row, index) => {
    const claimant = `${sourceId} transaction ${index + 1}`;
    const rows = citedRows(row);
    if (rows.length === 0) {
      errors.push(`${claimant} cites no OCR rows`);
      return;
    }
    const outsideFiling = rows.filter((value) => value < 1 || value > window.rowCount);
    if (outsideFiling.length > 0) {
      errors.push(`${claimant} cites ${formatRows(outsideFiling)}, outside the filing's R1-R${window.rowCount}`);
    }
    const start = Math.min(...rows);
    if (!inside(start, window)) {
      errors.push(`${claimant} starts at R${start}, outside its window R${window.first}-R${window.last}`);
    }
    rows.forEach((value) => cited.add(value));
  });
  const outsideWindow = (rows: readonly number[], role: string): void => {
    const outside = rows.filter((value) => !inside(value, window));
    if (outside.length > 0) errors.push(`${sourceId} lists ${formatRows(outside)} as ${role}, outside its window`);
  };
  outsideWindow(read.nonTransactionRows, "not a transaction");
  outsideWindow(read.continuationRows, "a continuation");
  const nonTransaction = new Set(read.nonTransactionRows);
  const contradicted = [...nonTransaction].filter((value) => cited.has(value));
  if (contradicted.length > 0) {
    errors.push(`${sourceId} reads ${formatRows(contradicted)} into a transaction and also lists it as not a transaction`);
  }
  const both = read.continuationRows.filter((value) => nonTransaction.has(value));
  if (both.length > 0) {
    errors.push(`${sourceId} lists ${formatRows(both)} as both a continuation and not a transaction`);
  }
  const continuation = new Set(read.continuationRows);
  const missing: number[] = [];
  for (let value = window.first; value <= window.last; value += 1) {
    if (!cited.has(value) && !nonTransaction.has(value) && !continuation.has(value)) missing.push(value);
  }
  return { unaccounted: missing, problems: errors };
}

/** Errors in one window's read taken alone; empty when its account is complete. */
export function verifyOcrWindowRead(read: OcrWindowRead): string[] {
  const { unaccounted, problems } = inspectOcrWindowRead(read);
  return unaccounted.length > 0
    ? [...problems, `${read.sourceId} gives no disposition for ${formatRows(unaccounted)}`]
    : problems;
}

/** The document error a window read carries, or null when its account is complete. */
export function ocrCoverageError(read: OcrWindowRead): string | null {
  const errors = verifyOcrWindowRead(read);
  return errors.length > 0 ? `OCR row coverage: ${errors.join("; ")}` : null;
}

/** Errors across all windows of one filing; empty when every row is accounted for. */
export function verifyOcrRowCoverage(rowCount: number, reads: readonly OcrWindowRead[]): string[] {
  const errors = reads.flatMap(verifyOcrWindowRead);
  const transactionStarts = new Map<number, number[]>();
  for (const read of reads) {
    for (const row of read.rows) {
      const rows = citedRows(row);
      if (rows.length === 0) continue;
      const start = Math.min(...rows);
      for (const value of rows) transactionStarts.set(value, [...(transactionStarts.get(value) ?? []), start]);
    }
  }
  for (const read of reads) {
    const unbacked = read.continuationRows.filter(
      (value) => !(transactionStarts.get(value) ?? []).some((start) => start < read.window.first)
    );
    if (unbacked.length > 0) {
      errors.push(
        `${read.sourceId} lists ${formatRows(unbacked)} as a continuation, but no transaction that started before its window includes it`
      );
    }
    const readElsewhere = read.nonTransactionRows.filter((value) =>
      (transactionStarts.get(value) ?? []).some((start) => !inside(start, read.window))
    );
    if (readElsewhere.length > 0) {
      errors.push(
        `${read.sourceId} lists ${formatRows(readElsewhere)} as not a transaction, but a transaction from another window includes it`
      );
    }
  }
  const uncovered: number[] = [];
  for (let value = 1; value <= rowCount; value += 1) {
    if (!reads.some((read) => inside(value, read.window))) uncovered.push(value);
  }
  if (uncovered.length > 0) errors.push(`rows in no window: ${formatRows(uncovered)}`);
  return errors;
}
