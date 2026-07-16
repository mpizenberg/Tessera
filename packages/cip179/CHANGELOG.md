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
- **Tally bodies are now sparse** (`./tally`). Per-option and per-level
  aggregates were dense arrays sized by the definition's declared option count /
  rating span — a hostile `count: 2^40` or wide numeric scale forced a
  `new Array(~10^15)` allocation (`RangeError`/OOM). They now carry only the
  options/levels actually answered, each tagged with its own `index` (and
  `level`), so cost grows with responses rather than the declared width.
  - `WeightedQuestionTally`/`ArtifactQuestion` `kind:"options"` drop
    `optionWeights` + `optionCounts` for `options` — a list of
    `WeightedOptionBucket` (`index`, `weight`, `count`), index ascending.
  - `kind:"perOption"` drops the dense `perOption` array + `levelWeights` for a
    list of `WeightedPerOption` (`index`, `weightedSum`, `answeredWeight`,
    `count`, optional sparse `levels`), each `levels` entry a
    `WeightedLevelBucket` (`level`, `weight`).
  - Removed `WeightedOptionAggregate`; added `WeightedOptionBucket`,
    `WeightedPerOption`, `WeightedLevelBucket`.
  - Consumers that indexed the old dense arrays positionally must now read each
    entry's `index`; a zero-answer option is simply absent (refill from the
    definition if you render every option).
- **Ruleset bump: `rulesetVersion` 4 → 5** for the sparse tally body. The
  counted set and every aggregate value are unchanged (representation only), but
  the body schema differs, so `rulesetHash()` changes and v5 artifact hashes are
  incomparable with v4.
- **Slimmed the hashed tally body** (`./tally`): two presentation/redundant
  fields no longer participate in the artifact hash.
  - Rating `perOption` entries drop `levels` — the per-option, per-scale-level
    weight histogram. It was a display device (built via `ratingScaleInfo`
    bucketing), read by no verifier, and derivable from the committed responders;
    `ratingScaleInfo` no longer participates in the hashed path at all.
  - Points `perOption` entries drop `answeredWeight` — it merely duplicated the
    question-level `answeredWeight` (points makes every option's denominator the
    same). Rating keeps its per-option `answeredWeight` (each option's raters
    genuinely differ). `WeightedPerOption.answeredWeight` and the artifact's
    `perOption[].answeredWeight` are now optional (present for rating only);
    `WeightedLevelBucket` is removed.
  - Consumers computing a points mean must divide by the question-level
    `answeredWeight` rather than a per-option field.
- **Ruleset bump: `rulesetVersion` 5 → 6** for the slimmed body. Again pure
  representation (no counted value changes), but the schema differs, so
  `rulesetHash()` changes and v6 hashes are incomparable with v5.
- Numeric constraints (`min`/`max`/`step` on `numericRange` questions and numeric
  rating scales) are now rejected at decode when outside the JS-safe integer
  range (`Cip179DecodeError`), matching how the bare level count already behaved.
  A definition carrying an out-of-safe-range bound no longer decodes.

### Added

- `MAX_DISPLAY_BUCKETS` (in `./tally`) — the cap on how many option/level
  buckets the count-based **display** tally materializes (the hashed artifact is
  sparse and needs no cap). Keeps a hostile declared span from crashing the
  results view; no real survey approaches it.
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
- The **tally schema changes bump the ruleset** twice (`rulesetVersion` 4 → 5 for
  sparsification, then 5 → 6 for the slimmed body, both above): the hashed body's
  schema changed even though no counted value did. v6 hashes are incomparable
  with v5 (and v4), so artifacts re-finalize on deploy; the golden `rulesetHash()`
  test was updated in the same changes.

## [0.2.0]

Prior published baseline (no changelog kept before this point).
