# Sealed surveys: server-emitted tally artifacts (full parity with public)

## Context

Sealed surveys (timelock-encrypted votes via drand/tlock) are fully built through voting and client-side reveal, but the entire after-close pipeline is missing: `finalize.ts:168-173` short-circuits with `TODO(sealed-artifact)`, so no tally artifact is ever emitted, the verifier hardcodes `sealed:false` (`verify.ts:92`), and the frontend never routes a sealed survey to `FinalResults` (weighted views, hash re-verification, exports). User decisions: **server-emitted artifacts** (backend decrypts after the drand round and emits; client reveal stays as the trust-minimized path), **full parity scope** (backend + verifier + frontend routing + vote-time chain guard + preview + tests), **non-quicknet sealed surveys are skipped forever** (logged, no artifact).

Portability is confirmed: `@mattpiz/tlock-js@0.10.0` is pure JS (noble 1.4.x + @stablelib/chacha20poly1305 + buffer polyfill), `decryptWithBeacon` is offline, `fetchBeacon` BLS-verifies the beacon; the Worker already has `nodejs_compat`.

## Key design decisions (settled — do not re-derive)

- **R1 — Weight freezing needs no change.** `countedRows` dedups per `${role}|${credential}` (finalize.ts:350-355); dedup only collapses rows sharing a credential, so the per-epoch credential union (finalize.ts:137-145) is identical pre- and post-dedup. Sealed weights frozen today are correct. Add a comment stating this invariant at the union site. The sealed *emit* path must still use the pre-dedup `eligible` rows (post-reveal dedup via `auditRevealedResponses` — the finding-2 discipline in `audit.ts:133-146`).
- **R2 — Sealed artifacts commit per-responder revealed answers.** `oneVoteRoleView` (artifactView.ts:221-248) and the CSV export rejoin answers from on-chain responses — ciphertexts for sealed → empty aggregates. Fix: `ArtifactResponder.answers?: unknown` = `toJsonSafe(revealed AnswerItem[])` (wire form, canonicalJson-safe), present iff sealed. Deterministic, small, verifier-recomputable. Excluded responses (undecryptable/invalid/superseded) are NOT committed — counted-only, like public.
- **R3 — Beacon goes in provenance (unhashed), not the tally.** The on-chain definition already pins `(chainHash, round)`; the beacon is fetchable + BLS-verifiable independently. `TallyArtifact.provenance.sealedReveal?: {chainHash, round, beacon:{round, randomness, signature}}` for offline audit.
- **R4 — `TallyBody.sealed` = "definition's submission mode is sealed"** everywhere, including cancellation artifacts (finalize.ts:275 currently emits `sealed:false` for sealed) and the verifier base. Hash-affecting → covered by the v3 bump.
- **R5 — CBOR seam moves.** `frontend/app/src/wallet/cbor.ts` uses only `TransactionMetadatum.toCBORBytes` / `CBOR.decodeItemWithOffset` / `CBOR.CANONICAL_OPTIONS` (verified). Move `toTxMetadatum`/`metadatumToCbor`/`cborToMetadatum` into `@tessera/tlock` (dep `@evolution-sdk/evolution ^0.5.9`, same as koios); `wallet/cbor.ts` becomes a re-export.
- **R6 — Analytic ciphertext size** `sealedCiphertextSize(plaintextLen, round)` in `@tessera/tlock`, pinned by a test asserting equality with real `encryptToRound` output lengths (so any envelope-math error fails tests, never ships).
- **R7 — DI seam for reveal**: `finalizeClosedSurveys` gains a trailing optional `reveal: SealedRevealFn = tlockSealedReveal`; tests inject a stub (no network/crypto).
- **New package, not core**: tlock-js pins noble 1.4.x while core uses 2.x — a separate `@tessera/tlock` avoids shipping two noble majors to every core consumer.

## Phase 1 — `packages/tlock` (`@tessera/tlock`)

Commit: `Extract the sealed-survey tlock stack into a shared package`

- Create `packages/tlock/{package.json,tsconfig.json}` mirroring `packages/koios` (type:module, source-first exports `"." → ./src/index.ts`, vitest, `tsc --noEmit`). Deps: `@mattpiz/tlock-js 0.10.0`, `@evolution-sdk/evolution ^0.5.9`, `cip-179 workspace:*`, `@tessera/core workspace:*`. Add `- packages/tlock` to `pnpm-workspace.yaml`.
- Move from `frontend/app/src/tlock/` and `wallet/cbor.ts`:
  - `src/drand.ts` — pure math only (`QUICKNET_CHAIN_HASH*`, `isQuicknet`, `roundForUnixTime`, `unixTimeForRound`, `roundIsAvailable`, `REVEAL_MARGIN_SECONDS`, `epochEndUnix`, `autoRevealRound`). The `Date`-formatting helpers stay in the frontend.
  - `src/client.ts` — verbatim (lazy `createTlock()`; dynamic import works in Node/Worker).
  - `src/cbor.ts` — the three functions from `wallet/cbor.ts`.
  - `src/seal.ts` — `sealAnswers` plus reveal split in two: new `revealWithBeacon(sealed, beacon)` (offline loop: decrypt → `cborToMetadatum` → `decodeAnswerItem` → `{type:"public"}`; failure → null) and `revealResponses(sealed, round)` = `fetchBeacon` + `revealWithBeacon`.
  - `src/padding.ts` — verbatim; `src/size.ts` — new `sealedCiphertextSize` (R6); `src/index.ts` exports all.
