# Changelog

The HTTP contract of the Tessera serving backend — every route under `/api/`
and `/health` — as the Endpoints section of [README.md](README.md) describes
it. The version is `API_VERSION` in `packages/client/src/payloads.ts`, beside
the payload types it versions, and is reported by `GET /health` and
`GET /api/health` as `apiVersion`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The version is `major.minor`, not semver: an additive change (a new field, a
new selection, a new route) bumps the minor; a replacing change (a field
renamed, removed or re-typed, a selection whose semantics changed) bumps the
major, and the backend then serves the new shape only — no transition window,
no dual-serving. A consumer compares majors and refuses a mismatch; it may warn
on a minor it does not know. Every bump has a line here, and the README's
Endpoints section changes in the same commit.

## [Unreleased]

Still `2.0`: the artifact changes below move fields, which this changelog's
rule makes a major, but no consumer besides Tessera's own app has read an
ended survey's artifact, and the app deploys with the backend.

### Changed

- The artifact routes serve ruleset 14 artifacts: each role's electorate
  total moves from `tally.perRole[].total` to a new required top-level
  section, `info`, whose `perRole` lists `{ role, total }` for the DRep and
  Stakeholder roles, outside the hash. The ruleset hash moves too, from
  `tally.rulesetHash` to `provenance.rulesetHash`, so a later rule change
  leaves the hash of every result it does not change. Every stored artifact
  is re-emitted when this deploys, under a new hash; a survey reads as ended without an
  artifact until the next finalization pass, which stamps its row so a
  mirror following `changes` receives the new hash.
- `GET /api/surveys/{txHash}/{index}/artifact` is served `no-cache` rather
  than `immutable`, since a survey's artifact changes when it is re-emitted;
  its `ETag` is still the artifact hash, so a revalidation is a bodiless
  `304`. `GET /api/artifacts/{hash}` stays `immutable`.

## [2.0] - 2026-09-15

### Changed

- A points question's `budget` and a points answer's allocation `points` are
  big integers in every body that carries a survey definition or a response —
  the survey list and its selections and the bundle — so they cross the wire
  as `{"$bigint": "…"}`, not as JSON numbers. A 1.x consumer decoding them as
  numbers breaks, hence the major.
- A sealed survey's artifact no longer carries `answers` on its counted
  responders: every responder has the same four fields, sealed or public. The
  answers are reproduced by decrypting the on-chain ciphertexts with the
  beacon the definition pins, as a verifier already did.
- Surveys and responses carrying numeric bounds, budgets or points above 2^53
  are served, and finalized under ruleset 13 (see `cip-179`'s changelog); they
  used to be dropped as undecodable. No survey on chain today carries one.
- The stored rows of surveys with a points question are re-stamped when this
  version deploys, so a mirror following `changes` receives them again in the
  new form with its next delta.

## [1.2] - 2026-09-07

### Added

- `GET /api/surveys?since=<unix seconds>`, the change selection from an instant
  the caller names rather than a position the server minted: the same answer as
  `changes`, for everything stamped strictly after `since`. Composes with
  `limit` only, and is refused beside `changes`, `refs`, `filter`, `q`,
  `cursor` and `credentials`. `nextCursor` is an ordinary minted cursor, so a
  consumer bootstraps once from a date and follows `changes` after. A `since`
  above the published generation answers an empty delta, not an error.

### Changed

- The change selection has no horizon. Tombstones are kept for the life of the
  corpus instead of the operational retention window, so every position is
  answerable: `changes` never answers `resync`, and its `nextCursor` is never
  null. Nothing a 1.1 consumer could read disappears — its `resync` and null
  branches become unreachable — so this is a minor.
- Removals reach back to the first change-selection deploy on each network
  (2026-09-04 on both). A `since` older than that reports rows without the
  removals of that era; a consumer whose knowledge predates it starts from a
  walk.
- Change stamps on rows written before 2026-09-04 are dated by chain time —
  the survey's transaction, its newest response or cancellation, or the
  finalizer's decision — so a `since` below that deploy is answered at the
  resolution of a row's last chain event. A governance-link change carries no
  date, so a row whose only pre-deploy change was its link set is dated by its
  last chain event instead.

## [1.1] - 2026-09-04

### Added

- `GET /api/surveys?changes=<cursor>`, the change selection: the list payload
  for the surveys whose stored projection moved since a server-minted
  position, the survey keys `removed` since, and a `nextCursor`. Composes
  with `limit` only; a cursor older than the retention window answers
  `resync: true` with `nextCursor: null`.
- `changesCursor` on every paged `GET /api/surveys` answer: where a full walk
  at that snapshot hands over to `changes`.

## [1.0] - 2026-09-04

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
- `ageSeconds` leaves the `/api/surveys` and bundle bodies. It drifted within
  a refresh window and was outside the ETag, and no consumer read it; staleness
  derives from `fetchedAt`. `GET /api/health`'s `snapshot.ageSeconds` stays.
