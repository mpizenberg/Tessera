# Tessera — full code review

**Reviewed:** branch `review`, commit `1d097091f4b679f47ecffd2fe3f2811b93455e26` (working tree), on 2026-07-04.
**Scope:** all six workspace packages, migrations, configs, and the docs (`frontend/cip-179.md` as normative spec; `backend/ARCHITECTURE.md`, `backend/GOAL.md`, `backend/RESEARCH.md`, package READMEs as design intent). `backend/deps/*`, `node_modules`, and lockfile contents were excluded per the review brief.
**Revision note:** originally this review reported the governance-link anchor format as a High spec-conformance break (code used `body.cip179` + `kind: "survey-link"`; the CIP text specified a flat top-level `kind: "cardano-governance-survey-link"` document). The pending spec change in `cip-179-info-action-linkage-changes.md` resolves that divergence spec-side, adopting the code's shape. The report has been updated: the interop finding is withdrawn, the code was re-checked against the *new* linkage text, and the residual author-side gap it leaves is now finding 7.

## Overall assessment

This is an unusually disciplined codebase for its size. The layering the architecture doc promises is actually present in the code: a pure, dependency-free codec (`cip-179`), a pure domain core (`@tessera/core`) with exact BigInt arithmetic on every hash-relevant path, impure adapters (`@tessera/koios`, the backend stores) kept behind narrow seams, and floats confined to presentation. Comments consistently explain *why* (including rejected alternatives), tests are behavior-focused and often encode past regressions, and the emitter/verifier symmetry (dedup ordering, membership-after-dedup equivalence, mechanism A/B proof rules, cancellation tie-breaking) checks out rule by rule against both the spec and `ARCHITECTURE.md`. The governance-linkage implementation, which initially read as a spec violation, turns out to be ahead of the spec: the pending linkage-change proposal codifies the code's `body.cip179` embedding, and the reader side already satisfies every rule in the new text (discovery via `body.cip179.kind`, case-insensitive tx id, reject-never-default on a malformed index).

The risk concentrates in two places plus a cluster of edge cases. First, the verifier's trust story is weaker than its own output and the READMEs claim: the response set and answer contents come from the very backend under verification, so omission or alteration of responses produces a confident `MATCH`. Second, a small cluster of state-machine edge cases (sealed-reveal dedup ordering, rollback of an already-validated response, unknown-survey responses re-fetched forever) where the code's own stated invariants are violated in paths that only manifest under adversarial or unlucky chain conditions. Nothing found corrupts data at rest; the codec itself appears fully conformant to the CDDL.

## Coverage

Read fully: the CIP-179 spec, the linkage-change proposal (`cip-179-info-action-linkage-changes.md`), and all backend design docs; every source and test file in `frontend/cip179`, `packages/core`, `packages/koios`, `packages/verifier`, and `backend/server` (including all five migrations and both store implementations); in `frontend/app`: config, state, data, domain, enrichment, tlock, wallet, util layers and their tests, plus `Survey.tsx`, `Respond.tsx`, `Create.tsx`, `Explore.tsx`, `ProposeInfoAction.tsx`, `Settings.tsx`, `App.tsx`, `main.tsx`, and the substantive components (`OnchainPreview`, `SubmitProgress`, `LoadError`, `TxLink`, `ResultBarCard`, `Note`, `Feedback`, `SegmentedToggle`); all `package.json`/tsconfig/vite/vitest/wrangler configs, `pnpm-workspace.yaml`, and the CI workflow.

Batched/skimmed: `Header.tsx` (first 120 lines read fully; the wallet-menu remainder inspected via targeted search for network/submit logic), `frontend/app/src/tlock/padding.test.ts` (module read fully, test file skimmed), the i18n catalogs (structure and key usage checked; string content not proofread), CSS modules and `glyphs`/`BottomNav`/`Spinner` (presentational only). Nothing in scope was left unassessed for correctness-relevant logic.

