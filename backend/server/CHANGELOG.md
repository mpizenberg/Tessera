# Changelog

The HTTP contract of the Tessera serving backend — every route under `/api/`
and `/health` — as the Endpoints section of [README.md](README.md) describes
it. The version is `API_VERSION` in `packages/core/src/source.ts`, beside the
payload types it versions, and is reported by `GET /health` and
`GET /api/health` as `apiVersion`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The version is `major.minor`, not semver: an additive change (a new field, a
new selection, a new route) bumps the minor; a replacing change (a field
renamed, removed or re-typed, a selection whose semantics changed) bumps the
major, and the backend then serves the new shape only — no transition window,
no dual-serving. A consumer compares majors and refuses a mismatch; it may warn
on a minor it does not know. Every bump has a line here, and the README's
Endpoints section changes in the same commit.

## [1.0] - unreleased

The contract as deployed on preprod, now versioned: the paged and
by-reference selections of `/api/surveys` (`countedByRole` and `finalState`
included), the paged bundle with its `verdicts` and `govLinks`,
`/api/responded`, `/api/responses/{txHash}`, the artifact routes, `/api/tip`,
`/api/tx_status`, `/api/pparams`, and `/api/health`. The README is the
description; this entry is the baseline later entries diff against.

### Added

- `apiVersion` on `GET /health` and `GET /api/health`.

### Changed

- `GET /api/responses/{txHash}` rows carry exactly the five documented fields
  (`surveyKey`, `responseIndex`, `role`, `credential`, `slot`). The storage
  projection's `txHash` (the request's own path) and `countable` (an internal
  column) no longer ride along.
