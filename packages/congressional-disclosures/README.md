# congressional-disclosures

Build a queryable database of U.S. congressional stock-trading disclosures —
House Clerk periodic transaction reports and Senate eFD filings — from the
official sources, with your own model credentials.

```bash
export OPENROUTER_API_KEY=...    # any OpenAI-compatible endpoint works
export MISTRAL_API_KEY=...       # required only for scanned/image filings

npx congressional-disclosures doctor
npx congressional-disclosures sync --db ./congress.db --since 2024 --accept-senate-terms
npx congressional-disclosures audit --db ./congress.db

sqlite3 ./congress.db "SELECT filer_last, transaction_date, printed_ticker, action, amount_bracket
                       FROM political_trades ORDER BY available_at DESC LIMIT 10;"
```

`sync` discovers official House and Senate filings, downloads the source
documents, decrypts and renders PDFs, OCRs scanned pages, extracts transaction
rows with consensus model reads, normalizes them into filings, trades, and
trade events, and commits each filing atomically to SQLite. Runs are resumable:
re-run the same command and it skips completed filings, retries failed ones, and
reuses every cached paid response without re-billing.

If you want the current audited lake without running extraction yourself, use the
[Congressional Stock Trades dataset](https://huggingface.co/datasets/austin-starks/congressional-stock-trades).
It publishes Parquet files for filings, reported transaction rows, and reconciled
event versions. Read the dataset's statutory-use notice before using the records.

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).
- **Poppler** (`pdftotext`, `pdftocairo`, `pdftoppm`) for PDF text extraction and
  decryption of encrypted House filings: `brew install poppler` on macOS,
  `apt-get install poppler-utils` on Debian/Ubuntu. `doctor` checks for it and
  names exactly what is missing.
- **Tesseract** for word-level orientation checks on scanned pages:
  `brew install tesseract` on macOS, `apt-get install tesseract-ocr` on
  Debian/Ubuntu.
- API keys above. House PDF extraction needs the completion key; scanned
  filings and Senate paper filings also need the OCR key.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Verify Node, Poppler, credentials, and storage before a paid run. |
| `sync` | Discover, download, extract, and commit filings. |
| `status --db FILE` | Lake counts: filings, trades, events, failures. |
| `audit --db FILE` | Integrity checks; non-zero exit on failure. |

`sync` options: `--db`, `--cache-dir`, `--since YEAR`, `--year YEAR`,
`--chamber house\|senate\|both`, `--max-filings N`, `--model MODEL`,
`--ocr-model MODEL`, `--dry-run`, `--accept-senate-terms`.

- **`--dry-run`** discovers and plans but performs no downloads past the
  indexes, no provider calls, and no writes.
- Senate access requires `--accept-senate-terms`, acknowledging the eFD
  site's usage agreement.
- Sync always resumes: completed filings are skipped, failed ones retried.
  Delete the DB (and cache) to start over.

## What lands in SQLite

Public tables:

- **`political_filings`** — one row per official document, with source URL,
  content hash, parse method, extraction status, and provenance.
- **`political_trades`** — normalized transaction rows (owner, action, dates,
  printed ticker, statutory amount bracket and bounds, comments).
- **`political_trade_events`** — economic events consolidating repeated and
  amended observations of the same underlying transaction, with version
  history and supersession timestamps.

Private tables (`sync_runs`, `sync_receipts`, `schema_migrations`) track run
history and per-filing commit receipts. Raw documents and paid responses live
in a content-addressed filesystem cache (`--cache-dir`), never in the DB.

## Library API

The CLI is a thin layer over a programmatic core; every official-source
client, provider, and storage backend is injectable:

```ts
import {
  syncPoliticalDisclosures,
  SQLitePoliticalRepository,
  OpenAiCompatibleCompletionClient,
  MistralOcrClient,
  LocalCache,
} from "congressional-disclosures";

const cache = new LocalCache("./.congressional-disclosures");
const summary = await syncPoliticalDisclosures({
  repository: new SQLitePoliticalRepository("./congress.db"),
  cache,
  completion: new OpenAiCompatibleCompletionClient({ apiKey: process.env.OPENROUTER_API_KEY!, cache }),
  ocr: new MistralOcrClient({ apiKey: process.env.MISTRAL_API_KEY!, cache }),
  sinceYear: 2024,
  acceptSenateTerms: true,
});
```

### S3-compatible Parquet lake (production path)

For production lake consumers (e.g. NexusTrade's Tigris-backed lake),
`ManifestParquetPoliticalRepository` preserves the year-sharded,
manifest-published Parquet protocol and delegates physical Parquet encoding to
a narrow `ParquetLakePort` you implement against your own writer:

```ts
import { ManifestParquetPoliticalRepository } from "congressional-disclosures";

const repository = new ManifestParquetPoliticalRepository(myParquetLakePort);
await syncPoliticalDisclosures({ repository, cache, /* ... */ });
```

## Extraction pipeline

For each filing: download → decrypt (Poppler) → classify text layer vs scan →
(for scans) OCR each page → schema-bound model extraction with **independent
read passes and consensus** (disagreeing reads trigger a third and a majority
vote) → row sanitization (statutory amount bounds, date windows) → atomic
commit with receipts. Every model and OCR response is cached by a stable
request hash, so a re-run never pays for the same read twice.

## Development

```bash
npm install
npm run build && npm test        # from the repo root (workspaces)
npm run smoke:fixture            # compiled-package smoke test against a checked-in encrypted filing
```

The fixture smoke test uses scripted model reads — it proves packaging and the
deterministic pipeline, not live extraction. Live source canaries are run
separately before each release.

## License

MIT