## High

### 1. The verifier trusts the backend for the response set and answer contents, so a lying backend still gets `MATCH`

**Where:** `packages/verifier/src/cli.ts:75-97` (bundle fetched from the backend; only proofs/block-indices/weights/links from Koios), `packages/verifier/src/verify.ts:4-12` (trust-model docstring), `README.md:21`, `backend/server/README.md` ("re-derive any artifact from chain data alone").

The CLI fetches the survey bundle — the definition, the response *set*, and every response's *answer contents* — from the backend whose artifact it is verifying. It then re-fetches each response tx's CBOR from Koios, but `decodeTxProof` extracts only `required_signers`, native scripts, and vote bindings — never the label-17 payload. So a malicious or corrupted backend can (a) omit responses from the bundle, or (b) alter a response's answers in the bundle, recompute its artifact over the same doctored data, and the verifier rebuilds the identical tally and prints "MATCH — the artifact reproduces from chain data". What the verifier actually proves is that weights, membership, credential proofs, deadlines, dedup, and arithmetic are consistent with chain data *given the backend's record set* — materially weaker than what its output string, its docstring, and both READMEs claim. Since re-verifiability is the project's central trust claim, this is a high-impact gap.

**Suggested fix:** The tx CBOR is already fetched — decode the label-17 payload from it and use those answers (rejecting bundle rows that don't match), and cross-check bundle membership against an independent Koios label-17 scan filtered to the survey ref (the machinery exists in `KoiosDataSource.fetchAll`). Until then, soften the MATCH message and README claims to state the actual trust basis.

## Medium

### 2. Sealed-survey reveal dedups before reveal-time validation, so an invalid later response permanently suppresses an earlier valid one

**Where:** `frontend/app/src/ui/screens/Survey.tsx:1715-1743` (`SealedResults` reveals `props.records` = `audit().counted`), `packages/core/src/audit.ts:93-118`, `backend/ARCHITECTURE.md` §6.3.

For public surveys the code is scrupulous that dedup runs over the *valid* set ("an invalid later response never suppresses a valid earlier one" — enforced in `auditResponses` and tested). For sealed surveys that ordering inverts: `auditResponses` can only check a sealed response structurally (mode + non-empty ciphertext), so latest-wins dedup runs *before* anyone knows whether the latest ciphertext is garbage. The reveal pipeline then decrypts only the deduped `counted` set. If a responder's later sealed submission turns out undecryptable (wrong round, corrupted ciphertext) or decodes to constraint-violating answers, their earlier valid sealed response has already been discarded as `superseded` and is never revealed or counted — the responder is silently disenfranchised by their own failed resubmission. `ARCHITECTURE.md` §6.3 specifies the correct order for sealed surveys: decrypt, re-validate, *then* the counted set is final. The deferred backend sealed-artifact path (`TODO(sealed-artifact)`) will need the same ordering.

**Suggested fix:** In `SealedResults`, reveal all in-window sealed responses (including currently-superseded ones), validate the decrypted answers, and only then apply latest-valid-wins dedup — e.g. run `dedupeResponses` after the reveal maps each record to its public form or an invalid/failed marker.

### 3. A validated-then-rolled-back response postpones its survey's finalization forever

**Where:** `backend/server/src/finalize.ts:113-116` and `174-185` (the `presentResponses`/`absent` postpone), `backend/server/src/validate.ts` (rows are never deleted), `backend/server/src/finalize.test.ts:576-602` (pins the postpone behavior).

`validated_response` rows are written incrementally as responses land and are never pruned. At emit time, any *counted* row whose `(txHash, responseIndex)` is missing from the current snapshot postpones the survey ("response … missing from snapshot"). The incomplete-snapshot case is already handled separately (finalization skips entirely), so when this branch is reached the snapshot is complete — meaning the tx genuinely isn't on-chain anymore. That happens when a response is validated by one refresh (crons run every ~3 min) and then dropped by a shallow reorg without being re-included. The stale row then postpones the survey on *every* subsequent refresh, permanently: the snapshot will never contain the tx again (the `SINCE` floor is fixed, so nothing "ages back in"), and no code path removes the row. The survey's artifact is never emitted, and only manual database surgery unblocks it. The postpone was designed as a safety measure against transient snapshot gaps, but combined with never-pruned validation rows it becomes a livelock.

**Suggested fix:** Treat snapshot membership as authoritative (as the tx-metadata cache already does): when the snapshot is complete, delete — or exclude from the counted set — validated rows whose tx is absent, instead of postponing. Optionally require absence across N consecutive complete refreshes before pruning, to keep a reorg buffer.

### 4. Responses referencing unknown surveys are re-fetched from Koios on every refresh, forever

**Where:** `backend/server/src/validate.ts:76-99` (candidates filtered before the `defByKey` check; `txHashes` built from all candidates; rows only pushed when `def` exists), confirmed by `validate.test.ts:171-188`.

A response whose `survey_ref` doesn't resolve within the snapshot gets no `validated_response` row ("skipped entirely"). But the candidate filter (`!completed.has(key)`) runs before the definition lookup, and `txHashes` for the `/tx_cbor` + `/tx_info` enrichment is built from *all* candidates — so every such response costs its share of two Koios batch calls on every refresh, forever (the fixed `SINCE` floor means it never leaves the scan). This defeats the stated "steady state adds zero subrequests" goal and is a cheap griefing vector: one transaction fee buys label-17 responses to a nonexistent survey ref that tax every future cron against the Worker's per-invocation subrequest cap — the very cost model `koios.ts` explicitly defends against for cancellation proofs. Legitimate responses to surveys older than `SINCE` trigger the same leak.

**Suggested fix:** Resolve the definition before building the fetch set (drop unknown-survey candidates from `txHashes`), or persist a cheap tombstone row for unknown-survey responses so `completedValidations` skips them; re-evaluate tombstones only if their survey later appears.

### 5. CI never runs the tests or type-checks of `packages/core`, `packages/koios`, `packages/verifier`, or the backend; stale per-package lockfiles linger

**Where:** `.github/workflows/ci.yml` (two jobs: `frontend/cip179`, `frontend/app`), `README.md:119-121` ("Keep the build green: `pnpm -r type-check`, `pnpm -r test` … CI runs these on every PR"), `frontend/app/pnpm-lock.yaml`, `frontend/cip179/pnpm-lock.yaml` vs the root `pnpm-lock.yaml`.

The CI workflow predates the workspace refactor: it runs install/type-check/test/build only inside `frontend/cip179` and `frontend/app`. The packages carrying the most correctness-critical, hash-committed logic — `@tessera/core` (tally, dedup, canonicalization, artifact hashing), `@tessera/koios` (proof decoding, weight inputs), `@tessera/verifier`, and `@tessera/backend` (validation, finalization, stores, migrations) — have substantial test suites that never execute on a PR, so a regression in e.g. `dedupe.ts` or `finalize.ts` merges silently. The README's claim that CI runs the recursive commands is false. Relatedly, the two committed per-package lockfiles are dead weight in a workspace with a shared root lockfile (installs resolve from the root one); they drift from their `package.json`s and are used only as `setup-node` cache keys, silently staling the cache.

**Suggested fix:** Replace the two jobs with one workspace job at the repo root (`pnpm install --frozen-lockfile`, `pnpm -r type-check`, `pnpm -r test`, plus the app's `format:check` and builds), keyed on the root lockfile; delete the nested lockfiles.

## Low

### 6. Direct-Koios mode tallies cancelled-then-closed surveys, contrary to the spec's MUST

**Where:** `packages/koios/src/koios.ts:393-407` (owner-proofs fetched only for open surveys), `packages/core/src/survey.ts:120-140` (`cancellationStates` ignores closed surveys), `frontend/app/src/ui/screens/Survey.tsx` (raw tally rendered for "ended" surveys).

CIP-179: "A cancelled survey is inactive as a whole: tooling MUST NOT tally any of its responses." In backend-served mode the `finalizedCancelled` overlay carries a verified cancellation past close. In direct-Koios mode (a supported, documented path) the scan deliberately never verifies cancellations of closed surveys, so a survey cancelled in-window and then closed displays as plain "Ended" with a full raw tally — even the "claimed cancellation" warning disappears. The anti-griefing rationale in the code (unbounded permanent `/tx_cbor` cost) is sound and explicitly argued, but the result is a conformance gap in one mode.

**Suggested fix:** In direct mode, verify closed-survey cancellations lazily on the survey detail page only (one bounded fetch per viewed survey, not per scan), or at minimum keep the "cancellation claimed" warning visible for closed surveys instead of dropping it.

### 7. Authoring doesn't enforce the new linkage rule that `@context` MUST map the CIP-179 terms

**Where:** `frontend/app/src/ui/screens/ProposeInfoAction.tsx:77-89` (`validateAnchorShape` checks only that *an* `@context` object exists), `frontend/app/src/ui/screens/Survey.tsx:429-480` (`LinkActionPanel` copy-paste helper), against `cip-179-info-action-linkage-changes.md` Change 3.

The pending spec change adopts the code's `body.cip179` + `kind: "survey-link"` shape (the reader side — `parseCip179Link`, `parseGovLink` — already conforms to every rule in the new text, including case-insensitive `surveyTxId` and rejecting a malformed `surveyIndex` rather than defaulting to 0). But Change 3 adds a MUST the authoring side doesn't check: the anchor's `@context` must define the `CIP179` namespace and map the `cip179` term *and every sub-field* inside the body context, because CIP-108 sets no `@vocab` and unmapped fields are dropped during JSON-LD canonicalization — leaving the link readable in raw JSON yet outside the author witness, "an inconsistency a linking author MUST avoid". Tessera's propose page accepts any document with a generic CIP-108 `@context` (no `cip179` term), so it happily commits anchors that violate the new MUST; and the `LinkActionPanel` helper hands the user only the `cip179` object, telling them to "see CIP-179 for the matching `@context` terms" without providing them — the exact mistake the rule anticipates. Tamper-evidence is still preserved by the on-chain anchor hash over the raw bytes, which bounds the impact, but JSON-LD-processing tools and author-witness verifiers will not see the link.

**Suggested fix:** In `validateAnchorShape`, when `body.cip179` is present, verify the `@context` maps `cip179` (with its four sub-terms) inside the body context and flag the omission as a blocking problem; extend `LinkActionPanel` to offer the ready-made `@context` snippet from the spec's worked example alongside the `cip179` object.

### 8. The cancel-survey flow lacks the wallet-network gate every other submit flow has

**Where:** `frontend/app/src/ui/screens/Survey.tsx:335-416` (`OwnerControls.onCancel`); compare `Create.tsx:223`, `Respond.tsx:115`, `ProposeInfoAction.tsx:245`.

Create, Respond, and Propose all block submission when `networkMismatch(...)` is true; the header shows a warning but doesn't gate anything. `OwnerControls` submits a cancellation with no such check, so a wallet connected to the wrong network signs and broadcasts a cancellation tx to *its* network — a paid no-op there (the ref matches nothing), while the user believes they cancelled their survey; the real survey stays open. The shared-helper comment in `format.ts` ("Shared by every submit gate … so they can't drift apart") is contradicted by this one call site.

**Suggested fix:** Disable the cancel button (with the same "switch network" note) when `networkMismatch(app.wallet()?.identity.networkId, app.config.network)` is true.

### 9. Koios JSON metadata adapter silently corrupts integers above 2⁵³ and misreads `"0x"`-prefixed text — a cross-implementation hash risk

**Where:** `packages/koios/src/metadatum.ts:64-75` (`BigInt(Math.trunc(json))`, `stringToMetadatum`); consumed by everything downstream of `fetchAll`.

Koios serves tx metadata as JSON, so an on-chain numeric-range or rating answer whose value exceeds 2⁵³ arrives as an already-lossy double and is silently converted to a wrong bigint (not rejected — unlike every other unsafe-integer path in the codebase, which fails loudly), and a text value that genuinely starts with `"0x"` is indistinguishable from bytes. The file header documents both caveats honestly. The sharp edge is that these values flow into the *hashed* artifact: Tessera's emitter and verifier agree (same adapter), but a CBOR-native implementation of the same ruleset would compute a different counted set or aggregate and fail to reproduce the hash — undermining the cross-tool test-vector goal. An adversary can trigger this deliberately with a crafted in-constraint answer (e.g. a numeric question with bounds beyond 2⁵³).

**Suggested fix:** Reject (treat as malformed, like a decode error) any metadata number that is not a safe integer instead of truncating; longer-term, prefer a raw-CBOR metadata source (`/tx_cbor` is already fetched for proofs) for hash-relevant paths.

### 10. The Respond UI cannot express a partial rating answer, though the spec allows one

**Where:** `frontend/app/src/domain/respond.ts:114-118` (`decided` requires every option rated), `prefillDrafts` + `RatingBody`.

CIP-179: "A respondent MAY rate a subset of options." `decided()` returns true for a rating question only when *all* options carry a rating, so the submit gate forces rate-everything-or-skip. Tessera thus can't author a spec-valid partial rating, and — worse for the edit flow — pre-filling from a prior partial rating (submitted via another tool) yields an un-submittable draft until the user rates the remaining options or abandons their partial answer. Tally and validation handle subsets correctly; only the input gate is over-strict.

**Suggested fix:** Treat a rating draft as decided when at least one option is rated (all entered ratings valid), matching the codec's `[+ [uint, int]]` lower bound.

### 11. The pinned "ruleset" hash doesn't actually pin the validator code, so a semantic change can silently break emitter/verifier agreement

**Where:** `packages/core/src/artifact.ts:26-52` (`RULESET_DESCRIPTOR`, "The pinned validator version is part of the ruleset" per `ARCHITECTURE.md` §6.3), `backend/server/src/finalize.ts` (uses `well_formed` verdicts persisted at validation time), `packages/verifier/src/verify.ts:122` (re-runs the *current* `validateResponse`).

`rulesetHash()` commits to a prose description and a `rulesetVersion` integer, not to the behavior of `validateResponse`/`dedupeResponses`. The emitter freezes `wellFormed` verdicts at validation time; the verifier re-derives them with whatever validator ships when it runs. Any semantic change to `cip179`'s validation (or core dedup ordering) that lands without a manual `rulesetVersion` bump makes historical artifacts unreproducible — and the mismatch will present as tampering rather than as a version skew. This is a process hazard rather than a present bug; nothing enforces the discipline the design depends on.

**Suggested fix:** Add a test that pins `rulesetHash()` to a literal expected value (forcing a conscious bump on any descriptor change), and a comment in `cip179/src/validate.ts` + `core/src/dedupe.ts` stating that semantic changes require a `rulesetVersion` bump; consider folding a validator version constant into the descriptor.

### 12. Stale doc references: `GOAL.md`/`RESEARCH.md` point at a nonexistent spec path

**Where:** `backend/GOAL.md:1`, `backend/RESEARCH.md:17` (`../minimal/cip-179.md`).

Both docs reference `../minimal/cip-179.md`; the spec lives at `frontend/cip-179.md`. Anyone following the pointer from the backend docs (which `ARCHITECTURE.md` presents as the design record) hits a dead path.

**Suggested fix:** Update both references to `../frontend/cip-179.md`.
