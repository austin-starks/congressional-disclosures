/**
 * Dates a read gave a row that cannot all be true of one filing: a transaction after the report was filed, a
 * notification or transaction a month out of order, or a transaction more than a year before its notification.
 * Each is usually a misread digit, and every read of a scan can share it: OCR read a handwritten 6/1/23 as 6/1/13
 * at both render scales, and the page read agreed, so nothing disputed it (Kelly 8219843, published as 2013).
 *
 * A finding only sends a page to its reconciling read with the finding stated. It never changes a date,
 * because filers misdate forms too: 3/3/04 on a 2014 report, typed on every row (Black 8214362). The
 * reconciling read keeps a date the page prints.
 */
import { isIsoCalendarDate } from "./ptrExtraction";

/** A transaction this long before its notification is a finding: a report is due within 45 days of a transaction. */
export const LONG_BEFORE_NOTIFICATION_DAYS = 365;

/**
 * How far a notification may follow the filing, or a transaction its notification, before it is a finding. Filers
 * print both a few days out of order: across the electronic House filings, whose text cannot be misread, 100 rows in
 * 72 filings date the transaction 1 to 30 days after its notification, and notifications fall up to 26 days after the
 * filing date. A misread digit moves a date by a month or a year (Harshbarger 177 days, McCaul 60, Rogers 2,178).
 */
export const DATE_ORDER_TOLERANCE_DAYS = 30;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function isoField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return isIsoCalendarDate(value) ? value : null;
}

/** Plain-English date findings for one read row; `filedOn` is the day the report was filed, YYYY-MM-DD. */
export function ptrRowDateFindings(row: Record<string, unknown>, filedOn: string | null): string[] {
  const transaction = isoField(row, "transaction_date_iso");
  const notification = isoField(row, "notification_date_iso");
  const filed = isIsoCalendarDate(filedOn) ? filedOn : null;
  const findings: string[] = [];
  if (filed && transaction && transaction > filed) {
    findings.push(`transaction date ${transaction} is after the report was filed on ${filed}`);
  }
  if (filed && notification && daysBetween(filed, notification) > DATE_ORDER_TOLERANCE_DAYS) {
    findings.push(`notification date ${notification} is more than a month after the report was filed on ${filed}`);
  }
  if (transaction && notification && daysBetween(notification, transaction) > DATE_ORDER_TOLERANCE_DAYS) {
    findings.push(`transaction date ${transaction} is more than a month after its notification date ${notification}`);
  }
  if (transaction && notification && daysBetween(transaction, notification) > LONG_BEFORE_NOTIFICATION_DAYS) {
    findings.push(
      `transaction date ${transaction} is more than a year before its notification date ${notification}`
    );
  }
  return findings;
}

/** The row's own words for a finding: its OCR row labels, else its page and asset. */
export function describePtrRow(row: Record<string, unknown>): string {
  const labels = Array.isArray(row.ocr_rows)
    ? row.ocr_rows.filter((value): value is number => Number.isInteger(value))
    : [];
  if (labels.length > 0) return `the row labeled ${labels.join(", ")}`;
  const asset =
    typeof row.asset_description === "string" && row.asset_description.trim()
      ? ` (${row.asset_description.trim()})`
      : "";
  return typeof row.page === "number" ? `a row on page ${row.page}${asset}` : `a row${asset}`;
}
