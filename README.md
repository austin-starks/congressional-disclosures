# congressional-disclosures

Turn official U.S. House and Senate financial disclosures into a local,
queryable SQLite data lake.

```bash
export OPENROUTER_API_KEY=...  # model extraction
export MISTRAL_API_KEY=...     # OCR for scanned filings

npx congressional-disclosures doctor
npx congressional-disclosures sync \
  --db ./congress.db \
  --since 2024 \
  --accept-senate-terms
npx congressional-disclosures audit --db ./congress.db

sqlite3 ./congress.db \
  "SELECT filer_last, transaction_date, printed_ticker, action, amount_bracket
   FROM political_trades
   ORDER BY available_at DESC
   LIMIT 10;"
```

That is the product. The package discovers filings from the official House
Clerk and Senate eFD sites, downloads them, handles encrypted and scanned PDFs,
runs OCR and independent model reads, reconciles disagreements, normalizes the
rows, and writes the lake. A rerun resumes from completed filings and reuses
content-addressed provider responses.

[![npm](https://img.shields.io/npm/v/congressional-disclosures)](https://www.npmjs.com/package/congressional-disclosures)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](./package.json)

## Install

You can run it without installing:

```bash
npx congressional-disclosures --help
```

Or add the library to an application:

```bash
npm install congressional-disclosures
```

The published package is the supported installation path. The GitHub repository
contains the same TypeScript source, release tests, and live-source canaries.

If you want the current audited lake without running extraction yourself, use the
[Congressional Stock Trades dataset](https://huggingface.co/datasets/austin-starks/congressional-stock-trades).
Its Parquet snapshot mirrors the same filings, trades, and reconciled event model;
read the dataset's statutory-use notice before using the records.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is built in).
- Poppler: `brew install poppler` on macOS or
  `apt-get install poppler-utils` on Debian/Ubuntu.
- Tesseract: `brew install tesseract` on macOS or
  `apt-get install tesseract-ocr` on Debian/Ubuntu.
- An OpenAI-compatible completion API key. OpenRouter is the default endpoint.
- A Mistral API key when a filing contains scanned pages.

`doctor` checks the local executables and reports whether each credential is
present without printing its value.

## Commands

| Command | What it does |
|---|---|
| `doctor` | Checks Node, PDF/OCR tools, and provider configuration. |
| `sync --db FILE --since YEAR` | Discovers, extracts, and stores filings. |
| `status --db FILE` | Prints filing, trade, event, and failure counts. |
| `audit --db FILE` | Runs completeness, parity, orphan, and sanity checks. |

Useful sync options:

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

Senate access requires `--accept-senate-terms`, acknowledging the eFD site’s
usage agreement. `--dry-run` discovers and plans without downloading filing
documents, calling providers, or writing lake rows.

## The SQLite lake

The CLI creates three public tables:

- `political_filings`: every official document, provenance, parse method,
  content hash, extraction status, and named failure reason.
- `political_trades`: normalized transaction rows with dates, owner, action,
  filed ticker, amount bracket, and source provenance.
- `political_trade_events`: versioned economic events that consolidate repeated
  and amended observations of the same trade.

Private tables hold run history, schema migrations, and per-filing receipts.
Raw documents and paid responses live in the content-addressed cache selected
by `--cache-dir`.

## Use it as a library

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

Official-source clients, provider clients, the repository, and progress
reporting are injectable. The default CLI supplies concrete implementations;
applications only replace a component when they actually need to.

Large applications can import focused entry points such as
`congressional-disclosures/extraction`, `/lake`, `/sources`, `/backfill`,
`/integrity`, and `/storage` so a server that does not use SQLite never loads it.

## NexusTrade and other production lakes

SQLite is the turnkey public path. NexusTrade keeps its existing native
Tigris/Parquet lake by supplying its concrete `ParquetLakePort` to
`ManifestParquetPoliticalRepository`:

```ts
import {
  ManifestParquetPoliticalRepository,
  syncPoliticalDisclosures,
} from "congressional-disclosures";

const repository = new ManifestParquetPoliticalRepository(tigrisParquetPort);
await syncPoliticalDisclosures({ repository, cache, completion, ocr, sinceYear: 2012 });
```

The package owns the congressional domain: discovery, downloads, PDF handling,
OCR validation, extraction, normalization, event construction, and integrity
rules. NexusTrade owns its credentials, NexusGenAI transport and billing,
Tigris/DuckDB implementation, scheduling, alerts, and application-specific
enrichment.

## Reliability boundaries

- House PDFs are classified by actual Poppler-extracted text. Scans are
  rendered page by page and checked at two resolutions.
- Page orientation combines Tesseract word evidence with independent visual
  reads when the evidence is ambiguous.
- Model extraction uses independent, retry-stable reads. Disagreements trigger
  reconciliation against the filed pages.
- Commits replace one complete filing atomically. Failed filings remain named
  and retryable instead of silently disappearing.
- `audit` checks indexed-filing coverage, filing/trade parity, orphan rows,
  event consistency, and field sanity.

## Development and release evidence

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:fixture
npm run smoke:live-senate -- 2024 /tmp/congressional-senate-canary
```

The fixture smoke test runs the compiled package against a checked-in,
encrypted real filing and scripted provider responses. Live official-source
canaries are separate release gates; the Senate canary accepts the eFD terms,
downloads one real electronic filing, and proves it reaches SQLite without a
model or OCR stub.

## License

MIT
