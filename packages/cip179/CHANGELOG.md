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
- **Tally bodies are now sparse and carry no level histogram** (`./tally`).
  Per-option and per-level aggregates were dense arrays sized by the definition's
  declared option count / rating span — a hostile `count: 2^40` or wide numeric
  scale forced a `new Array(~10^15)` allocation (`RangeError`/OOM). The body now
  carries only the options actually answered, each tagged with its own `index`,
  so cost grows with responses rather than the declared width; and the
  per-scale-level weight histogram is gone entirely (it was display-only, read by
  no verifier, and derivable from the committed responders, so `ratingScaleInfo`
  no longer touches the hashed path).
  - `WeightedQuestionTally`/`ArtifactQuestion` `kind:"options"` drop
    `optionWeights` + `optionCounts` for `options` — a list of
    `WeightedOptionBucket` (`index`, `weight`, `count`), index ascending.
  - `kind:"perOption"` drops the dense `perOption` array + `levelWeights` for a
    list of `WeightedPerOption` (`index`, `weightedSum`, `answeredWeight`,
    `count`), index ascending. `answeredWeight` is **optional**: present for
    rating (each option's raters differ), omitted for points (every option's
    denominator is the question-level `answeredWeight`), so a points mean divides
    by that question-level value.
  - Removed `WeightedOptionAggregate`; added `WeightedOptionBucket` and
    `WeightedPerOption`.
  - Consumers that indexed the old dense arrays positionally must now read each
    entry's `index`; a zero-answer option is simply absent (refill from the
    definition if you render every option).
- **Ruleset bump: `rulesetVersion` 4 → 6** for the sparse, slimmed tally body.
  The counted set and every aggregate value are unchanged (representation only),
  but the body schema differs, so `rulesetHash()` changes and 0.3.0 artifact
  hashes are incomparable with 0.2.0 (v4).
- **Removed the count-based display tally from the public API** (`./tally`):
  `tallySurvey`, `tallyQuestion`, `roleBreakdown`, `ratingScaleInfo`,
  `MAX_DISPLAY_BUCKETS`, and the display shapes (`QuestionTally`, `Bar`,
  `PointsRow`, `RatingRow`, `HistogramBin`) no longer ship from `cip-179`. This
  was presentation (floats, bar fills, means, level bucketing), never
  content-addressed; once the hashed body dropped its level histogram it had no
  in-package dependent, so it now lives with its one consumer in the frontend.
  The package keeps only the codec, domain, and the reproducible weighted tally /
  artifact. (No external non-frontend consumer existed.)
- Numeric constraints (`min`/`max`/`step` on `numericRange` questions and numeric
  rating scales) are now rejected at decode when outside the JS-safe integer
  range (`Cip179DecodeError`), matching how the bare level count already behaved.
  A definition carrying an out-of-safe-range bound no longer decodes.

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

- The `validateResponse`/`validateDefinition` change is representation-only: the
  validity _verdict_ is unchanged (the list is empty iff the structure is valid),
  so on its own it needed no `rulesetVersion` bump.
- The **tally schema change bumps the ruleset** (`rulesetVersion` 4 → 6, above):
  the hashed body's schema changed (sparse, and no level histogram) even though no
  counted value did. 0.3.0 hashes are incomparable with 0.2.0 (v4), so artifacts
  re-finalize on deploy; the golden `rulesetHash()` test was updated in the same
  change.

## [0.2.0]

Prior published baseline (no changelog kept before this point).
