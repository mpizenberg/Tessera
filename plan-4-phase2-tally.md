# Phase 2 — Stake-weighted tallies + content-addressed artifacts

## Context

The Tier-1 serving backend is live (per-page endpoints, commit `001639f`). What
remains of `backend/ARCHITECTURE.md` Phase 2 is the feature the backend exists
for: **per-role, stake-weighted survey results** (§6), produced by a Koios-backed
snapshotting system (§6.5), published as **content-addressed, re-verifiable
artifacts** (§7), consumed by the results UI and a standalone verifier (§8).
Today the app shows raw one-per-credential counts with a "no weighting" disclaimer,
and responses' credential proofs are never verified (forgeable tallies — §6.3
rule 2 is "not deferrable past the first tally").

**User decisions locked:** implement **all four milestones in sequence**;
artifacts stored in the **D1/SQLite `tally_artifact` table only** (no R2 —
documented deviation from §7); **sealed-survey artifact emission deferred**
(weights still frozen at `end_epoch` per §6.2). Commits only when explicitly
asked; scratch plan files (`plan-*.md`) never committed.

**Koios shapes were live-verified on preview** (tip epoch 1346) during planning:

- `GET /tx_by_metalabel` can select `epoch_no` per tx (rule 1 is free in the
  existing scan); it has **no** block-index column.
