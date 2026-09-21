# Changelog

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
