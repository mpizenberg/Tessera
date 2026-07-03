# Tessera code review — findings

> **Context.** Full read-only code review of the Tessera repository, performed 2026-07-03 on branch `backend-cf` (HEAD `7342e92`). Tessera is a pnpm monorepo implementing CIP-179 on-chain surveys on Cardano:
>
> - `packages/core` — pure domain: counting rules, weighted tally, canonical JSON + blake2b-256 content-addressed tally artifacts (BigInt-only, no I/O)
> - `packages/koios` — Koios API client: chain scanning, tx proofs, weights, bech32
> - `packages/verifier` — standalone CLI that rebuilds a tally from chain data and compares content hashes against the backend's artifact
> - `backend/server` — snapshot/tally backend, running both as a Node loop and a Cloudflare Worker (cron), with two store implementations (`store-node.ts` inline SQLite schema, `store-d1.ts` + `migrations/0001–0003`)
> - `frontend/app` — SolidJS app; `frontend/cip179` — the CIP-179 codec package
>
> `backend/ARCHITECTURE.md` is the design's source of truth; section references (§6.3, §6.5, §7…) below point into it. The review covered all production code and tests, prioritizing: (1) robustness bugs under honest inputs (esp. the refresh/finalize cron paths, retry/resume semantics, partial failures), (2) module boundaries / duplication / dead code, (3) useless defensiveness, (4) test-suite quality, (5) doc drift. Adversarial/security analysis and style were explicitly out of scope. Every finding was verified against the actual source before inclusion.
>
> Severity legend: **high** = wrong behavior or data loss possible; **medium** = will bite during maintenance or ops; **low** = dead weight worth deleting. `file:line` references are relative to the repo root at the commit above and may drift as fixes land — treat the symbol names as the stable anchor.
>
> **Remediation tracking.** Keep this report immutable as the reference; track fixes in a sibling `review-progress.md` instead — one entry per finding number with its status (todo / in progress / done / won't-fix + rationale) and the fixing commit hash. A fresh session should read this report for the *what* and `review-progress.md` for the *current state*, and pick up the first unresolved finding. (Finding 22 — deleting the stale `frontend/app/review-*.md` files — is already done.)

## High — wrong artifacts or permanent data loss possible

**1. Finalization emits immutable artifacts while proof verdicts are still pending, permanently dropping valid responses — `backend/server/src/finalize.ts:266-274`**
`countedRows` excludes any row with `proofOk === null` ("excluded this round"), but `incompleteReason` (finalize.ts:370) only checks weights and totals — it never postpones for pending verdicts. If a `/tx_cbor` batch failed during validation (retried "next refresh" per validate.ts), and finalization succeeds on that same refresh, the artifact is written via INSERT-OR-IGNORE and the later retry is moot: a legitimately valid response is omitted from the immutable, hash-committed result forever, and the standalone verifier (which re-fetches the proof successfully) reports MISMATCH with no remedy. The same applies to `blockIndex === null`: `laterInChain` uses the `-1` sentinel while the verifier uses the real block index, so a same-slot dedup tie can resolve differently. Note `finalize.test.ts:373` ("verdict pending → excluded") bakes this behavior in as correct. Fix: treat any counted-candidate row with `proofOk === null` (and `blockIndex === null`) as an incompleteness reason and postpone emission, exactly like a missing weight row.

**2. Mechanism-B proof verdicts are pinned to whatever governance links were known at first validation — `backend/server/src/validate.ts:83-89`, `backend/server/src/refresh.ts:29-34`**
`proofOk` is computed once against `linkByKey` from that refresh's `govLinks` and the row is then "complete" (`completedValidationKeys` requires only non-null), never re-checked. But `refresh.ts` swallows a gov-links fetch failure into `[]`, and Koios resolves an action's `meta_json` anchor lazily — so a response whose only proof is its vote binding gets `proofOk = false` permanently, and conversely a response with a *present-but-failing* binding wrongly falls back to mechanism A and can get `proofOk = true`. The verifier re-derives links at verify time, so either direction produces a permanent hash MISMATCH. Fix: skip persisting `proofOk` for responses to linked-or-possibly-linked surveys when the gov-links fetch failed; more robustly, store the `linkedActionId` used and re-validate rows when the link set for their survey changes.

**3. A failed `tx_metadata` batch silently shrinks the snapshot, and finalization runs on it anyway — `packages/koios/src/koios.ts:291-302` + `backend/server/src/finalize.ts:421-422`**
`fetchAll` drops failed metadata batches with only a `console.warn` and does *not* set `incomplete` (only the MAX_PAGES cap does). If that refresh's finalize step runs, `buildArtifact` hits `if (!weight || !record) continue` for validated rows whose response tx fell out of this snapshot — the comment "guarded by incompleteReason" is false for the `!record` half — and emits an immutable artifact missing those responders. Worse, a dropped cancellation tx makes `withCancellations` finalize a cancelled survey as a normal tally. Fix: make a missing `record` an incompleteness reason (postpone), and/or flag the snapshot `incomplete` on any batch failure and skip finalization for incomplete snapshots.

**4. No pagination on the bulk weight/membership reads — Koios's 1000-row response cap silently truncates — `packages/koios/src/tallyInputs.ts:110-123`**
`account_update_history?epoch_no=lte.E` returns *every* lifecycle event (registrations, delegations, withdrawals…) for 50 accounts in one un-paged POST. Koios caps responses at 1000 rows (koios.ts:56 relies on this very cap for the label scan); long-lived accounts with years of withdrawals can push a batch past it, and truncation drops arbitrary rows — e.g. a final deregistration — so registration state and hence membership/weight in the hashed artifact can be wrong under fully honest inputs, and non-reproducibly so. Fix: offset-paginate both POSTs until a short page (or filter `action_type` server-side and shrink the batch).

## Medium — will bite in ops or maintenance

**5. The "resume cursor" only resumes between roles, not within one — `backend/server/src/finalize.ts:294-341`, `packages/koios/src/tallyInputs.ts:93-180`**
`fillWeights` upserts only after the *entire* role's fetch succeeds; `stakeholderWeights`/`drepWeights` are all-or-nothing across their internal batches (DReps are one sequential GET per credential). A role whose fetch reliably dies mid-way (rate limit, Worker subrequest cap) re-fetches from zero every cron and never converges — ARCHITECTURE §6.5's "a run cut short just resumes next cron" overstates the granularity. Relatedly, the snapshot scan itself has no resume at all: if `fetchAll` alone ever exceeds the Worker subrequest budget, every cron fails identically and the snapshot never refreshes again. Fix: persist weight rows per batch/credential as they arrive (pass the store in, or return partial results plus an error).

**6. cip179: no byte-length checks on hashes/tx ids — `frontend/cip179/src/decode.ts:118-150`**
`decodeCredential`/`decodeSurveyRef` accept any byte length; `HASH28_BYTES`/`HASH32_BYTES` in constants.ts are used nowhere. A response with a 20-byte credential hash decodes and validates clean, then enters dedup/tally/artifacts keyed on a credential that can't exist on chain (and `stakeAddress` happily bech32-encodes it). Fix: enforce 28/32-byte lengths at decode using the existing constants; bound `surveyRef.index`.

**7. cip179: points allocations decode via unchecked `Number()` and validate with float summation — `frontend/cip179/src/decode.ts:411`, `frontend/cip179/src/validate.ts:287`**
Every other structural integer goes through the safe-integer-checked `asNumber`; points get raw `Number(bigint)` and the budget check sums with float `+`. Values ≥ 2^53 lose precision silently instead of failing decode, so the persisted, hash-relevant `wellFormed` verdict can disagree with an exact-arithmetic implementation. Fix: decode points through the checked path (or keep bigint and compare against `BigInt(budget)`).

**8. cip179: option/scale labels are encoded without the 64-byte bound — `frontend/cip179/src/encode.ts:74,84`**
Labels are `bounded_text` (≤64 UTF-8 bytes, non-chunkable) per the spec, but neither encode nor `validateDefinition` checks, so a long label surfaces later as an unrelated-looking CBOR/serializer failure at tx-build time (or as invalid on-chain metadata). Fix: throw `Cip179EncodeError` on over-long labels and mirror the check in `validateDefinition`.

**9. ProposeInfoAction reads the list resource unguarded and crashes to the error screen — `frontend/app/src/ui/screens/ProposeInfoAction.tsx:108,126`**
Solid resources throw on data reads in error state; every other screen guards with `app.list.error ? undefined : app.list()`. A transient backend failure replaces the whole propose page (with the user's loaded document) with the LoadError fallback, though the list only feeds an advisory alignment note. Fix: same guarded read as Survey.tsx:88.

**10. Wallet-connect failures are silently swallowed — `frontend/app/src/ui/components/Header.tsx:218-221`**
`app.connect()` never rejects (state.tsx:411 stores the error in `connectError`), so `.then(() => setMenuOpen(false))` closes the menu on failure too — and `connectError` renders only inside the now-closed menu. The user gets zero feedback. Fix: close only when `app.wallet()` is set.

**11. Survey screen state leaks across surveys (not keyed on `:key`) — `frontend/app/src/ui/screens/Survey.tsx:126,1467,1667`**
solid-router reuses the component instance when only the route param changes (reachable via the header's pending-tx "View survey" link). `showRaw`, `pickedRole`, `exclOpen`, and notably `revealRequested` persist — after revealing sealed survey A, navigating to sealed survey B starts B's beacon fetch and decryption without a click. Fix: reset these signals in `createEffect(on(key, …))` or key the subtree on `key()`.

**12. Test-suite gaps on exactly the tricky paths** —
- `backend/server/src/finalize.test.ts` asserts the finding-1 bug as intended behavior; nothing tests multi-survey/same-epoch credential-union fetching (the §6.5 headline efficiency rule), missing-record emission, or incomplete snapshots.
- `packages/koios/src/koios.test.ts:166` is the only `fetchAll` test — pagination, the MAX_PAGES→`incomplete` flag, and cross-page dedup are untested.
- `packages/verifier/src/verify.test.ts` never exercises a same-slot dedup tie (blockIndex ordering), mechanism B, or the Keyholder role.
- `frontend/cip179/test/roundtrip.test.ts` never round-trips custom/numericRange/rating questions, any of the three rating scales, or most answer kinds; validate rules (duplicate indices, budget sum, ranking bounds) are individually untested.
- `frontend/app/src/domain/create.ts` and `respond.ts` — the write-path payload builders whose headers advertise "unit-testable in isolation" — have zero tests.

**13. cip179: empty answer arrays accepted against CDDL — `frontend/cip179/src/decode.ts:439-447`, `validate.ts:293-309`**
`response_answers` and rating/points pair lists are `[+ …]` (non-empty) in the spec, but `[]` decodes and validates clean, so `wellFormed = true` is persisted for responses a strictly conformant implementation rejects — a cross-implementation verdict divergence in a hashed input. Fix: reject empty arrays at decode.

**14. `addOptimisticSurvey` silently no-ops when the list isn't loaded — `frontend/app/src/state.tsx:320-322`**
Publish while the list resource is loading/errored and the optimistic record is dropped: Create's "View survey" lands on "Survey not found" and Explore omits the survey until the next backend refresh, despite the success receipt. Fix: queue until `list()` resolves or synthesize from a fallback tip.

## Low — dead weight and doc drift worth deleting/fixing

**15. Dead code cluster** — `frontend/app/src/domain/cancellation.ts` (re-export shim, zero importers); `decodeCancellationProof` alias in `packages/koios/src/txProof.ts:233` (zero callers; its only test, txProof.test.ts:51, asserts the alias identity — a pure implementation-detail test); `frontend/cip179/src/metadatum.ts:183-222` helpers (`toSafeNumber`, `expectList`, etc. — zero callers, duplicating decode.ts's path-aware checks). Delete all three. Also note the shims now coexist with direct `@tessera/core` imports (Survey.tsx, submit.ts, config.ts import core directly while other files use `~/domain/*`) — worth migrating and deleting the remaining shims before the two vocabularies drift.

**16. `mechanismA` duplicates `cancellationVerified` — `packages/core/src/proof.ts:72-80` vs `cancellation.ts:60-72`**
Byte-for-byte the same evaluation over the same evidence shape (the comment even says so). Have `mechanismA` call `cancellationVerified(credential, proof)`.

**17. Can't-happen fallback that would silently corrupt classification — `packages/koios/src/koios.ts:307`**
`posByHash.get(row.tx_hash) ?? { slot: 0, epochNo: 0 }` — no caller can trigger it (metadata batches are built from `posByHash` keys), and if it ever fired, `epochNo: 0` makes any response "on-time" and `slot: 0` loses every dedup, silently. Throw instead.

**18. Presentation concerns inside the "pure BigInt-ready" core — `packages/core/src/tally.ts:29-99`**
`Bar.pct` fill fractions, float means/medians, a 6-sample cap, and "Option N" fallback labels are UI decisions living in `@tessera/core`, which ARCHITECTURE §4 describes as "ratios returned as integer pairs, never floats". Not a correctness issue (this tally is never hashed), but either the doc should scope that claim to the weighted path or the display tally belongs app-side.

**19. Post-close cancellations invisible outside the artifact — `packages/core/src/survey.ts:127`**
`cancellationStates` deliberately ignores cancellations of closed surveys, so Explore shows a cancelled-then-closed survey as "Ended", and the direct-Koios path (no artifact) shows its raw tally — while the backend finalizes the same survey as *cancelled* with no per-role tally. The detail page corrects this only when an artifact is served. Worth aligning the list status with the finalize ruleset.

**20. Dead artifact error guard — `frontend/app/src/ui/screens/Survey.tsx:120-123`**
The fetcher ends in `.catch(() => null)`, so `artifactRes.error` is unreachable; the guard implies two error paths where one exists. Drop the `.catch` or the guard.

**21. Numeric slider precision above 2^53 — `frontend/app/src/ui/screens/Respond.tsx:1215,1246-1249`**
`sliderOk` checks only the span, then converts bigint bounds with `Number()`; huge-min/small-span constraints render rounded positions and can submit a value other than the one visually picked (still in-constraint). Require bounds within `MAX_SAFE_INTEGER` in `sliderOk`.

**22. Stale review artifacts — `frontend/app/review-progress.md`, `review-report.md`**
Document a fully-remediated prior review; line references no longer match the source (e.g. deleted `anchorHttpUrl`). Git history preserves them — delete.

**23. Doc drift, three spots** — `frontend/app/src/ui/screens/Settings.tsx:4-13` claims the Plain/Pro toggle is persisted to localStorage; `setPro` (state.tsx:464) never writes it (persist it or fix the comment). `frontend/app/src/state.tsx:113,275` says "poll Koios" where polling goes through the `DataSource` seam (the indexer in the default deployment). `frontend/app/src/ui/format.ts:106-117` hardcodes English role descriptions outside i18n while everything around them is translated.

**24. cip179: `[0]` public submission mode accepts trailing elements — `frontend/cip179/src/decode.ts:165-167`**
Sealed mode and answer items length-check; `Public` doesn't, so `[0, junk]` decodes clean where a strict decoder rejects. Add `expectLen(arr, 1, 1, path)`.

**25. tlock padding tests never exercise labels/count rating scales or count-form options — `frontend/app/src/tlock/padding.test.ts:117-127`**
The maximal-answer generator uses `0n` for non-numeric scales (the real max is `levels-1`), so a size-underestimate regression in those branches — a ciphertext size leak — would pass. Add fixtures for those shapes.

---

## Overall health

This is an unusually well-built codebase for its stage: the core/koios/backend/verifier layering matches ARCHITECTURE.md almost exactly, the invariants you asked about hold where I checked them — BigInt-only hashed aggregates, decimal-string weights on the wire, deterministic canonical JSON with responders sorted by credential and `perRole` by role, one shared `laterInChain` dedup ordering, a verifier that genuinely never touches `validated_response`/`weight_snapshot`, and store-node's inline schema is currently byte-equivalent to migrations 0001–0003 (the duplication is real but held in sync, and both sides carry "keep in sync" comments). The prose-comment culture is mostly an asset; only a handful of comments lie, and I've flagged each.

The fragile seam is exactly one place: **finalization's definition of "complete."** Every high finding is the same root cause wearing different clothes — emission is gated on weights and totals but not on proof verdicts, block indices, gov-link availability, or snapshot integrity, and because artifacts are immutable-by-design (INSERT-OR-IGNORE), any transient Koios hiccup that slips through that gate is frozen into a permanently unverifiable artifact. Tightening `incompleteReason` into a single strict "every input this artifact depends on is present and final" predicate (and making the weight fetches resumable at finer grain) would convert essentially all of the high-severity risk into the benign "postponed, retrying next cron" path the architecture already intends.