- `POST /tx_info?select=tx_hash,tx_block_index` → the §6.3 dedup ordering field.
- `POST /account_stake_history?epoch_no=eq.E&select=stake_address,epoch_no,active_stake`
  `{_stake_addresses}` → one row per delegated account at E, `active_stake`
  decimal string; no row for registered-but-undelegated accounts (weight 0).
  (The similarly-named `/account_history` is the deprecated variant — don't use.)
- `POST /account_update_history?epoch_no=lte.E {_stake_addresses}` → flat
  registration/deregistration/delegation event rows with `epoch_no`/
  `absolute_slot` → historical "registered at E". (`/account_updates` is the
  deprecated variant.)
- `GET /drep_voting_power_history?_drep_id=<drep1…>&_epoch_no=E` → row iff
  registered at E (takes CIP-129 id).
- `GET /epoch_info?_epoch_no=E&_include_next_epoch=false` → `active_stake` total.
  **Caveat:** some historical preview epochs return a db-sync word128 error —
  totals must be retriable/best-effort.
- `GET /drep_epoch_summary?_epoch_no=E` → `amount` (DRep total).
- Credential encoders come from **evolution-sdk** (already a `@tessera/koios`
  dep, verified in `dist/`): `DRep.toBech32` is CIP-129 (headers 0x22/0x23),
  `RewardAccount.fromBytes(29-byte header‖hash).toBech32` yields
  `stake`/`stake_test` addresses, and generic `Bech32.FromBytes(prefix)` (or
  decode-and-compare via `FromBech32`) covers `gov_action1…` ids. No hand-rolled
  bech32 anywhere.

**Mechanism B semantics confirmed** from `frontend/cip-179.md` (§Credential
proof / §Linked survey response rules): a `voting_procedures` binding must match
the response credential, vote on `linked_action_id`, and its voter-tag role
(0/1→CC, 2/3→DRep, 4→SPO) must equal the claimed role; **a present-but-failing
binding invalidates the response; an absent binding is not a failure**; binding
applies only to governance-linked surveys; Stakeholder/Owner cannot bind.

## Cross-cutting decisions

| Decision | Choice (rationale) |
|---|---|
| Weighted tally API | New parallel `weightedTally.ts` in core; existing `tally.ts` moves verbatim and stays the count-based live-UI tally (disjoint output shapes; no churn of 58 app tests). |
| Credential encodings | Thin wrappers in `packages/koios/src/bech32.ts` over evolution-sdk (`RewardAccount`, `DRep`, `Bech32`) — stake address (key+script, both networks), CIP-129 `drep_id`, `gov_action` id comparison. Dynamic import like `txProof.ts` (server/verifier path only). Tests against CIP-19/CIP-129 vectors. |
| Artifact hash | **blake2b-256** via `@noble/hashes` (user decision: Cardano-native, blake is available wherever Cardano tooling runs; noble already used for script hashing). New small pure dep on `@tessera/core`. Hashing is synchronous. |
| Canonical JSON | Own ~40-line `canonicalJson()` (JCS-lite: sorted keys, no whitespace, integers-only numbers, throws on floats/unsafe; big values are decimal strings). One module shared by emitter + verifier (pins §11's canonicalization item). |
| Ordering/dedup | `ChainPos.epochNo` and `ResponseRecord.responseIndex` become **required** (both known at scan/decode time in every path); `blockIndex?` optional (server-enriched via `/tx_info`). `dedupeResponses` orders by `(slot, blockIndex ?? −1, responseIndex)` — **no txHash tiebreak, no legacy degradation** (PoC-phase standard; old cached blobs self-heal within one 3-min refresh). Export `laterInChain(a,b)` for finalization + verifier. Bonus: client audit's rule-1 deadline check switches from the `epochOfSlot` estimate to authoritative `epochNo` (M2). |
| Rules 1–3 persistence | New `validated_response` table filled **incrementally during backend refresh** — only new `(txHash, responseIndex)` keys cost `/tx_info` + `/tx_cbor`; browser `fetchAll` unchanged (no extra calls). |
| Store shape | `store.ts` grows `TallyStore`; `BackendStore = SnapshotStore & TallyStore`; both impls (node inline schema, D1 via migrations — existing convention). |
| TallyInputSource | Role-semantic seam in core (`tallyInput.ts`): `stakeholderWeights/drepWeights/stakeholderTotal/drepTotal` (endpoint-agnostic → Tier 2 can implement). `KoiosTallyInputs` in `@tessera/koios`. |
| Finalization trigger | Same cron/loop, runs after refresh. Finalize when `tip.epoch > endEpoch && nowSec ≥ voteDeadlineUnix(endEpoch, tip, spe) + 600` and no artifact row. Idempotent: `weight_snapshot` rows are the resume cursor; artifact insert is `INSERT OR IGNORE`. |
| Artifact serving | `GET /api/surveys/:txHash/:index/artifact` (primary) + `GET /api/artifacts/:hash`; stored JSON served **verbatim** (byte identity), strong `ETag: "<artifactHash>"`, `Cache-Control: public, max-age=31536000, immutable`. |
| DataSource seam | `DataSource` gains `artifact(ref): Promise<TallyArtifact | null>`; IndexerDataSource maps 404→null; KoiosDataSource always returns null (direct mode keeps raw counts). |
| Verifier | New workspace package `packages/verifier` (`@tessera/verifier`), tsx CLI; trusts only Koios + the survey bundle, NOT the backend's validation tables. |
| SPO/CC | Excluded from artifacts (ruleset pins covered roles {0 DRep, 3 Stakeholder, 4 Owner}); such responses dropped with a warning (§6.1 deferral). |
| Determinism | `perRole` sorted by role asc; responders by credential hex; options in definition order; numeric `values` ascending. |

## M1 — Pure core: domain move, weighted tally, artifact model, bech32

1. **Move pure domain** from `frontend/app/src/domain/` into `packages/core/src/`
   (import rewrites only): `cancellation.ts`, `survey.ts`, `audit.ts`, `tally.ts`,
   `answer.ts` + their tests. `fee.ts`/`roles.ts`/`create.ts`/`respond.ts` stay in
   the app (wallet/write-path). Leave 1-line re-export shims at the old app paths
   (established pattern — cf. `frontend/app/src/util/hex.ts`); `export type` for
   types (verbatimModuleSyntax). Delete moved app test files.
2. **`packages/core/src/weightedTally.ts`** + tests (§6.6, all BigInt, no floats):
   ```ts
   interface WeightedResponder { credentialKey: string; weight: bigint; txHash: string; response: SurveyResponse }
   type WeightedQuestionTally =
     | { kind: "options"; unit: "singleChoice"|"multiSelect"|"rankingFirst"; optionWeights: bigint[]; optionCounts: number[]; answeredCount: number; answeredWeight: bigint }
     | { kind: "numeric"; weightedSum: bigint; answeredWeight: bigint; answeredCount: number; values: { value: bigint; weight: bigint; count: number }[] }
     | { kind: "perOption"; unit: "points"|"rating"; perOption: { weightedSum: bigint; answeredWeight: bigint; count: number }[]; levelWeights?: bigint[][]; answeredCount: number; answeredWeight: bigint }
     | { kind: "custom"; answeredCount: number; answeredWeight: bigint };
   function weightedTallySurvey(def, responders): WeightedQuestionTally[]
   ```
   Means are `{weightedSum, answeredWeight}` rationals. Owner/count-only passes
   `weight = 1n`. Custom carries counts only.
3. **`packages/core/src/canonical.ts`** + tests: `canonicalJson(value): string`,
   `blake2b256Hex(text): string` (via `@noble/hashes/blake2` — add as core dep).
4. **`packages/core/src/artifact.ts`** + tests: `TallyBody` (`rulesetHash`,
   `network`, `survey {txId,index,endEpoch}`, `sealed`, optional `cancelled
   {txHash,slot,epoch}` with empty `perRole`, `perRole[]` with `role`,
   `total: string|null` (null = count-only), `responders[]` sorted by credential,
   `questions[]` as decimal-string aggregates); `TallyArtifact = {tally, provenance
   {source{provider,baseUrl}, fetchedAt, byRole[{role,endpoint}]}}`;
   `RULESET_DESCRIPTOR` const (rulesetVersion 1, cip179SpecVersion 4, the §6.2/§6.3
   rule strings incl. dedup order `(slot, tx_block_index, response_index)`,
   role→measure map); sync `rulesetHash(): string`, `artifactHash(tally): string`,
   `toArtifactQuestions(...)`.
5. Barrel exports; update `packages/core/src/index.ts` header.

**Verify:** `pnpm -r type-check && pnpm -r test`; app build unchanged;
cross-check test: weighted tally with all weights `1n` reproduces `tally.ts`
counts on shared fixtures; canonicalJson ordering/idempotence tests.

## M2 — Read model + §6.3 rules 1–3, persisted incrementally

1. **Core types** (`source.ts`): `ChainPos.epochNo: number` (required),
   `ResponseRecord.responseIndex: number` (required), `.blockIndex?: number`
   (optional, server-enriched); `TxProof extends CancellationProof { votes:
   VoteBinding[] }` with `VoteBinding {voterTag, credentialHash, actionIds}`.
2. **`dedupe.ts`**: add `laterInChain` ordering by `(slot, blockIndex ?? −1,
   responseIndex)`; `dedupeResponses` uses it; **txHash tiebreak removed**
   (PoC-phase, no legacy degradation). Rewrite affected tests.
3. **Koios scan** (`koios.ts`): select `tx_hash,absolute_slot,epoch_no`;
   `classify()` carries `epochNo` everywhere and enumerates responses with their
   payload index (fixes the dropped-index bug). Two new concrete server methods:
   `txBlockIndices(hashes)` (POST `/tx_info` select `tx_hash,tx_block_index`,
   chunk 50) and `txProofs(hashes)` (POST `/tx_cbor` chunk 25 + `decodeTxProof`);
   `withCancellationProofs` refactors onto `txProofs`.
4. **`packages/koios/src/bech32.ts`** + tests: thin wrappers over evolution-sdk
   (dynamic import, same discipline as `txProof.ts`): `stakeAddress(cred,
   network)` via `RewardAccount.fromBytes(header‖hash)→toBech32`, `drepId(cred)`
   via `DRep.toBech32` (CIP-129), `govActionId(txIdHex, index)` via generic
   `Bech32` (CIP-129). CIP-19/CIP-129 test vectors.
5. **`txProof.ts`**: generalize to `decodeTxProof(cbor): Promise<TxProof|null>` —
   same SDK decode + read `tx.body.votingProcedures` (Conway field 19), voter
   credential hex + voted action ids via `govActionId()`. Keep
   `decodeCancellationProof` as alias. **De-risk first**: commit a real preview
   vote-tx CBOR fixture; if the SDK shape surprises, fall back to a narrow manual
   field-19 read.
6. **`packages/core/src/proof.ts`** + test matrix — pure Mechanism A/B evaluator:
   `responseCredentialProven(response, proof, linkedActionId)`. Binding present
   (credential matches, only when `linkedActionId !== null`): binding decides —
   must vote the linked action AND voter-tag role must equal claimed role;
   present-but-failing ⇒ false even if A passes. Binding absent: Mechanism A
   (key ∈ requiredSigners, or native script found + `nativeScriptSatisfied`).
7. **Core `audit.ts`**: rule-1 deadline check switches from the `epochOfSlot`
   estimate to authoritative `r.epochNo > endEpoch` (`epochOfSlot` stays for
   UI countdowns via `voteDeadlineUnix`).
8. **Migration `0002_validated_responses.sql`** (+ store-node inline):
   `validated_response(tx_hash, response_index, survey_key, role, credential,
   slot, epoch_no, block_index NULL-able, proof_ok NULL-able, well_formed,
   checked_at, PK(tx_hash, response_index))` + index on `survey_key`. NULLs mean
   "fetch failed, retry next refresh"; `epoch_no` stored raw (rule 1 stays a pure
   comparison at tally time).
9. **Store**: `TallyStore { completedValidationKeys(); upsertValidatedResponses(rows);
   validatedForSurvey(surveyKey) }`; `BackendStore = SnapshotStore & TallyStore`;
   implement in `store-node.ts`, `store-d1.ts`, and `http.test.ts`'s `memStore`.
10. **`backend/server/src/validate.ts`**: `validateNewResponses(config, store,
    records, govLinks, source)` — candidates = records minus completed keys;
    batch `txBlockIndices` + `txProofs` for candidate unique txs; per record:
    resolve def by `refKey` (unknown ⇒ skip), `well_formed = validateResponse(...)
    .length === 0`, `proof_ok = responseCredentialProven(resp, proof,
    linkedActionIdFor(surveyKey))`; upsert. Hooked at the end of `refreshSnapshot`
    (covers Node loop + Worker cron); best-effort with warnings. Steady state = 0
    extra subrequests.
11. `refreshSnapshot(config, store: BackendStore)`; `main.ts`/`worker.ts` type
    updates. No legacy-blob shims: a pre-M2 cached blob is replaced by the next
    refresh (~3 min); deploy backend before (or with) the frontend as usual.

**Verify:** unit (scan mock asserts epochNo/responseIndex + multi-response
payloads; proof matrix; validate.ts incremental test — second run fetches
nothing); live: run Node backend on preview, inspect `validated_response` via
sqlite3 (expect `proof_ok=1` for the real wallet responses), second refresh adds
no subrequests, spot-check one `block_index` against `curl /tx_info`.

## M3 — Weight snapshotting, finalization, artifact serving

1. **Migration `0003_tally.sql`** (+ store-node inline): `weight_snapshot`,
   `epoch_totals`, `tally_artifact` per §6.5 (weights/totals TEXT decimal strings).
2. **Core `tallyInput.ts`**: `WeightInfo {weight: bigint; registered: boolean}`;
   `TallyInputSource { stakeholderWeights(epoch, creds); drepWeights(epoch, creds);
   stakeholderTotal(epoch): Promise<bigint|null>; drepTotal(epoch) }` (null =
   temporarily unavailable, retry).
3. **`packages/koios/src/tallyInputs.ts`** — `KoiosTallyInputs`: stakeholder =
   `stakeAddress()` + POST `/account_update_history?epoch_no=lte.E` (registered
   at E iff last reg/dereg event by `absolute_slot` order is a registration;
   `delegation_pool` after last dereg also implies registered) + POST
   `/account_stake_history?epoch_no=eq.E&select=stake_address,epoch_no,active_stake`
   (missing row + registered ⇒ `0n`), chunk 50; drep = per-cred GET
   `/drep_voting_power_history` (row ⇒ registered);
   totals = `/epoch_info` + `/drep_epoch_summary`, catch → warn → null.
4. **Store additions**: `weightRows/upsertWeightRows/epochTotal/putEpochTotal/
   artifactBySurvey/artifactByHash/putArtifact (INSERT OR IGNORE)/
   finalizedSurveyKeys`.
5. **`backend/server/src/finalize.ts`** — `finalizeClosedSurveys(config, store,
   inputs, source)`:
   - candidates: `tip.epoch > endEpoch && now ≥ voteDeadlineUnix(...) + 600 &&
     !finalized`, grouped by endEpoch;
   - **cancelled**: snapshot has `proof: null` for closed surveys (koios only
     verifies open ones) — re-fetch via `source.txProofs`, check
     `cancellationVerified(def.owner, proof)` + in-window (`epochNo ≤ endEpoch`,
     `epochOfSlot` fallback) ⇒ cancellation artifact, no weight work;
   - **counted set**: `validatedForSurvey` rows with `wellFormed && proofOk === true
     && epochNo ≤ endEpoch`; `proofOk null` excluded with warning; roles ∉ {0,3,4}
     dropped with warning;
   - union credentials per `(E, role)` across surveys (§6.5); fill only missing
     `weight_snapshot` rows via `inputs` (Owner written locally as weight "1");
     fill missing `epoch_totals` (null ⇒ retry next cron);
   - emit per survey only when complete: membership filter (`registered=1`) →
     `laterInChain` dedupe per (role, credential) → join weights →
     `weightedTallySurvey` per role → `TallyBody` + provenance → `artifactHash`
     → `putArtifact`. **Sealed**: freeze weights, skip emission,
     `TODO(sealed-artifact)`.
6. **Wiring**: `worker.ts` scheduled → refresh then finalize under one
   `ctx.waitUntil` + subrequest counter; `main.ts` loop tick likewise.
   Subrequest estimate: N stakeholders + D dreps ⇒ `2·ceil(N/50) + D + 2` — the
   resume cursor converges across crons if a run is cut short.
7. **Routes**: the two artifact GETs (above), body served verbatim, immutable
   caching, If-None-Match → 304; 404 JSON error when absent.
8. **ARCHITECTURE.md updates**: exact endpoint names (`/account_stake_history`
   + `/account_update_history`, PostgREST epoch filters); D1-not-R2 (+rationale);
   blake2b-256 + JCS-lite pinned; sealed emission deferred; `/epoch_info`
   flakiness + retry semantics; finalization rule (+600 s margin); §6.5/§10
   marked done as they land; snapshot-window caveat (a survey aging out of
   `sinceUnix` before closing never finalizes — acceptable at PoC).

**Verify:** unit `finalize.test.ts` (fake TallyInputSource + in-memory
BackendStore): idempotency, resume (null total first run ⇒ no artifact; filled ⇒
artifact), cancellation artifact, sealed freeze-without-emit, deterministic hash
across runs; route tests incl. 304. Live: Node backend against a closed preview
survey — inspect the three tables, `curl -i` both artifact routes, cross-check
one responder weight against `/account_stake_history` manually; Worker path via
`pnpm --filter @tessera/backend dev:cf` + `curl "…/__scheduled?cron=*/3+*+*+*+*"`,
watch the subrequest log. Deploy both halves only at the end (contract is
additive this time — no breaking change).

## M4 — Frontend weighted results + standalone verifier

1. **Seam**: `DataSource.artifact(ref)`; `IndexerDataSource` GET → 404 ⇒ null
   (plain `JSON.parse`, artifact is wire-plain); `KoiosDataSource` ⇒ null with
   doc comment. Update `indexer.test.ts`.
2. **State**: lazy artifact resource keyed on the survey ref, fetched only when
   the aggregate is ended/cancelled; error ⇒ null (raw view).
3. **`frontend/app/src/domain/artifactView.ts`** + test: pure artifact →
   render-model; ALL floats derived presentation-side (bar fractions via
   `Number(w * 10_000n / max) / 10_000`, ada formatting, rational means).
4. **`Survey.tsx`**: "final weighted results" mode when an artifact exists —
   per-role sections from `tally.perRole`, toggle back to the raw live tally
   (unchanged for open surveys + direct mode); cancelled-artifact rendering;
   provenance/trust note replaces the "no weighting" disclaimer in weighted mode
   (Koios-sourced at epoch E, reproducible, short copyable artifact hash). New
   i18n keys en + fr; keep existing `disclaimer*` keys for the raw view.
5. **`packages/verifier/`** (`@tessera/verifier`): `src/verify.ts` + `src/cli.ts`;
   `pnpm --filter @tessera/verifier verify -- --backend <url> --survey <tx>:<i>`.
   Pipeline: fetch bundle + artifact from backend; independently refetch
   `/tx_info` block indices + `/tx_cbor` proofs from Koios; re-run rules 1–3;
   refetch weights/membership at end_epoch via `KoiosTallyInputs`; filter,
   dedupe, `weightedTallySurvey`; rebuild `TallyBody` with local `rulesetHash`;
   compare `artifactHash` ⇒ MATCH/MISMATCH (diff responder sets + aggregates on
   mismatch), exit 0/1. Unit test over a fixture bundle + fake inputs.
6. ARCHITECTURE §8 refresh; root README status paragraph.

**Verify:** `pnpm -r type-check && pnpm -r test`; live: app against local
backend with a finalized survey — weighted results render, toggle works, direct
mode raw-only; verifier against deployed preview backend ⇒ MATCH; tampered
artifact copy ⇒ MISMATCH. Redeploy both CF halves; re-run verifier against
production URLs.

## Housekeeping

- Maintain a scratch `plan-4-phase2-tally.md` at repo root (never committed)
  mirroring this plan + live status, per the repo's plan-file convention.
- Prettier on all touched files; commits only when the user asks (Co-Authored-By
  Claude Fable 5 trailer).
- Each milestone ends fully green (`pnpm -r type-check && pnpm -r test`) and is
  a natural commit point.

## Risks

1. evolution-sdk `votingProcedures` runtime shape unexercised — de-risked first
   in M2 with a real preview vote-tx CBOR fixture; fallback: manual field-19 read.
2. `/account_update_history` registered-at-E edge cases (reg+dereg same epoch)
   — rule pinned in tests + implicitly by `rulesetHash`.
3. `/epoch_info` historical failures on preview strand affected surveys
   unfinalized (visible in logs; retriable).
4. Free-plan Worker subrequest cap on a very large closing survey — converges
   across crons via the weight-row resume cursor.
5. Same-slot dedupe ties can flip vs pre-M2 display — one-refresh transient.

---

## Live status

- [x] **M1 done** (all green: 146 tests workspace-wide, app build unchanged).
  - Moved `cancellation/survey/audit/tally/answer` (+4 test files) from
    `frontend/app/src/domain/` to `packages/core/src/` via `git mv`; 1-line
    re-export shims left at the old `~/domain/*` paths.
  - `ratingScaleInfo` now exported from core `tally.ts` (shared level bucketing).
  - New: `canonical.ts` (canonicalJson JCS-lite + blake2b256Hex via
    @noble/hashes ^2.2.0, new core dep), `weightedTally.ts` (all-BigInt,
    WeightedResponder/WeightedQuestionTally, all-weights-1n cross-check test
    passes), `artifact.ts` (TallyBody/TallyArtifact/RULESET_DESCRIPTOR v1 +
    rulesetHash/artifactHash/toArtifactQuestions/toArtifactResponders).
- [x] **M2 done** (all green: 184 tests; live-verified on preview).
  - De-risk first: evolution-sdk decodes voting_procedures cleanly; runtime is
    `Map<Voter, Map<GovActionId, Procedure>>` (fixtures committed:
    packages/koios/src/fixtures/voteTxs.ts, real preview DRep + SPO votes).
  - Core: ChainPos.epochNo required; ResponseRecord.responseIndex required +
    blockIndex?; VoteBinding/TxProof types; laterInChain (slot, blockIndex??-1,
    responseIndex) with NO txHash tiebreak; audit rule 1 reads r.epochNo
    (auditResponses(raw, def) — tip/spe params dropped); proof.ts
    responseCredentialProven (mechanism A/B, present-but-failing binding
    invalidates, B only when linked, kinds don't cross-match).
  - Koios: scan selects epoch_no; classify enumerates response indices;
    txProofs()/txBlockIndices() server methods; withCancellationProofs on
    txProofs; bech32.ts (stakeAddress/drepId/govActionId over evolution-sdk,
    verified against Koios-emitted drep_id + proposal_id vectors; SDK re-exports
    effect Schema so no new dep; encode via Schema.decodeSync(Bech32.FromBytes)).
  - Backend: migration 0002_validated_responses.sql (+ store-node inline);
    TallyStore/BackendStore (validationKey helper; completed = both enrichments
    non-NULL); openBackendStore/d1BackendStore (D1Like gains all()+batch());
    validate.ts (validateNewResponses(store: TallyStore, records, govLinks,
    source) — epoch-aligned links only) hooked at end of refreshSnapshot,
    best-effort.
  - Live: 16 real preview responses → proof_ok=1, well_formed=1, block_index +
    epoch_no spot-checked against /tx_info; second refresh validates nothing.
- [x] **M3 done** (198 tests; live-verified on Node AND the local Worker).
  - Core: tallyInput.ts (TallyInputSource/WeightInfo), parseCredentialKey,
    laterInChain generalized to structural ChainOrderKey.
  - Koios: tallyInputs.ts KoiosTallyInputs — /account_update_history?epoch_no=lte.E
    (registered iff last event by absolute_slot isn't a dereg) +
    /account_stake_history?epoch_no=eq.E (missing row + registered ⇒ 0n) chunk 50;
    dreps per-cred /drep_voting_power_history?_drep_id=…&epoch_no=eq.E
    (NB: `_epoch_no` param misbehaves for current epochs — PostgREST filter used,
    verified live); totals /epoch_info (FLAKY: word128 400s on recent preview
    epochs, transient — retry design confirmed live when 1337 healed) +
    /drep_epoch_summary, catch→null.
  - Backend: migration 0003 + store-node inline + d1 (batch upserts);
    TallyStore grows weightRows/upsertWeightRows/epochTotal/putEpochTotal/
    artifactBySurvey/artifactByHash/putArtifact(OR IGNORE)/finalizedSurveyKeys;
    store-mem.ts shared test store; finalize.ts (candidates tip.epoch>endEpoch
    && now ≥ deadline+600 && no artifact; cancellations re-proved via txProofs,
    epochNo ≤ endEpoch; counted = wellFormed && proofOk===true && epochNo ≤
    endEpoch, proofOk null excluded w/ warning, roles ∉{0,3,4} dropped; union
    per (E,role); Owner weight "1" local; emit only when weights+totals
    complete; unregistered dropped at emit; sealed = freeze only,
    TODO(sealed-artifact)); hooked at end of refreshSnapshot after validate.
  - Routes: GET /api/surveys/:tx/:i/artifact + /api/artifacts/:hash — stored
    text verbatim, strong ETag "<hash>", immutable, 304, 404s.
  - ARCHITECTURE.md: §5.1 artifact routes, §6.4 real endpoints + pitfalls,
    §6.5 implemented (600 s margin, resume cursor, sinceUnix-window caveat,
    validated_response note), §7 blake2b-256+JCS-lite pinned + D1-not-R2
    deviation + no `registered` field on responders, §10/§11 checked off.
  - Live: Node run emitted 2 weighted + 1 cancellation artifact, froze 3 sealed,
    postponed flaky-total surveys; weight 512793397078@1336 cross-checked
    against Koios; Worker run (wrangler dev + __scheduled, D1 migrations 1-3)
    did refresh+validate+finalize in 18 subrequests and produced IDENTICAL
    artifact hashes to Node (cross-runtime determinism).
- [x] **M4 done, except deployment** (212 tests; verifier live-tested).
  - Seam: DataSource.artifact(ref) (core source.ts); IndexerDataSource GET
    /artifact 404→null (plain JSON.parse — artifacts are wire-plain);
    KoiosDataSource always null (direct mode keeps raw tally).
  - App: lazy artifact resource in Survey.tsx (only for closed/cancelled,
    errors degrade to raw view); artifactView.ts (fracOf/ratioOf via
    Number(x*10_000n/max)/10_000, formatAda, weightedQuestionView,
    weightedRoleViews — the ONLY float site); WeightedResults +
    WeightedQuestionResult components mapping every kind onto ResultBarCard;
    provenance note (badge "final", epoch+provider, artifact hash recomputed
    locally, shortened w/ full in title) replaces the raw disclaimer in
    weighted mode; toggle both ways; cancelled-artifact card; i18n en+fr
    (weighted* keys; disclaimer* kept for raw view); CSS: weightedBadge (ok
    palette) + weightedRoleHead/Title/Meta.
  - Determinism fix surfaced by the verifier: the recorded cancellation is now
    pinned to the EARLIEST verified in-window one by (slot, txHash) — rule
    added to RULESET_DESCRIPTOR (rulesetHash changed!), finalize.ts sorts.
  - packages/verifier (@tessera/verifier, added to pnpm-workspace): verify.ts
    (rebuildTally + verifyArtifact + diffTallies + linkedActionIdFor; trusts
    only Koios + bundle; unfetchable total falls back to artifact's value with
    an explicit note), cli.ts (--backend --survey tx:i [--koios --token
    --since]; exits 0 MATCH / 1 MISMATCH / 2 no-artifact-or-usage); 5 unit
    tests (MATCH, tampered weight, unproven response, cancellation, total
    fallback).
  - Live: verifier vs local backend → MATCH on weighted + cancellation
    artifacts; correctly flagged pre-ruleset-change artifacts as "different
    counting rules" (they were re-emitted); sqlite-tampered weight → MISMATCH
    naming the credential. Old-ruleset artifacts were deleted from the scratch
    DB and re-emitted under ruleset v1-current.
  - Docs: ARCHITECTURE §8 rewritten (implemented); root README status +
    layout + verifier command; pnpm-workspace.yaml.
- [ ] **Deployment (user-gated)**: remote D1 migrations + Worker deploy were
  denied by the permission classifier (production infra). Commands ready:
  1. `cd backend/server && npx wrangler d1 migrations apply tessera-cache-preview --remote`
  2. `pnpm --filter @tessera/backend deploy:cf`
  3. `pnpm --filter tessera-app deploy:preview`
  4. `pnpm --filter @tessera/verifier verify -- --backend <prod-url> --survey <tx>:<i>`
  NOTE: deployed-DB artifacts emitted before this deploy don't exist yet (new
  tables), so finalization will populate them on the first crons; also
  /epoch_info on preview is currently flaky for recent epochs — stakeholder
  surveys finalize when it heals (retry design).