- Frontend: `src/tlock/{client,seal,padding}.ts` and `wallet/cbor.ts` become one-line re-exports; `tlock/drand.ts` re-exports math + keeps the three formatters. `frontend/app/package.json`: add `@tessera/tlock workspace:*`, drop direct `@mattpiz/tlock-js`.
- Tests: move `drand.test.ts`, `padding.test.ts`; add `seal.test.ts` (hermetic seal→reveal round-trip using a committed real quicknet beacon JSON fixture — beacons are immutable; document the fetch command in the fixture header; also: padding stripped, corrupted ciphertext → null) and `size.test.ts` (analytic size === real `encryptToRound(...).length` for several (len, round) pairs — offline).

## Phase 2 — Migrate stale sealed fixtures

Commit: `Migrate stale sealed submission-mode test fixtures to the codec shape`

- `packages/core/src/page.test.ts:49`: `{unsealSlot, scheme}` → real `{type:"sealed", chainHash: new Uint8Array(32), round: 1, paddingSize: 64}` (no tlock dep in core).
- `backend/server/src/finalize.test.ts:467`: `{drandRound:1} as never` → real shape with inline quicknet chainHash hex + far-future round (keeps the "weights frozen, no artifact" assertion green until Phase 4 turns it into the postpone test). Drop the cast. Sweep other backend tests for stale shapes.

## Phase 3 — Core: ruleset v3 + artifact schema

Commit: `Commit sealed reveal rules and revealed answers in the artifact (ruleset v3)`

`packages/core/src/artifact.ts`:
- `rulesetVersion: 3`; append three rules (wording may be polished, content fixed):
  1. *sealed-reveal*: decrypt every in-window, structurally-valid, credential-proven response with the definition-pinned round's BLS-verified beacon; decode plaintext as CBOR answers (trailing zero padding ignored); re-validate against the definition.
  2. *sealed-dedup*: latest-in-chain dedup runs only over responses whose decrypted answers validated; undecryptable/invalid responses are excluded and never supersede; exclusions are not committed.
  3. *sealed-artifact*: sealed tallies carry `sealed=true` (cancellations included); each counted responder commits its revealed answers in JSON-safe wire form; non-quicknet chains (hash `52db9ba7…c84e971`) are unsupported — no artifact.
- `ArtifactResponder.answers?: unknown` (present iff sealed); `toArtifactResponders(responders, opts?: {revealedAnswers?: boolean})`; decode helper `responderAnswers(r): AnswerItem[] | null` (via `fromJsonSafe`).
- `TallyArtifact.provenance.sealedReveal?` (R3). Update `TallyBody.sealed` doc.
- Update RULESET-PINNED-BEHAVIOR markers: add one to `audit.ts` (`auditRevealedResponses` is now ruleset-load-bearing); mention sealed rules in dedupe.ts/validate.ts markers.
- `artifact.test.ts`: update the golden hash **in this same commit** (run test, paste actual — per the pinned discipline at :59-67). New tests: responder-with-answers round-trips `canonicalJson` (incl. Map/bytes wire tags); `responderAnswers` inverse.

## Phase 4 — Backend: sealed finalize branch

Commit: `Emit tally artifacts for sealed surveys after the drand round`

- New `backend/server/src/sealedReveal.ts`: `SealedRevealFn` type + default `tlockSealedReveal` (lazy-import `@tessera/tlock`; `fetchBeacon(round)` once — BLS-verified; `revealWithBeacon`; returns `{revealed, beacon:{round,randomness,signature}}`).
- `finalize.ts`:
  - Signature: `finalizeClosedSurveys(..., reveal: SealedRevealFn = tlockSealedReveal)` — `refresh.ts` unchanged.
  - `withCancellations`: `sealed: s.definition.submissionMode.type === "sealed"` (R4).
  - After cancellations, partition out non-quicknet sealed surveys (warn each pass, exclude from `open` entirely — no weight work).
  - `countedRows` returns `{counted, eligible, pending}` (`eligible` = pre-dedup array at :347). Add the R1 invariant comment at the credential union.
  - Replace the sealed short-circuit (:168-173): postpone if `!roundIsAvailable(mode.round, nowSec)`; use `eligible` as the row set (same reorg-prune + `pending` postpone as public); pass-wide decrypt budget `MAX_SEALED_DECRYPTS_PER_PASS = 500` (oversized survey runs alone when budget untouched — always progresses; Worker CPU headroom); join rows to `ResponseRecord`s (`records.responses` by `txHash:responseIndex`, miss → postpone); `reveal(...)` in try/catch (throw → warn + continue, retry next refresh); `auditRevealedResponses(inWindowRecords, revealed, def)` → map `counted` back to rows paired with decrypted responses; `incompleteReason` check; build + put artifact; log counted/superseded/invalid/undecryptable counts.
  - `buildArtifact`: take `entries: {row, response}[]` + `opts: {sealed, sealedReveal?}`; sealed sets `tally.sealed=true`, `toArtifactResponders(…, {revealedAnswers: true})`, provenance `sealedReveal` (chainHash hex from the definition).
  - Remove the TODO + stale header sentence (:20-21).
