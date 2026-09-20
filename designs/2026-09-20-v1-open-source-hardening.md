# v1.0 open-source hardening

## Why 1.0

The package now has two complete product paths: download a verified public snapshot, or build a local SQLite lake from the official House and Senate sources. Version 1.0 marks those paths, the CLI command names, the documented SQLite table grains, and the published JavaScript entry points as supported public contracts.

This release is not a rewrite. It adds release gates and documents behavior that already exists.

## Changes

- Run type checking, unit tests, the encrypted-filing smoke test, dependency audit, build, and package-layout checks in GitHub Actions.
- Fail publication when the root GitHub-install package and the npm workspace disagree on version, README, exports, or compatibility shims.
- Document the conservative ticker policy and the hosted snapshot cadence.
- Add contributor, security, conduct, issue, and pull-request guidance tied to this repository's real commands and failure modes.
- Add a deterministic lake fixture for a spouse-owned option partial sale and an amended amount range.
- Publish both package manifests as `1.0.0` and record the release in the changelog.

## Deliberate non-changes

- Keep the root `*.js` and `*.d.ts` shims. They are hand-written forwarders used by `npm install github:austin-starks/congressional-disclosures`, not compiler output.
- Do not infer missing tickers. The sync path records printed tickers and leaves absent tickers unresolved; downstream enrichment must record its own result and reason.
- Do not add a `lint` badge or claim a lint gate until the repository has a real lint configuration.
- Do not create an empty "good first issue" for appearance's sake.

## Release gates

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm audit --omit=dev --audit-level=high`
5. `npm run verify:release`
6. `npm run smoke:fixture`
7. Install the packed tarball in a fresh directory and require the main entry point plus every documented subpath.
8. Compare both README files byte for byte.

The npm publish remains a deliberate maintainer action. CI does not receive an npm token.
