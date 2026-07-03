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
| 1 | Finalize emits artifacts while proof verdicts pending (`proofOk`/`blockIndex` null not an incompleteness reason) | done ac55932 |
| 2 | Mechanism-B verdicts pinned to gov links known at first validation, never re-checked | done b2b13ca — persist `linked_action_id` (migration 0004), re-validate bindable rows on link change, defer verdicts when gov-links fetch unreliable |
| 3 | Failed `tx_metadata` batch silently shrinks snapshot; finalize emits from it (`!record` not guarded) | done 2095600 — flag snapshot incomplete on batch failure, skip finalization when incomplete, postpone survey with a missing response record |
| 4 | No pagination on bulk weight/membership reads — Koios 1000-row cap truncates silently | done ae226bc — offset-paginating `postAll` for both account reads, runaway guard |

## Medium

| # | Finding (short) | Status |
| --- | --- | --- |
| 5 | Weight-fetch resume cursor only resumes between roles, not within one; snapshot scan has no resume | done 03d9a03 — `fillWeights` now persists per chunk (per-credential DReps, per-50 stakeholders). NOTE: the related `fetchAll`-has-no-resume sub-point is *not* addressed (larger scan-cursor change) — left for a follow-up |
| 6 | cip179: no byte-length checks on hashes/tx ids (`HASH28_BYTES`/`HASH32_BYTES` unused) | done 53ff9f9 — enforce 28/32-byte hashes and `uint .size 2` index at decode |
| 7 | cip179: points decoded via unchecked `Number()`, budget validated with float sum | done 53ff9f9 — points via checked `safeNumber`; budget summed with BigInt |
| 8 | cip179: option/scale labels encoded without the 64-byte bound | done 53ff9f9 — `boundedLabel` (≤64 UTF-8 bytes) in encode + `checkLabels` in validateDefinition |
| 9 | ProposeInfoAction reads list resource unguarded → crashes to error screen | done 1598ec9 |
| 10 | Wallet-connect failures silently swallowed by header menu | done f41167c |
| 11 | Survey screen state leaks across surveys (component not keyed on `:key`) | done cabbe81 |
| 12 | Test-suite gaps: finalize pending-verdict behavior, koios pagination, verifier dedup-tie/mech-B, cip179 roundtrips, create/respond untested | done 3451f80 — substantially addressed: finalize pending-verdict/postpone, missing-record, incomplete-snapshot, same-epoch credential-union; koios incomplete-on-batch-failure + scan pagination + cross-page dedup; verifier same-slot dedup-tie; cip179 decode/validate bounds (findings 6-8,13,24); tlock label/count scales. DEFERRED: verifier mechanism-B + Keyholder tests, create.ts/respond.ts builder tests, full cip179 per-type roundtrips |
| 13 | cip179: empty answer arrays accepted against CDDL `[+ …]` | done 53ff9f9 — reject empty public answer array and empty points/rating pair lists at decode |
| 14 | `addOptimisticSurvey` silently no-ops when list isn't loaded | done fa78542 |

## Low

| # | Finding (short) | Status |
| --- | --- | --- |
| 15 | Dead code cluster: `domain/cancellation.ts` shim, `decodeCancellationProof` alias (+ alias test), dead `metadatum.ts` helpers; mixed shim/direct core imports | done f5a3f75 — deleted the three dead items; broader shim-vs-direct-import migration deferred |
| 16 | `mechanismA` duplicates `cancellationVerified` | done f8ecb70 |
| 17 | Can't-happen `?? {slot: 0, epochNo: 0}` fallback in `fetchAll` — throw instead | done 681fc09 |
| 18 | Presentation floats/types (`Bar.pct`, sample cap) inside `@tessera/core` tally.ts vs §4 claim | done 5dff8e2 — doc-scoped (§4 clarified; tally.ts marked display-only). Kept display tally in core; not moved app-side |
| 19 | Post-close cancellations invisible outside the artifact (list shows "Ended", raw tally in direct mode) | won't-fix now — a correct fix needs the backend list payload to expose finalized-cancelled status. The frontend snapshot carries proof:null for closed-survey cancellations (the koios scan only verifies OPEN ones, by design), so cancellationStates cannot verify them locally, and marking a closed survey 'claimed' from an unverified cancellation would mislabel it. Aligning correctly = backend surveyList change + core aggregate; deferred as a follow-up rather than ship a speculative status change |
| 20 | Dead artifact error guard in Survey.tsx (fetcher `.catch(() => null)` makes it unreachable) | done cabbe81 |
| 21 | Numeric slider precision above 2^53 (`sliderOk` doesn't bound min/max) | done 45222db |
| 22 | Delete stale `frontend/app/review-progress.md` / `review-report.md` | done cfde1b3 |
| 23 | Doc drift ×3: Settings Pro-toggle persistence claim, "poll Koios" comments, hardcoded English role descriptions | done 73107a4 |
| 24 | cip179: `[0]` public submission mode accepts trailing elements | done 53ff9f9 — `expectLen(arr,1,1)` on public submission mode |
| 25 | tlock padding tests never exercise labels/count scales or count-form options | done 5173e3b |
