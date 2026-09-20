# congressional-disclosures

Build a local, queryable database of U.S. congressional financial disclosures
from the official House Clerk and Senate eFD sources.

[![npm](https://img.shields.io/npm/v/congressional-disclosures)](https://www.npmjs.com/package/congressional-disclosures)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/austin-starks/congressional-disclosures/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org/)

The package discovers filings, downloads their original documents, decrypts
House PDFs, OCRs scans, extracts transactions with independent model reads,
reconciles disagreements, and writes a resumable SQLite data lake. It covers
both the House and Senate and retains source URLs, document hashes, extraction
status, repeated reports, and amendment history.

- **Want the data immediately?** Download the current audited
  [Congressional Stock Trades dataset](https://huggingface.co/datasets/austin-starks/congressional-stock-trades).
- **Want your own local lake?** Run the CLI against the official sources.
- **Building another product?** Install the library and replace only the model,
  OCR, cache, or storage adapters you need to own.

## What can you investigate?

Once the lake exists, ordinary SQL can answer questions such as:

- Which members disclosed the most purchases in a given year?
- Which stocks attracted purchases from the most distinct members?
- How long did members wait between a transaction and its disclosure?
- How do House and Senate trading patterns differ?
- Which filings failed extraction, and why?
- What did the public know on a particular date, before a later amendment?

Performance questions require market prices in addition to disclosure data.
For example, “Which politician's disclosed purchases performed best?” needs an
explicit return horizon, weighting method, and decision about whether returns
begin on the transaction date or the public disclosure date. The lake preserves
both dates so that analysis can state that choice instead of hiding it.

## Build a SQLite lake

### 1. Check the machine

Node.js 22.5 or newer is required. Install Poppler and Tesseract first:

```bash
# macOS
brew install poppler tesseract

# Debian or Ubuntu
apt-get install poppler-utils tesseract-ocr
```

Then provide your extraction credentials and run the preflight check:

```bash
export OPENROUTER_API_KEY=...  # model extraction
export MISTRAL_API_KEY=...     # OCR for scanned/image filings

npx congressional-disclosures doctor
```

`doctor` reports whether each executable and credential is present without
printing credential values.

### 2. Sync official filings

```bash
npx congressional-disclosures sync \
  --db ./congress.db \
  --since 2024 \
  --accept-senate-terms

npx congressional-disclosures status --db ./congress.db
npx congressional-disclosures audit --db ./congress.db
```

Senate access requires `--accept-senate-terms`, acknowledging the eFD site's
usage agreement. Start with `--dry-run` or `--max-filings 5` when evaluating
the workflow. Model and OCR calls can cost money; raw documents and provider
responses are cached by content/request hash so reruns do not pay for the same
work again.

### 3. Query it

Recent normalized transaction rows:

```bash
sqlite3 ./congress.db \
  "SELECT filer_first || ' ' || filer_last AS member,
          transaction_date,
          COALESCE(printed_ticker, resolved_ticker) AS ticker,
          action,
          amount_bracket,
          available_at
   FROM political_trades
   ORDER BY available_at DESC
   LIMIT 10;"
```

Members with the most purchases first disclosed in 2024:

```sql
SELECT
  filer_first || ' ' || filer_last AS member,
  chamber,
  COUNT(*) AS purchases
FROM political_trade_events
WHERE action = 'purchase'
  AND first_available_at >= '2024-01-01'
  AND first_available_at < '2025-01-01'
  AND superseded_at IS NULL
GROUP BY member, chamber
ORDER BY purchases DESC
LIMIT 20;
```

Stocks purchased by the most distinct members:

```sql
SELECT
  ticker,
  COUNT(*) AS purchases,
  COUNT(DISTINCT filer_key) AS distinct_members
FROM political_trade_events
WHERE action = 'purchase'
  AND ticker IS NOT NULL
  AND superseded_at IS NULL
GROUP BY ticker
ORDER BY distinct_members DESC, purchases DESC
LIMIT 20;
```

Average disclosure lag by chamber:

```sql
SELECT
  chamber,
  ROUND(AVG(julianday(first_available_at) - julianday(transaction_date)), 1)
    AS average_days_to_disclosure
FROM political_trade_events
WHERE transaction_date IS NOT NULL
  AND superseded_at IS NULL
GROUP BY chamber;
```

Use `political_trade_events` for counts and aggregate analysis. It consolidates
the same economic trade when it is reported repeatedly and versions amendments
instead of double-counting them.

## What lands in SQLite?

| Table | Grain | Use it for |
|---|---|---|
| `political_filings` | One official document | Coverage, provenance, extraction failures, and audit trails |
| `political_trades` | One transaction row printed on a filing | Inspecting exactly what a document reported |
| `political_trade_events` | One version of a consolidated economic event | Counts, aggregates, point-in-time research, and downstream signals |

Private tables record schema migrations, sync runs, and per-filing receipts.
Original documents and paid responses live in the content-addressed cache
selected by `--cache-dir`; large blobs are not stored inside SQLite.

Two dates matter:

- `transaction_date` is when the disclosed transaction occurred.
- `available_at`/`first_available_at` is when the information became public.

For a realistic backtest or alert, never make a trade visible before its public
availability timestamp. Later corrections are visible only from their own
`available_at` timestamp until `superseded_at`.

## Commands

| Command | What it does |
|---|---|
| `doctor` | Checks Node, PDF/OCR tools, and provider configuration. |
| `sync --db FILE --since YEAR` | Discovers, extracts, and stores filings. |
| `status --db FILE` | Prints filing, trade, event, and failure counts. |
| `audit --db FILE` | Runs orphan, event, amount, date, freshness, and sanity checks. |

Useful `sync` options:

```text
--year YEAR
--chamber house|senate|both
--max-filings N
--model MODEL
--ocr-model MODEL
--cache-dir DIR
--dry-run
--accept-senate-terms
```

`--dry-run` discovers and plans without downloading filing documents, calling
providers, or writing lake rows. A normal rerun resumes from committed filings,
retries failed filings, and reuses cached provider responses.

## Use it as a library

```bash
npm install congressional-disclosures
```

```ts
import {
  LocalCache,
  MistralOcrClient,
  OpenAiCompatibleCompletionClient,
  SQLitePoliticalRepository,
  syncPoliticalDisclosures,
} from "congressional-disclosures";

const cache = new LocalCache("./.congressional-disclosures");
const repository = new SQLitePoliticalRepository("./congress.db");

try {
  const summary = await syncPoliticalDisclosures({
    repository,
    cache,
    completion: new OpenAiCompatibleCompletionClient({
      apiKey: process.env.OPENROUTER_API_KEY!,
      cache,
    }),
    ocr: new MistralOcrClient({
      apiKey: process.env.MISTRAL_API_KEY!,
      cache,
    }),
    sinceYear: 2024,
    acceptSenateTerms: true,
  });
  console.log(summary);
} finally {
  await repository.close();
}
```

Official-source clients, provider clients, storage, caching, and progress
reporting are injectable. The CLI supplies working defaults; an application
only replaces a boundary when it has a concrete reason to.

Focused entry points—`/extraction`, `/lake`, `/sources`, `/backfill`,
`/integrity`, and `/storage`—let a server import the congressional domain
without loading the SQLite runtime.

## Production Parquet lakes

SQLite is the turnkey local path. A production application can retain its own
S3-compatible object store and Parquet writer by supplying a `ParquetLakePort`
to `ManifestParquetPoliticalRepository`:

```ts
import {
  ManifestParquetPoliticalRepository,
  syncPoliticalDisclosures,
} from "congressional-disclosures";

const repository = new ManifestParquetPoliticalRepository(parquetLakePort);
await syncPoliticalDisclosures({
  repository,
  cache,
  completion,
  ocr,
  sinceYear: 2012,
  acceptSenateTerms: true,
});
```

The package owns discovery, downloads, PDF handling, OCR validation, extraction,
normalization, event construction, and integrity rules. The host application
keeps its credentials, billing, physical Parquet implementation, scheduling,
alerts, and application-specific enrichment.

## Reliability and limitations

The reliability work is part of the product:

- House PDFs are classified using text Poppler actually extracts. Encrypted
  documents are rewritten before any page is copied or split.
- Scans are rendered page by page and checked at independent resolutions.
- Independent model reads must agree; disagreements trigger reconciliation
  against the filed pages.
- One filing is replaced atomically. Failed filings remain present with a named
  reason and can be retried.
- A completed `sync` checks coverage against the official filings in that run;
  `audit` checks orphan rows, consolidated events, dates, amounts, and freshness.

The source records still impose unavoidable limits:

- Filings are self-reported and may be late, incomplete, or amended.
- Dollar values are statutory ranges, not exact position sizes or profits.
- A reported owner may be the member, spouse, joint account, or dependent child.
- Options and private assets do not behave like ordinary stock purchases.
- Extraction is probabilistic. Preserve provenance and inspect source filings
  before treating an individual row as definitive.

This software and dataset are for research and informational use, not investment
advice. Review the dataset's statutory-use notice before redistributing records.

## Development and release evidence

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:fixture
npm run smoke:live-senate -- 2024 /tmp/congressional-senate-canary
```

The fixture smoke test runs the compiled package against a checked-in encrypted
filing with scripted provider responses. It proves packaging and deterministic
pipeline behavior; live official-source canaries are separate release gates.

## License

Code is released under the [MIT License](https://github.com/austin-starks/congressional-disclosures/blob/main/LICENSE).
Government disclosure records may carry separate statutory restrictions; consult
the notice distributed with the public dataset.
