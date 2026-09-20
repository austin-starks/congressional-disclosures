# End-to-end congressional disclosure lake package

## Problem

`congressional-disclosures@0.2.0` currently exposes the extraction mechanics and a
generic backfill runtime, but it cannot discover a filing, download it, persist the
normalized rows, or run from a command line. That makes the package name promise a
product that the package does not provide.

The production implementation already exists in NexusTrade. The package should own
that congressional domain logic, while NexusTrade keeps only infrastructure adapters
for its model billing, Tigris credentials, scheduling, alerts, and downstream indexing.

## Release contract

A standalone user can build a local lake with:

```bash
OPENROUTER_API_KEY=... MISTRAL_API_KEY=... \
  npx congressional-disclosures sync --db ./congress.db --since 2024 --accept-senate-terms
npx congressional-disclosures audit --db ./congress.db
sqlite3 ./congress.db "select * from political_trades limit 10"
```

NexusTrade uses the same domain engine with an S3-compatible, manifest-published
Parquet repository. It does not use SQLite and its existing political lake paths and
schemas do not change.

## Package boundaries

The package owns:

- House Clerk and Senate eFD discovery and downloads;
- raw-document archiving and content hashes;
- PDF preparation, OCR, model reads, consensus, and reconciliation;
- filing/trade normalization and amendment event construction;
- retry planning, receipts, integrity checks, and resumability;
- the canonical filing, trade, and event row contracts;
- a SQLite repository and an S3-compatible Parquet repository contract;
- a command-line interface and a programmatic `syncPoliticalDisclosures` API.

NexusTrade owns:

- NexusGenAI billing and model transport;
- production Tigris credentials and its concrete Parquet writer;
- the price-backed ticker registry;
- worker scheduling, Mongo run records, alerts, and corpus indexing;
- screener and `run_compute` consumption of the published lake.

## Storage architecture

`PoliticalRepository` is the engine boundary. It reads all current rows and atomically
applies complete-filing replacements. The package ships `SQLitePoliticalRepository`
as the default local implementation. `S3ParquetPoliticalRepository` preserves the
year-sharded manifest protocol and delegates physical Parquet encoding to a narrow
`ParquetWriter` port, allowing NexusTrade to use its proven DuckDB/Tigris writer.

SQLite contains these public tables:

- `political_filings`
- `political_trades`
- `political_trade_events`

It also contains private run and receipt tables. A filing replacement, its trade rows,
the rebuilt event rows, and its receipt commit in one transaction. Dates are stored as
ISO strings and converted back to `Date` objects at the repository boundary.

Raw documents live in a content-addressed filesystem cache by default. SQLite records
their source URL, path, media type, and SHA-256 rather than storing multi-megabyte blobs.

## Provider architecture

The core does not read environment variables. The CLI may translate environment and
flags into explicit configuration. Library callers inject:

- a completion client;
- an OCR client;
- PDF decrypt/render operations;
- optional ticker resolution.

The CLI ships an OpenAI-compatible completion adapter and a Mistral OCR adapter. Every
paid response is cached by a stable request hash. A second run must reuse those results.

## CLI

- `doctor`: verify runtime, credentials, PDF capabilities, and writable storage.
- `sync`: discover, fetch, extract, normalize, and commit filings.
- `status`: report completed, failed, deferred, and unresolved rows.
- `audit`: run the lake integrity checks and exit non-zero on failure.

`sync` supports `--db`, `--cache-dir`, `--since`, `--year`, `--chamber`,
`--max-filings`, `--resume`, `--dry-run`, and `--accept-senate-terms`.
Senate access is refused unless the caller explicitly accepts the site terms.

## Migration and release order

1. Port and parity-test the source clients, normalization, event, and lake contracts.
2. Implement SQLite storage and the CLI.
3. Exercise a packed tarball in a clean project and a clean NexusTrade worktree.
4. Run live canaries for House text, House encrypted/scan, Senate HTML, and Senate paper.
5. Publish `0.2.0` only after those gates pass.
6. Install the exact registry version in NexusTrade and replace duplicated imports.
7. Merge to NexusTrade main, deploy from the primary checkout, and verify the live lake,
   screener, and `run_compute` path before deleting the temporary comparison path.

## Definition of done

- The README quick start creates a queryable SQLite lake from official sources.
- The packed and registry artifacts contain every runtime dependency and executable.
- A killed sync resumes without duplicating rows or repeating cached paid calls.
- Both chambers pass real-source canaries; the encrypted House fixture renders nonblank.
- NexusTrade writes the same Tigris/Parquet schema through the package contracts.
- NexusTrade has no duplicate congressional parsing, normalization, or event logic.
