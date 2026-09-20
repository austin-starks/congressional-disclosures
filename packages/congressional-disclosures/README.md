# congressional-disclosures

U.S. congressional trading disclosures, end to end: a resumable sharded
backfill runtime, schema-bound PTR extraction, and integrity checks over the
published filing, trade, and event tables.

```bash
npm install congressional-disclosures
```

Until version 0.2.0 is published to npm, the GitHub repository exposes the same
compiled package entrypoint:

```bash
npm install github:austin-starks/congressional-disclosures
```

## Three modules, one package

```ts
import {
  auditPoliticalIntegrity,
  createEngineTranscriber,
  planOcrTextRequests,
  runMapReduceReads,
  runRound,
} from "congressional-disclosures";
```

- **Backfill runtime** (`src/backfill`): stable-hash sharding, content-addressed
  receipts, repair rounds, and reclaimable single-flight leases. Nothing here
  names Congress.
- **PTR extraction** (`src/extraction`): PDF and OCR request planning, OCR row
  coverage proofs, independent reads, filed-page reconciliation, consensus,
  orientation, rescale fallback, and range merging.
- **Integrity audit** (`src/integrity.ts`): pure checks over published filing,
  trade, and event rows — completeness, parity, orphan pointers, impossible
  values, extraction health, freshness, and manifest health.

## Extract a scanned filing

Model calls enter through `CompletionClient`; encrypted-PDF rewriting enters
through `PdfDecrypt`. OCR and page rendering remain injected by the application.
No provider SDK appears in the public types.

```ts
import {
  auditPoliticalIntegrity,
  createEngineTranscriber,
  ocrReadsDisagreement,
  planOcrTextRequests,
  runMapReduceReads,
  type CompletionClient,
} from "congressional-disclosures";

const completion: CompletionClient = {
  complete: (request) => gateway.complete(request),
};
const transcribe = createEngineTranscriber(completion);

const pages = await Promise.all(
  uprightPagePngs.map(async (png) => {
    const [first, second] = await Promise.all([
      transcribe(png, 1),
      transcribe(png, 2),
    ]);
    const disagreement = ocrReadsDisagreement(first, second);
    if (disagreement) throw new Error(disagreement);
    return first;
  })
);

const budget = {
  maxTableRowsPerWindow: 40,
  maxRowsPerWindow: 80,
  maxTableRowsPerRequest: 80,
  maxAttachmentsPerRequest: 4,
};
const requests = await planOcrTextRequests(
  [{ filingId: "house:20025000", pages }],
  budget
);

const extraction = await runMapReduceReads(requests, runReadRequests, budget);
if (extraction.consensus.failed !== 0) throw new Error("filing did not reach consensus");

const integrity = auditPoliticalIntegrity({
  now: new Date(),
  filings: publishedFilings,
  trades: publishedTrades,
  events: publishedEvents,
  indexed: chamberIndex,
  receipts: roundReceipts,
  shardKeys: resolvedManifestKeys,
});
if (!integrity.passed) throw new Error(JSON.stringify(integrity.findings));
```

Pass those requests to `runMapReduceReads` with the runner that calls your model
gateway. The package reads OCR text and filed pages independently, reconciles
disagreements, and refuses results that cannot account for every numbered row.

The two engine calls above do not share an idempotency identity: read 1 and read
2 are separate physical requests, while a retry of either read remains stable.

See `examples/real-filing-smoke.cjs` in the repository for an executable check
against a real House filing using only the compiled public package entrypoint.

## Ports, not vendors

A backfill uses `DataStore`, `LanguageModel`, `OcrEngine`, `TableWriter`, and
`Clock`. Extraction adds the one-method `CompletionClient` and one-function
`PdfDecrypt`. `S3DataStore` covers AWS, Tigris, Cloudflare R2, Backblaze B2, and
MinIO; they differ by configuration, not type. Credentials come from the AWS
SDK's standard chain, so this package never reads `process.env` or holds a
secret.

## Version history

- **0.2.0** — production PTR extraction: encrypted-PDF-safe planning, OCR row
  windows and proofs, independent engine reads, source reconciliation, bounded
  consensus, page orientation, and rescale fallback.
- **0.1.0** — resumable backfill runtime and published-table integrity audit.
