# Download-to-SQLite product path

## Problem

`congressional-disclosures download` retrieves and verifies the public Parquet
snapshot, but it does not create the SQLite database described elsewhere in the
README. A first-time user can therefore complete the download successfully and
still have no obvious command to query the data. The separate `sync` command
does create SQLite, but it rebuilds the lake from official filings and requires
PDF/OCR/model infrastructure. That is the wrong path for someone who only wants
the published dataset.

## Product contract

Add an optional SQLite materialization step to the existing download command:

```bash
npx congressional-disclosures download --sqlite
```

This command must:

1. Download or reuse the checksum-verified public Parquet snapshot.
2. Convert all three selected public tables into a queryable SQLite database.
3. Default the database path to
   `./congressional-stock-trades/congressional-disclosures.sqlite`.
4. Accept an explicit path with `--sqlite FILE`.
5. Require the complete dataset. A table/year slice cannot produce a coherent
   three-table database and must fail with an actionable message.
6. Build into a temporary database, validate row counts against `snapshot.json`,
   and only then replace the destination database.
7. Require no provider keys, OCR tools, Docker, Python, DuckDB, or global SQLite
   installation.

`download` without `--sqlite` remains the Parquet-only path. `sync` remains the
official-source rebuild path.

## Implementation

- Read each downloaded Parquet shard with the pure-JavaScript `hyparquet`
  reader and `hyparquet-compressors` for the dataset's ZSTD compression.
- Convert the published camelCase rows into the package's typed lake rows.
- Add an exact-snapshot replacement operation to the SQLite repository so the
  published event history is imported as-is rather than recomputed.
- Compare SQLite counts for filings, trades, and events to the public snapshot
  totals before publishing the database file.

## Verification

- Unit-test Parquet row coercion and atomic materialization failure behavior.
- Run the CLI against the real published snapshot in a clean temporary
  directory.
- Query the resulting database with both the package `status` command and the
  system `sqlite3` CLI.
- Run the full package test, typecheck, release-layout, and packed-install gates.
