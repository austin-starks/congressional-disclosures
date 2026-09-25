# Changelog

## 2.2.2 - 2026-09-24

- Canonical political trade events now retain the extracted filing comment, which can contain option strike, expiration, and contract quantity. Existing SQLite event tables gain the column in place and backfill it from their raw trade rows; older published snapshots still read with a null comment. This preserves evidence for later contract-level modeling without changing event matching or trade execution.

## 2.2.1 - 2026-09-23

- An amendment that became public at the same instant as the version it corrects set that version's `supersededAt` to its own `availableAt`, so the two were equal. A point-in-time read wants `availableAt <= as_of AND supersededAt > as_of`, which no date satisfies when they match, so the version was unreadable at every instant. Two rows in the published lake were in that state and each was the only version of its trade, so the trade was invisible entirely: a John Hoeven WTW row from 2019-05-09 and a Tommy Tuberville OC row whose v1 is absent, leaving v2 self-superseded. Such a version was never observable, so it is now replaced in place keeping its version number; a correction that arrives strictly later still supersedes and appends.

## 2.2.0 - 2026-09-23

- A Senate row whose Ticker column reads "--" takes its ticker from the head of Asset Name when eFD printed it there, as in "SPYM - Tradr 2X Long SPY Monthly ETF" or "BRK-B - Berkshire Hathaway Inc Class B". A Senate row has no transaction id, so events consolidate on ticker and date, and a row with no ticker could never join its amendment: both versions were published as separate events. Only Stock, Other and Cryptocurrency rows are read this way. A corporate bond names its issuer's ticker ("FIS - ... Rate/Coupon: 4.700%") and an exchange names two securities, so both keep a null ticker. 31 Senate rows in the published data have this shape; `assetDescription` keeps the name as filed.
- Exported `senateTickerFromAssetName` from `congressional-disclosures/lake`.

## 2.1.0 - 2026-09-22

- A scanned page tesseract reads no letters on at any turn now goes to the model to be turned upright, and is kept as rendered only when the model cannot orient it either. Every such page used to be kept as rendered, on the reasoning that it held no text. 200-dpi fax micro-print scores 0 at every turn while full of text, and sideways pages of it sent to OCR unturned came back as hallucinated column headers, so their rows were dropped without a failure: House 8219417 lost pages 4, 6, 8, 9 and 14 (201 rows published; 293 read with this fix). Of the 161 scanned filings extracted since the shortcut shipped, it is the one that lost rows.
- A scanned filing fails when the page read (Read B, which reads every filed page) lists more transactions on a page than the OCR text holds table rows there, beyond the spread two reads of one page may show (two rows, or a tenth). Windows and every read of them are planned from the OCR text, so rows the OCR left out were never read and nothing failed: both OCR reads of House 8218338 page 21 gave only the column headers of a page Read B lists 70 transactions on, and its pages 12 and 18 lost about 20 rows each. The failure names each page with both counts. Across 228 pages of 44 scanned filings no page fell short. It adds no model call.
- A reconciled row that keeps a date with a date finding, where Read A gives the same row dates with none, gets one repair read told both dates. The reconciling read had both reads and the finding and still took the page read's misread digit: House 9110307 was published notified 2015-12-09 beside a 2016-12-09 transaction that Read A read as notified the same day, and the repair read gives 2016-12-09. When the repair read keeps the date, having been shown Read A's, the reconciled read stands, since the page may print it (a handwritten 1/17/14 that OCR read as 11/7/14, House 9108306). Across 115 reconciled windows of the 45 scanned filings with a published date finding, this fired twice.
- Added `keptDateFindings` to `PtrDocumentInput`.

## 2.0.0 - 2026-09-22

- Every filing is now matched to a member of Congress. The official indexes spell members inconsistently (the House Clerk has listed Rep. Scott Franklin as `Scott`, `C. Scott`, `Scott Scott` and `Scott Mr`), and filer identity was built from the printed name, so 41 members were split across 89 filer keys and repeats filed under a second spelling were never consolidated. Filings are matched deterministically against the public-domain congress-legislators data: everyone who had served in the filing's seat or chamber by its filing date, after accents, honorifics and credentials are removed, ties broken on given names and then on the most recent service. Against the published snapshot, 10,806 of 10,809 filings match; the rest are settled by three reviewed overrides.
- **Breaking:** every table gains `member_id` (Bioguide ID), `display_name` (the official name), and `identity_source`, and `filer_key` becomes `member:<bioguide>` for members, one key across both chambers. `filer_first` and `filer_last` still hold the name as filed.
- **Breaking:** only members of Congress have `political_trade_events`. Filings by people who never served, such as a House committee employee's report that reached the member index, stay in `political_filings` and `political_trades` with `identity_source = 'non_member'`.
- Events consolidate per member. On the published snapshot five trades had been counted twice because a repeat or a correction was filed under another spelling of the member's name: four now merge into their original, and one becomes the corrected version of its original. With four trades by a committee employee removed, 179,004 event versions become 178,996.
- **Breaking:** `SyncOptions` requires a `resolver`, and `PoliticalRepository` gains `reidentify`, which re-derives identity when the member data or the overrides change. A 1.x SQLite database gains the identity columns in place and is re-identified on its next `sync`. `download` refuses a snapshot published before 2.0.
- `sync` downloads congress-legislators once per upstream commit and caches it; `--legislators-commit` pins one. When GitHub cannot be reached, the last cached commit is used.
- The audit fails a member split across filer keys, an event from a non-member, and an override its own proving filing no longer matches, and reports unresolved filers without failing. An override whose filing is not in the lake is not judged, so a partial sync never fails on one. `status` reports members and unresolved filings.
- Event consolidation looks up each filer's open events by transaction ID, ticker and date instead of scanning all of them, which made a member with 40,782 trades quadratic: rebuilding the full lake's events went from 629 seconds to 0.4 seconds, with byte-identical output.
- Exported `MemberResolver`, `loadLegislators`, `legislatorsFromFiles`, `identifyPoliticalRows`, `identifyFilingRows`, `MEMBER_OVERRIDES` and the identity types from `congressional-disclosures/lake`. Removed `politicalFilerKey`.

## 1.3.0 - 2026-09-22

- A scanned filing about to fail for a row with no asset name gets one repair read of that window, told which rows the reads left blank. Filers often mark a repeated asset with a ditto mark, "same", or an arrow drawn down the asset column instead of writing it again; both reads left those rows blank, and the whole filing failed (House 9108075 lost a DJIA option sale under a ditto mark, 8217760 its NetApp rows under an arrow).
- A scanned filing where no read found a transaction or a statement that it has none gets one repair read, told so. An amendment or letter that corrects an earlier report without listing a transaction of its own, such as one correcting a checked box or withdrawing a reported sale, now records what it corrects in `no_transactions_statement` instead of failing (House 9107269, 8214458).
- Repair reads run only for a filing that would otherwise fail, so every read of a filing that extracts today keeps contract v11's text and its rows cannot move.
- A partial mark on a purchase is kept as filed. Some attached statements have a "Partial Transaction" column that filers mark on purchases, and the row check rejected those rows, failing all 40 pages of House 9116142.
- The second OCR engine tries a failed transcription under up to two more request keys. A gateway answers a key whose request failed, including one whose client disconnected mid-read, with that same failure on every later call, so one upstream timeout had failed a page for good (House 8216921).
- Added `assetFindings` and `emptyReadFindings` to `PtrDocumentInput`, `EMPTY_READ_FINDING`, `ENGINE_READ_GENERATIONS` (3), and a `generation` argument to `engineIdempotencyKey`; the first generation's key is unchanged.

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
