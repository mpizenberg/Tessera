# Review-report fix progress

Fixing findings from `review-report.md`, **excluding 6, 10, 11** (per instructions).
Commit after each fix.

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Verifier trusts backend for response set / answer contents | High | ☐ todo |
| 2 | Sealed-survey reveal dedups before reveal-time validation | Medium | ☐ todo |
| 3 | Validated-then-rolled-back response postpones finalization forever | Medium | ☐ todo |
| 4 | Unknown-survey responses re-fetched from Koios forever | Medium | ☐ todo |
| 5 | CI never runs core/koios/verifier/backend tests; stale lockfiles | Medium | ✅ done |
| 6 | Direct-Koios tallies cancelled-then-closed surveys | Low | — SKIP |
| 7 | Authoring doesn't enforce `@context` maps CIP-179 terms | Low | ☐ todo |
| 8 | Cancel-survey flow lacks wallet-network gate | Low | ✅ done |
| 9 | Koios JSON metadata adapter corrupts ints >2^53 / misreads "0x" | Low | ✅ done |
| 10 | Respond UI can't express partial rating answer | Low | — SKIP |
| 11 | Pinned ruleset hash doesn't pin validator code | Low | — SKIP |
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
- Observed while running tests: `finalize.test.ts` already has tests literally
  named "(finding 3)" and "(finding 1)" — inspect before touching those paths.