- `backend/server/package.json`: add `@tessera/tlock`.
- `finalize.test.ts` (stub reveal, no crypto): emits with `sealed:true` + committed answers + provenance beacon; post-reveal dedup (later ballot reveals null → earlier valid counted — the finding-2 scenario); postpones while round unavailable (weights still frozen, reveal not called); reveal throw postpones without escaping; non-quicknet skipped (reveal not called); sealed cancellation artifact has `sealed:true`.

## Phase 5 — Verifier

Commit: `Verify sealed artifacts by revealing with an independently fetched beacon`

- `verify.ts`: `VerifyInputs.reveal?: (records, {chainHash, round}) => Promise<(SurveyResponse|null)[]>`; `base.sealed = def.submissionMode.type === "sealed"` (fixes :92); sealed branch after `eligible` is built: non-quicknet → note + empty perRole (loud MISMATCH is correct); missing `reveal` → throw; else reveal → `auditRevealedResponses` → counted records carry public answers so the existing weight/tally code runs unchanged; `toArtifactResponders(…, {revealedAnswers:true})`. `diffTallies`: responder-level `answers` comparison.
- `cli.ts`: wire `reveal` from `@tessera/tlock` (`fetchBeacon` + `revealWithBeacon`); print exclusion counts as notes. Add `@tessera/tlock` dep.
- `verify.test.ts`: sealed MATCH + tampered-answer MISMATCH (stubbed reveal); public regression (still `sealed:false`).

## Phase 6 — Frontend (three commits)

**A. `Route sealed surveys with an artifact to the final results view`**
- New pure `frontend/app/src/domain/resultsRouting.ts`: `resultsView(sealed, hasArtifact, showRaw): "final"|"sealed"|"raw"` = `hasArtifact && !showRaw ? "final" : sealed ? "sealed" : "raw"` + unit test.
- `Survey.tsx:283-325`: `Switch` over `resultsView(...)`; `"sealed"` branch keeps `SealedResults` and, when an artifact exists, shows the existing `survey.weightedShowFinal` toggle (client reveal stays one click away).
- `artifactView.ts` / `FinalResults` CSV: prefer committed answers via core's `responderAnswers` (synthesize the `SurveyResponse`), fall back to the chain rejoin for public/legacy artifacts. Test: one-vote view over a sealed artifact matches chain view with weight 1.

**B. `Block sealed voting on unsupported drand chains`**
- `Respond.tsx`: `sealedUnsupported()` = sealed && `!isQuicknet(chainHash)`; blocks submit (`ready()` in SubmitBar) and shows a notice near the sealed banner + submit bar. Block, don't warn — such votes are permanently undecryptable. i18n en+fr.

**C. `Show the sealed ciphertext size and fee in the on-chain preview`**
- `Respond.tsx`: `sealedOnchainSize()` — `plaintextLen = max(cborLen, paddingSize)`; build the real response envelope with a zero-filled placeholder ciphertext of `sealedCiphertextSize(plaintextLen, round)` bytes; measure encoded length.
- `OnchainPreview.tsx`: drop the `!props.sealed` fee gate; show on-chain byte size + fee + MAX_TX_BYTES feasibility for sealed (plaintext preview display unchanged). i18n en+fr.

## Phase 7 — Docs

Commit: `Document sealed artifact emission` — `backend/ARCHITECTURE.md`: deferred-work bullet (:678-680), §7 artifact example (`sealed` semantics, `answers`, `sealedReveal`), §6.5.

## Verification

```
pnpm install && pnpm -r type-check && pnpm -r test
pnpm --filter tessera-app build                     # tlock still code-splits
pnpm --filter @tessera/backend exec wrangler deploy --dry-run   # Worker bundles tlock-js
pnpm --filter @tessera/backend dev                  # watch "finalize:" logs
# End-to-end on preview net: create sealed survey (near endEpoch), vote, wait past
# deadline+round → artifact appears, UI shows FinalResults; then:
pnpm --filter @tessera/verifier verify -- --backend <url> --survey <tx>:<i>   # MATCH
```

Discipline: golden ruleset hash updated in the same commit as the v3 bump; sealed tests compute hashes structurally, never hardcode v3's hash outside the golden test.

## Risks

- Worker runtime proof: CI dry-run catches bundling; a deployed preview cron run is the real CPU/subrequest check (1 drand fetch per sealed survey per pass — negligible; decrypt budget caps CPU).
- `sealedCiphertextSize` math errors are caught by the equality test; fallback if fragile: measure via one offline `encryptToRound` in the preview memo.
- Pre-v3 public artifacts keep their v2 rulesetHash — verifier reports a self-describing ruleset diff; artifacts are immutable, no migration.
- Non-quicknet warn every 3 min forever — accepted; a persisted "skipped" marker is a possible follow-up.
