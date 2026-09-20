# Contributing

Issues and focused pull requests are welcome. Start with a concrete filing, command, or result that is wrong. A parser rewrite without a failing fixture is difficult to review and easy to overfit.

## I found a defect

Use the repository's bug-report form. Include:

- the installed package version;
- the exact command or smallest code sample that reproduces the problem;
- the public filing URL or document id, when one filing triggers it;
- the expected result and the actual named failure;
- Node, operating-system, Poppler, and Tesseract versions when relevant.

Do not paste API keys, cookies, or paid-provider responses. Report security problems through [SECURITY.md](SECURITY.md), not a public issue.

If you want to fix the defect, add an offline fixture that reproduces it first. A useful pull request shows the failing test, the smallest fix, and the passing release gates. It does not need a broad refactor.

## I want to add a provider or integration

Open an integration request before building it. Name the user problem, the proposed dependency, and the narrow interface it would implement:

- `CompletionClient` is for a model that can return the complete structured extraction response.
- `OcrClient` turns a PDF or page image into text.
- `PoliticalRepository` atomically replaces complete filings and stores run results.
- `ParquetLakePort` lets an application keep its own object-store and Parquet implementation.

Include a small usage sketch, a stubbed offline test, credential handling, expected cost, and why an existing interface is insufficient. New providers must be optional; installing the package or downloading the public snapshot cannot require their credentials. If none of the existing boundaries fit, describe the smallest new boundary and how the current path continues to work without it.

## Set up the repository

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The encrypted House fixture needs Poppler. Install `poppler-utils` and Tesseract before running the full smoke test:

```bash
npm run smoke:fixture
```

Tests must be offline and deterministic unless their name explicitly says `live`. Never commit provider responses that contain credentials or non-public material.

Coding agents and other automated contributors must read `AGENTS.md` before editing. The same evidence rules apply regardless of who wrote the patch: cite the failing path, add a regression test, and report which commands actually ran.

## Before opening a pull request

Run:

```bash
npm run typecheck
npm test
npm run verify:release
```

Add a fixture that fails before the fix and passes after it. For extraction changes, keep the original printed value, source URL, and failure reason visible; do not turn an uncertain value into a confident one.

The root package supports GitHub installs while `packages/congressional-disclosures` is the npm package. Their versions, exports, and READMEs must agree. The root `*.js` and `*.d.ts` files are intentional forwarding shims, not generated build output.

Do not edit both READMEs separately. Edit one, copy it to the other, and verify:

```bash
cmp README.md packages/congressional-disclosures/README.md
```

## Scope

Keep pull requests narrow. Do not mix a parser fix with formatting or unrelated dependency updates. A useful commit message states what changed and what previously failed.
