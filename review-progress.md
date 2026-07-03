# Review remediation progress

Tracks the fixes for the findings in `review-report.md` (review of 2026-07-03,
branch `backend-cf` @ `7342e92`). The report is the immutable reference — the
*what*; this file is the *current state*. One entry per finding number.

Statuses: `todo` | `in progress` | `done <commit>` | `won't-fix (rationale)`.

When fixing: update the entry with the commit hash, and add a one-line note if
the fix deviated from the report's suggested direction.

## High

| # | Finding (short) | Status |
| --- | --- | --- |
| 1 | Finalize emits artifacts while proof verdicts pending (`proofOk`/`blockIndex` null not an incompleteness reason) | done (pending commit) |
| 2 | Mechanism-B verdicts pinned to gov links known at first validation, never re-checked | todo |
| 3 | Failed `tx_metadata` batch silently shrinks snapshot; finalize emits from it (`!record` not guarded) | todo |
| 4 | No pagination on bulk weight/membership reads — Koios 1000-row cap truncates silently | todo |

## Medium

| # | Finding (short) | Status |
| --- | --- | --- |
| 5 | Weight-fetch resume cursor only resumes between roles, not within one; snapshot scan has no resume | todo |
| 6 | cip179: no byte-length checks on hashes/tx ids (`HASH28_BYTES`/`HASH32_BYTES` unused) | todo |
| 7 | cip179: points decoded via unchecked `Number()`, budget validated with float sum | todo |
| 8 | cip179: option/scale labels encoded without the 64-byte bound | todo |
| 9 | ProposeInfoAction reads list resource unguarded → crashes to error screen | todo |
| 10 | Wallet-connect failures silently swallowed by header menu | todo |
| 11 | Survey screen state leaks across surveys (component not keyed on `:key`) | todo |
| 12 | Test-suite gaps: finalize pending-verdict behavior, koios pagination, verifier dedup-tie/mech-B, cip179 roundtrips, create/respond untested | todo |
| 13 | cip179: empty answer arrays accepted against CDDL `[+ …]` | todo |
| 14 | `addOptimisticSurvey` silently no-ops when list isn't loaded | todo |

## Low

| # | Finding (short) | Status |
| --- | --- | --- |
| 15 | Dead code cluster: `domain/cancellation.ts` shim, `decodeCancellationProof` alias (+ alias test), dead `metadatum.ts` helpers; mixed shim/direct core imports | todo |
| 16 | `mechanismA` duplicates `cancellationVerified` | todo |
| 17 | Can't-happen `?? {slot: 0, epochNo: 0}` fallback in `fetchAll` — throw instead | todo |
| 18 | Presentation floats/types (`Bar.pct`, sample cap) inside `@tessera/core` tally.ts vs §4 claim | todo |
| 19 | Post-close cancellations invisible outside the artifact (list shows "Ended", raw tally in direct mode) | todo |
| 20 | Dead artifact error guard in Survey.tsx (fetcher `.catch(() => null)` makes it unreachable) | todo |
| 21 | Numeric slider precision above 2^53 (`sliderOk` doesn't bound min/max) | todo |
| 22 | Delete stale `frontend/app/review-progress.md` / `review-report.md` | done cfde1b3 |
| 23 | Doc drift ×3: Settings Pro-toggle persistence claim, "poll Koios" comments, hardcoded English role descriptions | todo |
| 24 | cip179: `[0]` public submission mode accepts trailing elements | todo |
| 25 | tlock padding tests never exercise labels/count scales or count-form options | todo |
