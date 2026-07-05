# Review-report fix progress

Fixing findings from `review-report.md`, **excluding 6, 10, 11** (per instructions).
Commit after each fix.

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Verifier trusts backend for response set / answer contents | High | ✅ done |
| 2 | Sealed-survey reveal dedups before reveal-time validation | Medium | ✅ done |
| 3 | Validated-then-rolled-back response postpones finalization forever | Medium | ✅ done |
| 4 | Unknown-survey responses re-fetched from Koios forever | Medium | ✅ done |
| 5 | CI never runs core/koios/verifier/backend tests; stale lockfiles | Medium | ✅ done |
| 6 | Direct-Koios tallies cancelled-then-closed surveys | Low | ◑ partial (claim warning kept) |
| 7 | Authoring doesn't enforce `@context` maps CIP-179 terms | Low | ☐ todo |
| 8 | Cancel-survey flow lacks wallet-network gate | Low | ✅ done |
| 9 | Koios JSON metadata adapter corrupts ints >2^53 / misreads "0x" | Low | ✅ done |
| 10 | Respond UI can't express partial rating answer | Low | — SKIP |
| 11 | Pinned ruleset hash doesn't pin validator code | Low | ✅ done |
| 12 | Stale doc references to nonexistent spec path | Low | ✅ done |

## Notes
- **12** (commit): pointed `backend/GOAL.md` + `backend/RESEARCH.md` at
  `../frontend/cip-179.md`.
- **8** (commit): `OwnerControls` now computes `networkMismatch` and disables the
  cancel/confirm buttons + shows a switch-network note; added `survey.switchNetwork`
  i18n (en/fr) and a `.cancelBtn:disabled` style.
- **9** (commit): `koiosJsonToMetadatum` rejects any numeric value that isn't a
  safe integer (was `BigInt(Math.trunc(json))`); added `metadatum.test.ts`.
- **5** (commit): single root workspace CI job (`pnpm -r type-check/test/build` +
  app `format:check`), Node 22, deleted nested lockfiles, formatted pre-existing
  Respond.tsx violation.
- **7** (commit): core `anchorContextMapsCip179Terms` predicate (tested);
  `validateAnchorShape` blocks a `body.cip179` link whose `@context` doesn't map
  the CIP-179 terms; `LinkActionPanel` now offers the ready-made `@context`
  snippet with a copy button.
- **4** (commit): `validateNewResponses` resolves the survey definition in the
  candidate filter so unknown-survey responses never enter the Koios fetch set;
  test now asserts no fetch.
- **3** (commit): added `deleteValidatedResponses` to the store seam (node/D1/mem);
  `finalizeClosedSurveys` prunes counted rows absent from a complete snapshot and
  postpones one refresh (reorg buffer) instead of livelocking. Rewrote the
  finding-3 test + added a re-count-on-return test.
- Note: `finalize.test.ts` names some tests "(finding 1)" / "(finding 5)" — these
  refer to an *earlier* review's numbering (pending-verdict postpone, weight
  resume cursor), not this report's. Left as-is.
- **2** (commit): added core `auditRevealedResponses` (decrypt full pre-dedup
  in-window set → classify → dedup only valid decoded); `SealedResults` now gets
  `inWindow` + `hardExcluded` and defers dedup to it. Unit-tested in core.
- **1** (commit): verifier CLI now sources the survey definition + response set +
  answers from an independent `KoiosDataSource.fetchAll` scan (filtered to the
  ref), not the backend; only the artifact-under-test comes from the backend.
  Added `diffResponseSets` cross-check + incomplete-scan note + not-found error.
  Updated trust-model docs. A lying backend now gets MISMATCH.
- Extra: fixing finding 1 required running `pnpm -r build` (fresh `cip-179` dist),
  which surfaced a **stale koios test fixture** (empty answer list rejected by the
  current codec, commit 53ff9f9). Fixed the fixture — committed separately; it's
  the silent drift finding 5 was about (koios tests never ran in CI).

- **6** (partial, commit): took only the "keep the claim warning" half of the
  suggested fix (not the lazy closed-survey proof fetch). `cancellationStates`
  now surfaces an in-window unverified cancellation as `claimed` for *closed*
  surveys too (gated on `epochNo ≤ endEpoch`), so the "unverified cancellation
  claim" notice no longer vanishes at close; `cancellationClaimed` is suppressed
  when the survey is already `cancelled` (verified/overlay). Reworded the notice
  (en/fr) to drop the now-inaccurate "survey remains open". Direct mode still
  does NOT verify closed-survey cancellations or suppress their tally — the
  conformance gap on tallying itself remains, by design (anti-griefing).

- **11** (commit): golden test in `artifact.test.ts` pins `rulesetHash()` to a
  literal, so any descriptor change (or forgotten `rulesetVersion` bump) fails
  CI. Added RULESET-PINNED-BEHAVIOR notes at the two behavior sites the hash
  only *describes* — `cip179/src/validate.ts` (validity) and
  `core/src/dedupe.ts` (dedup order) — and cross-referenced them from
  `RULESET_DESCRIPTOR`. Didn't hash the code itself (refactors would churn it);
  the process hazard is now caught by CI instead of relying on memory.

## Result
All 9 targeted findings fixed (1–5, 7, 8, 9, 12); 6/10/11 skipped per request.
Whole workspace green: `pnpm -r type-check`, `pnpm -r test` (267 tests),
`pnpm -r build`, app `format:check` all pass.
