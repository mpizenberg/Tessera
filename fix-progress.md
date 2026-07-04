# Review-report fix progress

Fixing findings from `review-report.md`, **excluding 6, 10, 11** (per instructions).
Commit after each fix.

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Verifier trusts backend for response set / answer contents | High | ☐ todo |
| 2 | Sealed-survey reveal dedups before reveal-time validation | Medium | ☐ todo |
| 3 | Validated-then-rolled-back response postpones finalization forever | Medium | ✅ done |
| 4 | Unknown-survey responses re-fetched from Koios forever | Medium | ✅ done |
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
