# Changelog

## 1.2.0 - 2026-09-21

- Scanned filings are now checked for dates that cannot all be true. A read that dates a transaction after the report was filed, puts a transaction or notification more than a month out of order, or dates a transaction more than a year before its notification sends that page to its reconciling read, with each finding stated. Before, both reads of a scan could share one misread digit and nothing disputed it: a handwritten 6/1/23 was published as 2013-06-01.
- Two reads must now agree on the notification date as well as the transaction date. A typed 03/22/22 misread as 09/22/22 on ten rows previously passed because no check compared notification dates.
- Added `filedOn` (YYYY-MM-DD) to `HouseFilingPdf`, `SenatePaperReportPages` and `OcrTextFiling`; `sync` passes the House filing date and the Senate submission date. Without it, only a row's own dates are checked.
- A page sent to reconcile only by a date finding keeps its agreeing reads if the reconciling read fails, so the new check never fails a filing that previously extracted.
- Exported `ptrRowDateFindings`, `describePtrRow`, `LONG_BEFORE_NOTIFICATION_DAYS` and `DATE_ORDER_TOLERANCE_DAYS`.

## 1.1.1 - 2026-09-20

- Added a short hosted quick-start demo showing the one-command SQLite path.
- Explained how `npx`, the public snapshot manifest, checksum verification, and atomic SQLite materialization fit together.
- Identified NexusTrade as the production application built on this package and documented the product features it adds to the open data layer.

## 1.1.0 - 2026-09-20

- Added `download --sqlite [FILE]`, which turns the audited public Parquet snapshot into a ready-to-query SQLite database without provider credentials or external data tools.
- Added expansion-aware SQLite disk-space preflight, atomic database replacement, and row-count validation against the published snapshot.
- Replaced the ambiguous post-download README guidance with one complete command, a package-native verification command, a real Pelosi query, and a CSV export example.

## 1.0.0 - 2026-09-20

- Marked the download, sync, audit, status, SQLite table, and documented library entry-point contracts as stable under SemVer.
- Added checksum-verified public dataset downloads with disk-space preflight.
- Added CI, dependency audit, release-layout verification, and the encrypted-filing smoke test as repository gates.
- Documented ticker handling, hosted snapshot cadence, contribution rules, and private security reporting.
- Added deterministic coverage for spouse-owned option sales, amount bounds, and amendment versioning.

## 0.2.5 - 2026-09-20

- Added `npx congressional-disclosures download` for the audited Hugging Face snapshot.
