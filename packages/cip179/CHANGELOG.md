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
- **Ruleset bump: `rulesetVersion` 4 → 11.** Six changes land in this release, so
  0.3.0 artifact hashes are incomparable with 0.2.0 (v4) and artifacts
  re-finalize on deploy. `RULESET_DESCRIPTOR` carries the full note for each.
  - **v5, v6** — the sparse, slimmed tally body (above). The counted set and
    every aggregate value are unchanged (representation only), but the body
    schema differs.
  - **v7** — an empty answers array is no longer a valid response, so a sealed
    ballot revealing to zero answers is excluded rather than counted as a
    participant. The counted set can differ.
  - **v8** — read-side definition validity is enforced: a survey whose on-chain
    definition has any error-severity problem (including `spec_version != 5`) is
    untalliable and produces no artifact. No valid survey's tally changes; the
    set of talliable surveys does.
  - **v9** — a sealed responder's committed answers sort a custom answer's map
    entries by the canonical JSON of the tagged key, instead of inheriting the
    injected CBOR decoder's entry order.
  - **v10** — a batched payload is read item by item, so a well-formed record
    batched beside a malformed one is counted instead of being skipped with it.
    The counted set can grow.
  - **v11** — the talliability gate enforces CIP-179's epoch rule: `end_epoch`
    must be greater than the epoch the definition transaction was included in.
    The set of talliable surveys shrinks.
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

- `isSurveyTalliable(record)` / `surveyErrors(record)` — the read-side
  talliability gate, now taking a `SurveyRecord` because one of its rules needs
  the definition's chain position (`end_epoch` > inclusion `epoch_no`).
  `isDefinitionTalliable` / `definitionErrors` remain for what a definition can
  decide about itself, but the gate an emitter or verifier applies is the
  record-level pair.
- `definition.endEpochNotAfterInclusion` validation problem code.
- `decodePayloadItems` — the per-item counterpart to `decodePayload`, returning
  each decoded item with its position in the on-chain array plus a `skipped`
  list for the ones that failed. CIP-179 validates batched records
  independently, so this is what a chain reader should use; `decodePayload`
  stays as the strict all-or-nothing decoder (it now throws the _first_ item's
  error, in array order).
- `Cip179LinkResult.specVersion` — a governance link's declared CIP-179
  revision, or `null` when absent or not an integer, alongside a problem
  describing it. Advisory only: a link at another revision keeps its
  `surveyRef`, since the CIP's link-validation rules are the ref resolving, the
  epoch alignment and the `kind`.
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

### Fixed

- **`govActionId` no longer truncates the action index to one byte.** The index
  was written into a single array slot, so index 256 encoded as index 0 — and
  since mechanism-B matching compares ids from this function on both sides, the
  collision was self-consistent: a vote on action 256 satisfied a link to
  action 0. It is now big-endian in the narrowest width that holds it (one byte
  reproduces every CIP-129 vector, two cover the rest of Conway's
  `gov_action_index`), and an index outside `uint .size 2` throws.
- **`chunked_text` / `chunked_bytes` reject the empty array** the CDDL forbids
  (`chunked_text = bounded_text / [+ bounded_text]`, and the `bounded_bytes`
  analog — the array form is one-or-more). `decodeChunkedText([])` previously
  joined to `""`, letting a non-external survey acquire the empty title only
  external-content mode permits; both decoders now throw.
- **Sealed-answer decode honors the decoder's error contract.** A malformed
  sealed `answers` array (e.g. `[bytes, 5]`) leaked a bare `TypeError` from
  `decodeChunkedBytes`; both sealed-ciphertext decode paths now surface a
  path-carrying `Cip179DecodeError`, like every other decode branch, so callers
  filtering on `Cip179DecodeError` classify it correctly.
- **Encoders fail early on the CDDL size/bounds the decoder already enforces**,
  instead of emitting metadata every conformant decoder (including this
  package's own) would reject — a wrong-size hash or negative epoch was
  previously caught only after a fee-paying submission. `encodeSurveyRef`
  (tx_id 32 B, index `uint .size 2`), `encodeContentAnchor` (hash 32 B),
  `encodeCredential` (hash 28 B), `encodeSubmissionMode` (chain_hash 32 B,
  round/padding `uint`), and `end_epoch` now throw `Cip179EncodeError` on
  out-of-bounds input. Valid inputs encode byte-for-byte as before.

### Notes

- The `validateResponse`/`validateDefinition` change is representation-only: the
  validity _verdict_ is unchanged (the list is empty iff the structure is valid),
  so on its own it needed no `rulesetVersion` bump.
- The **ruleset bumps** (`rulesetVersion` 4 → 9, above) each updated the golden
  `rulesetHash()` test in their own change — that test exists to make an
  unbumped ruleset change fail CI, so it is never updated on its own.
- The **decode/encode conformance fixes** (under _Fixed_) only reject malformed
  input more strictly; valid-input behavior and the hashed artifact body are
  unchanged, so they carry **no `rulesetVersion` impact** and the golden
  `rulesetHash()` is untouched.

## [0.2.0]

Prior published baseline (no changelog kept before this point).
