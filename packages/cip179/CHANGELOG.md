# Changelog

All notable changes to the `cip-179` package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

## [Unreleased]

Targeting **0.3.0** — the version is already set in `package.json` but not yet
published. Keep adding entries here until release.

### Changed (breaking)

- `validateResponse` and `validateDefinition` now return
  `ValidationProblem[]` (`{ code, params }`) instead of `string[]` of
  hard-coded English prose, so callers can render problems in any language.
  Consumers that only checked emptiness (`.length === 0` ⇒ valid) are
  unaffected. Consumers that displayed the strings should map `code` to their
  own catalog, or call `describeProblem` for the previous English wording.

### Added

- `surveyStatus(endEpoch, tipEpoch)` (in `./domain`) — the tip-only
  active/ended lifecycle rule, factored out of the internal `statusOf` so an
  embedding host (e.g. the `<tessera-respond>` widget) can gate open/closed from
  just the definition's `endEpoch` and a chain-tip epoch, without the full
  records snapshot `aggregate` needs. No behavior change to `aggregate`.
- `ValidationProblem` and `ValidationProblemCode` types.
- `VALIDATION_PROBLEM_CODES` — the frozen set of every code the validators can
  emit (stable identifiers a UI maps to localized messages).
- `describeProblem` / `describeProblems` — default English rendering of a
  problem (`{token}` params interpolated); the self-describing fallback.

### Notes

- **No ruleset change.** The validity _verdict_ is unchanged — the returned
  list is empty iff the structure is valid — so the tally ruleset hash in
  `@tessera/core` is untouched (no `rulesetVersion` bump); the golden artifact
  test stays green. Only the _representation_ of problems changed.

## [0.2.0]

Prior published baseline (no changelog kept before this point).
