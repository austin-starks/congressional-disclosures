# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink to this file.

## What this repository is

One public package, `packages/congressional-disclosures`, with these product layers:

- `src/backfill` — resumable sharded backfills. **Knows nothing about Congress.**
- `src/extraction` — schema-bound PTR extraction from PDFs, OCR text, and filed pages.
- `src/sources` — official House and Senate discovery and download clients.
- `src/lake` — filing, trade and event normalization shared with production consumers.
- `src/storage` — the turnkey SQLite repository plus optional Parquet publication.
- `src/runtime` and `src/providers` — concrete PDF, OCR and completion adapters for the CLI.
- `src/sync.ts` and `src/cli.ts` — the end-to-end product path.
- `src/integrity.ts` — published-table checks. **Knows nothing about S3 or Mongo.**

The module boundary is deliberate: if a change makes either statement false, the change
is wrong. A vendor name belongs in a config value, never in a type, a class name or an
interface. (There used to be two published packages; they were merged because the split
taxed the only consumer twice and served a hypothetical generic user who never came.)

## Rules that are not negotiable

**No secrets in source or logs.** Reusable library modules receive credentials and configuration
through explicit options. The CLI is the one environment boundary: it may read documented keys
such as `MISTRAL_API_KEY` and `OPENROUTER_API_KEY`, but it must never print their values. S3-compatible
storage may use the AWS SDK's standard credential chain.

**Ports stay narrow.** Each interface is the smallest surface the pipeline uses, not a mirror of
some client's API. The extraction `CompletionClient` and encrypted-PDF `PdfDecrypt` ports each
have one method. The default CLI supplies concrete implementations; custom applications replace
only the boundaries they need. Resist adding a method for a caller that does not exist yet.

**Strict TypeScript, and no `any`.** `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` are all on. When a type fights you, the type is usually right.

**Tests cover the rule that corrupts data**, not the getters. The lease has five tests because
its failure mode silently poisoned 613 filings. `acquireProviderLease` in the system this came
from had *zero* tests, which is exactly why that shipped.

**The public and npm READMEs are one document.** `README.md` is what GitHub shows and
`packages/congressional-disclosures/README.md` is what npm publishes. Keep them byte-for-byte
identical. A user must not get a different product promise or command depending on which page
they opened. Verify with `cmp README.md packages/congressional-disclosures/README.md`.

## Never copy pages from a PDF you have not decrypted

Every electronic House PTR sampled — 2015, 2018, 2023, 2024 — is **RC4-encrypted**. `pdf-lib`
opens one with `ignoreEncryption: true` and then copies its pages as **blank pages, raising no
error**: the copy carries encrypted streams into a document with no encryption dictionary. The
page renders empty and yields about one character of text instead of tens of thousands.

So any code that splits, crops or merges a filing must decrypt first. The default CLI rewrites
encrypted input with Poppler's `pdftocairo` before copying pages. A host application may inject
PDFium or another equivalent decryptor, but the resulting document must be demonstrably
unencrypted and nonblank before any page split.

This is silent in every direction. No exception, no warning, and the model dutifully reports
that the page has no rows, so the filing is recorded as a legitimate extraction failure. It cost
a production round its page-range splitting before anyone noticed the splits could never have
worked.

## Things that look like bugs and are not

**Batching.** Packing many filings into one model request is roughly ten times cheaper than one
request each, and ticker resolution deduplicates across a batch. Do not "fix" batching into
streaming. Tune `batchSize` — that is the observability knob.

**The lease fencing a dispatched attempt.** That is correct while the outcome is unknown. The
bug was fencing *forever*; reclaiming after `abandonedAfterMs` is the fix. Do not remove the
fence.

**Re-listing the input every pass.** Looks wasteful, is load-bearing: another machine may have
finished work in this slice, which is normal after a re-shard.

## Debugging a stalled backfill

Learned expensively. Follow it in order.

1. **Read the function the job is executing, top to bottom, before measuring anything.** Look
   for `for (… of …) { await … }` in the hot path and for batch-then-process structure. Both are
   invisible from outside and both produce long silences.
2. **Read that machine's own log**, not the shared window — one chatty host floods a ~100-line
   buffer and evicts the line that names the cause.
3. **Grep for what the machine says, not only for the failures you predicted.** A kernel OOM
   message will not match a grep for HTTP status codes.
4. **Count receipts in the store** for progress. Logs roll over; machine state lies.
5. **Prove one unit of work end to end before fanning out.** One receipt, not thirty-two hosts
   with healthy CPU.

A note on sampling: a request-bound job idles between responses, so a 12-second CPU sample can
read as a stall when the process is fine. Use a 60-second window or longer.

## Commits

State what changed and why it was wrong before. Failure modes are the valuable part of the
history here — if a commit message could describe any project, it is not specific enough.

## Publishing

The package is published unscoped, with `--access public`:

```bash
cd packages/congressional-disclosures
npm run build
npm publish --access public
```

The public repository root deliberately mirrors the package name, version, entrypoint and runtime
dependencies so `npm install github:austin-starks/congressional-disclosures` is usable. npm
publication must still run from the package directory or with
`npm publish --workspace congressional-disclosures`; publishing the private workspace root is not
the release path.
