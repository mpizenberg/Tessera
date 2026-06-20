# Backend Indexer Research — CIP-179 On-Chain Surveys

Preliminary research to confirm or reject the candidate backend solutions for indexing
CIP-179 survey/poll metadata (tx metadata **label 17**). Goal (per `GOAL.md`): something
**lightweight, reliable, and fast**, ideally able to **semantically index the metadata at
ingestion** (surveys, responses, cancellations), with post-processing as an acceptable
fallback.

Candidates: **Adder** (Blink Labs, Go), **Yaci Store** (Bloxbean, Java/Spring), **Oura**
(TxPipe, Rust). Sources were read directly from `backend/deps/{adder,yaci-store,oura}` plus
the example consumers `cdnsd` (Adder) and `administration-data/indexer` (Yaci Store).

---

## 1. What the indexer actually needs

Re-reading `../minimal/cip-179.md`, an implementation that goes beyond "store the raw blob"
must touch four layers. This is the yardstick for the candidates.

| # | Requirement | Where in CIP-179 | Difficulty |
|:--|:------------|:-----------------|:-----------|
| **R1** | Filter tx metadata by **label 17**, decode the CBOR payload (tag 0 defs / 1 responses / 2 cancellations) | §Overview, §CBOR examples | Easy |
| **R2** | Access **tx body fields beyond metadata**: `required_signers` (field 14), `voting_procedures`, governance `proposal_procedures` + anchors (Info Actions) | §Credential proof (mech. A/B), §Governance Action Linkage | Medium — needs full-tx access |
| **R3** | Query **ledger state** for validation: registered DReps, SPO cold creds, active CC hot creds, stake delegation, **native-script resolution** | §Role validation, §Credential proof | **Hard** — this is real ledger state |
| **R4** | Track **chain order** `(slot, tx_index, response_index)` and handle **rollbacks/reorgs** | §Deduplication, §Epoch Semantics | Medium |
| **B1** | *(Bonus)* Decode + semantically index label-17 payloads **at ingestion** | `GOAL.md` | Easy–Medium given a good hook |

Two observations that shape the whole evaluation:

- **R2 is the discriminator on the streaming layer.** Credential proof and Info-Action
  linkage are not in the metadata — they live in the transaction body (`required_signers`,
  `voting_procedures`) and in governance proposals/anchors. A tool that only surfaces
  metadata, or that drops these fields from its parsed model, forces you down to raw CBOR.
- **R3 is the discriminator overall, and no streaming tool fully solves it.** Role
  validation needs *current* ledger state ("is this credential a registered DRep / active
  CC hot key / SPO at slot S?"). This is genuine ledger state, obtainable only via the
  node's LocalStateQuery, a state indexer (db-sync/Kupo/Koios/Blockfrost), or by
  materializing it yourself from the certificate stream. **Yaci Store is the only candidate
  that ships any of this; Adder and Oura provide none.**

  R3 is partly **deferrable**: the CIP separates *response-time* validation from *tally-time*
  re-verification, and `GOAL.md` explicitly allows post-processing. The indexer's hard job
  is to **capture everything R1+R2+R4** faithfully; role validation can be a later stage
  that reads ledger state. So the streaming-layer choice should be judged primarily on
  R1/R2/R4 + footprint, with R3 as a "how much do I get for free" tiebreaker.

---

## 2. Candidate summaries

### Adder (Blink Labs) — Go · event-stream pipeline · embeddable

Direct node chainsync over Ouroboros mini-protocols (via `gouroboros`), decoding every block
into a typed `input → filter → output` event pipeline. Designed to be used **as a Go library
inside your own binary** — `cdnsd` is the canonical example (imports `pipeline`,
`input/chainsync`, `output/embedded`).

- **R1 (label 17):** ✅ Trivial, but **not built in** — you do a map lookup on
  `tx.Metadata()` in your callback. Metadata arrives **already CBOR-decoded** into a typed
  tree, and each node retains `.Cbor()` so you can re-decode label 17 into your own structs
  (exactly how `cdnsd` decodes datums).
- **R2 (full tx):** ✅ **Best-in-class.** Each `input.transaction` event carries the full
  `ledger.Transaction`: `RequiredSigners()` (field 14), `VotingProcedures()`,
  `ProposalProcedures()` (Info Actions), `Certificates()`, anchors, raw `Cbor()`. Adder
  *also* emits a pre-parsed `input.governance` event with typed votes/proposals/cert data —
  a real shortcut for the Info-Action profile.
- **R3 (ledger state):** ❌ **None.** Pure stateless stream. You'd add a sidecar — but Adder
  helps two ways: (a) `gouroboros` already implements the `localstatequery` mini-protocol, so
  you can open a second n2c query connection against the same node; (b) Adder emits DRep/CC
  registration certs as events, so you can *materialize* the DRep/CC/SPO sets yourself.
  Optional Kupo integration resolves spent UTxOs (helps native-script/address resolution).
- **R4 (order + rollback):** ✅ Rollbacks are first-class `input.rollback` events;
  resumable cursor via `WithIntersectPoints` + `WithStatusUpdateFunc` (cdnsd persists
  `(slot, hash)` in Badger). Optional `WithDelayConfirmations(n)` buffers N blocks to absorb
  shallow reorgs before you ever see them. You get `slot` + `txIdx`; `response_index` you
  derive while walking the payload.
- **B1 (semantic at ingestion):** ✅ The `output/embedded` callback is exactly this seam —
  decode/validate/persist label-17 in-process, with backpressure via the returned error.
- **Storage:** BYO (cdnsd uses BadgerDB; SQLite/Postgres equally fine).
- **Footprint / maturity:** Lean when imported as a library (the heavy `go.mod` entries are
  the optional Fyne GUI tray, *not* pulled by library users). Single static binary, very
  active (v0.41.0, 2026-06-09). Needs a reachable node (or `utxorpc`/Dolos).

### Yaci Store (Bloxbean) — Java/Spring Boot · modular indexer · batteries included

A mature, production-grade modular indexer (Java 21 / Spring Boot 3.3) built on Bloxbean's
Yaci chainsync lib. Composable Spring Boot **starters** — enable only the stores you need
(`store.<x>.enabled`). Used in production by CF Ballot (a voting platform), Rosetta-Java, etc.

- **R1 (label 17):** ✅ Dedicated **metadata store**. Splits metadata **per label**, storing
  *both* decoded JSON **and** per-label raw CBOR in `transaction_metadata` (`label`, `body`,
  `cbor`). Publishes a derived `TxMetadataEvent` — your label-17 hook. (Caveat: `label` is a
  `varchar` string `"17"`.)
- **R2 (full tx):** ✅ `transaction` store persists `required_signers` (dedicated `jsonb`
  column); the `TransactionEvent` carries Yaci's fully-decoded `Transaction` (voting
  procedures, proposals, certs, witnesses…) even for fields not persisted by default.
- **R3 (ledger state):** ✅ **Uniquely strong — most of R3 for free.** `governance` store →
  DReps, committee (hot/cold), gov-action proposals (incl. `INFO_ACTION`), voting procedures,
  vote delegation. `staking` store → pools (SPO cold creds), delegations, stake. `script`
  store → native + Plutus script resolution. Plus optional **N2C LocalStateQuery** processors
  for authoritative point-in-time DRep distribution / gov-action state, and a heavier
  `governance-aggr` aggregate that computes full tallies.
- **R4 (order + rollback):** ✅ **Most robust.** `cursor_` checkpoint table; on a
  `RollbackEvent` **every store auto-deletes DB rows past the rollback slot**. You replicate
  the same `@EventListener(RollbackEvent)` pattern for your derived tables. `slot` + `tx_index`
  everywhere.
- **B1 (semantic at ingestion):** ✅ Two paths. **(A)** native Spring `@EventListener` on
  `TxMetadataEvent`/`TransactionEvent`/`GovernanceEvent` — runs in the same DB transaction as
  the store writes (atomic, rollback-consistent). **(B)** a polyglot (MVEL/JS/Python) plugin
  framework for config-driven filters/actions without forking.
- **Storage:** PostgreSQL / MySQL / H2 (no SQLite); Postgres recommended (jsonb-heavy).
  Per-module Flyway migrations, auto-applied.
- **Footprint / maturity:** The trade-off. JVM/Spring/Hibernate — heaviest option, multi-GB
  heap for full sync (less for a label-17-focused config). Very active (CF-backed), ships a
  REST API + Blockfrost-compatible API + Yaci DevKit for local testing.

### Oura (TxPipe) — Rust · `source → filter → sink` pipe · transport, not an indexer

A lightweight Rust streaming pipe built on Pallas/gasket: tails the chain, parses, filters,
pushes records to a sink. Excellent transport — but it is **not a stateful indexer**, and it
has two hard problems for this use case.

- **R1 (label 17):** ✅ A `select` filter matches `metadata.label = 17` (`split_block →
  parse_cbor → select`). Metadatum is CBOR-decoded by Pallas; for arbitrary CIP-179 payloads
  you'll re-decode raw bytes anyway.
- **R2 (full tx):** ❌ **Blocker.** Oura's parsed record is the UtxoRPC `Tx`, and the Pallas
  mapper **does not populate `required_signers` or `voting_procedures` (absent from the
  schema entirely) and leaves `proposals`/Info-Actions empty**. Certificates and metadata
  *are* mapped. So the three governance fields R2 needs are **unreachable from the parsed
  record** — you must consume **raw CBOR** (`CborTx`) and decode with Pallas
  (`MultiEraTx::required_signers()`, votes, gov-actions) yourself.
- **R3 (ledger state):** ❌ **None** — confirmed (`NoOpContext`, even UTxO resolution
  disabled). Pure pipe.
- **R4 (order + rollback):** ⚠️ Sources emit `Reset(point)` on rollback; a `rollback_buffer`
  filter gives delayed finality. **But the webhook sink hard-codes the action header to
  `"apply"` and silently drops `Reset`** — so the easy "webhook → my service" path does *not*
  reliably propagate rollbacks. The `sql_db` sink and a custom Rust sink do handle
  Apply/Undo/Reset correctly.
- **B1 (semantic at ingestion):** Three options: webhook + external service (weak rollback
  story), a WASM/extism filter (`map_cbor_tx` can decode raw CBOR → enriched JSON, but no I/O
  so no ledger queries), or a **custom Rust sink / Oura-as-library** (the only clean path,
  gives full `Apply/Undo/Reset` + raw CBOR).
- **Storage:** Persists nothing but its cursor; storage is the sink's job.
- **Footprint / maturity:** Genuinely lightweight (single static Rust binary), very active
  (v2.0.1, Conway-ready). But for *our* needs it requires the most custom Rust (raw-CBOR
  decode + custom sink + a separate state component) for the least payoff.

---

## 3. Scorecard

| Requirement | Adder (Go) | Yaci Store (Java) | Oura (Rust) |
|:------------|:----------:|:-----------------:|:-----------:|
| R1 metadata label 17 (decoded + raw CBOR) | ✅ (DIY filter, 1-liner) | ✅✅ (JSON **and** CBOR, stored) | ✅ (`select` filter) |
| R2 `required_signers` / votes / Info-Action proposals | ✅✅ (full tx + pre-parsed gov event) | ✅✅ (column + full tx event) | ❌ **dropped from parsed record → raw CBOR only** |
| R3 ledger state (DRep/SPO/CC/stake/native-script) | ❌ build sidecar | ✅✅ **mostly free** (gov+staking+script+LSQ) | ❌ build everything |
| R4 chain order + rollback handling | ✅ rollback events + cursor + delay buffer | ✅✅ auto DB rollback per store + cursor | ⚠️ Reset emitted, but webhook sink drops it |
| B1 semantic indexing at ingestion | ✅ embedded callback | ✅✅ Spring event (atomic) or plugins | ⚠️ custom Rust sink really required |
| Lightweight / footprint | ✅✅ lean Go binary | ❌ JVM, multi-GB | ✅✅ lean Rust binary |
| Embeddable as a library | ✅✅ (intended pattern) | ✅ (starters) or standalone | ✅ (crate) but custom sink needed |
| Out-of-box REST API | ➖ minimal | ✅✅ full + Blockfrost-compat | ❌ (pipe only) |
| Maturity / activity | ✅ active | ✅✅ CF-backed, prod (incl. voting) | ✅ active |
| Custom-code burden for CIP-179 | Low–Medium | **Lowest** (config + listeners) | **Highest** (raw CBOR + sink + state) |

---

## 4. Verdict on each candidate

- **Oura — not recommended as the primary.** It is the lightest binary, but for CIP-179 it
  is the worst fit: the parsed record drops `required_signers`/`voting_procedures`/Info-Action
  proposals (R2), it has no ledger state (R3), and its simple webhook path mishandles
  rollbacks (R4). You'd end up writing a custom Rust sink, decoding raw CBOR with Pallas, and
  building a separate state component — i.e. doing most of the work yourself, with Oura
  reduced to a chainsync transport. Only justified if the team is Rust-first and explicitly
  wants a thin pipe it will heavily customize. **Candidate rejected for primary use.**

- **Adder — recommended for a lightweight, embedded indexer.** Best balance against the
  stated priorities (lightweight/reliable/fast + semantic-at-ingestion). It nails R1, R2, R4
  and B1 cleanly as a Go library, and even pre-parses governance events. Its gap is R3
  (ledger state), which is *deferrable* per the CIP/GOAL and addressable via a gouroboros
  LocalStateQuery sidecar on the same node connection (or by materializing DRep/CC/SPO sets
  from the cert stream Adder already emits). **Candidate confirmed**, with R3 as a known
  follow-on component.

- **Yaci Store — recommended for the most complete, lowest-custom-code solution.** It is the
  only candidate that delivers R3 substantially for free (governance + staking + script +
  LocalStateQuery), alongside excellent R1/R2/R4 and an atomic ingestion hook (B1). The price
  is JVM/Spring weight — it is not "lightweight" in the binary sense, though a label-17-focused
  config (transaction + metadata + governance + staking, the rest off) is far lighter than a
  full ledger-state sync. **Candidate confirmed**, with footprint as the known cost.

The honest tension: **`GOAL.md` asks for "lightweight" (→ Adder) but CIP-179 validation needs
heavy ledger state (→ Yaci Store).** The two best candidates sit on opposite sides of that
trade-off, so the decision is really about how much of R3 you want the *indexer* to own
versus a downstream stage.

---

## 5. Recommended architecture(s)

### Option A — Lightweight, Adder-centric (best fit for the stated priorities)

```
cardano node ──n2n/n2c──> [Adder lib in our Go binary]
                              ├─ input.transaction  → decode label 17 (R1) + read
                              │   required_signers / voting_procedures / proposals (R2)
                              ├─ input.governance    → typed votes/proposals (Info Actions)
                              ├─ input.rollback      → undo derived rows (R4)
                              └─ persist surveys/responses/cancellations (B1) → SQLite/Postgres
        (same node) ──n2c LocalStateQuery──> role-validation sidecar (R3, gouroboros)
```

- One small Go service, single static binary, BYO embedded store.
- Captures R1/R2/R4/B1 immediately; role validation (R3) runs as a second stage reading
  ledger state — matching the CIP's response-time-vs-tally-time split and `GOAL.md`'s
  "post-process is fine".
- **Pick this if** lightweight/fast/embeddable is the priority and you're comfortable owning
  a thin ledger-state component.

### Option B — Batteries-included, Yaci-Store-centric (least custom code, most data)

```
cardano node ──n2n──> [Yaci Store: transaction + metadata + governance + staking + script]
                          ├─ TxMetadataEvent  → decode/validate label 17 (R1, atomic) (B1)
                          ├─ governance/staking tables → role validation (R3) FOR FREE
                          ├─ RollbackEvent     → auto rollback (R4)
                          └─ Postgres (yaci_store schema) + REST API
   (optional) downstream service (any language) reads Postgres → CIP-179 domain schema/API
```

- Most of R3 comes for free; richest data; production-proven; REST API included.
- **Pick this if** complete role validation/tallying inside the backend matters more than a
  small footprint, and a JVM/Postgres deployment is acceptable.

### Practical note

Both options keep semantic indexing close to ingestion (B1) and keep storage in a DB you can
also serve an API from. The choice is **footprint (Adder) vs completeness-without-reinvention
(Yaci Store)**. Oura is not in either recommended path.

---

## 6. Suggested next step

If a small proof-of-concept is wanted before committing, the cheapest decisive test is to
stand up **Adder Option A** against preprod and confirm we can, in one callback, read label 17
*and* the same tx's `required_signers` + `voting_procedures` — this validates the R1+R2 core
on the lightweight path. In parallel, a **Yaci Store** instance on Yaci DevKit with
`governance`+`staking` enabled would confirm how much of R3 truly lands for free. The two
spikes together would settle the footprint-vs-completeness decision with real data rather than
on paper.

> **Sections 7–9 below revise this conclusion.** Deeper investigation of (a) raw-CBOR/Pallas
> extraction, (b) the past-epoch ledger-state limitation, and (c) the stake-weighting
> requirement changes the picture materially. **Section 9 is the current bottom line.**

---

## 7. Deep-dive follow-ups (round 2)

Targeted verification of three things the §1–6 pass left open. All claims below are
source-cited from the local clones plus Pallas v0.35.0 and gouroboros v0.182.0.

### 7.1 Oura: raw tx access, Pallas extraction, and the rollback mechanics

- **Full raw tx — yes.** `Record::CborBlock`/`CborTx` (`oura/src/framework/mod.rs:104`) carry
  the node's bytes verbatim; n2n/n2c sources emit `CborBlock` (`sources/n2n.rs:120`). **Omit
  the `parse_cbor` filter** and lossless raw CBOR flows to the sink (`split_block` re-encodes
  per-tx, still raw). The governance fields the *parsed* record drops are all present in the
  raw bytes.
- **Pallas extraction — easy-to-moderate (~40–60 LOC).** `MultiEraBlock::decode()`, then per
  tx: `tx.metadata().find(17)`, `tx.required_signers()`, `tx.certs()` are **era-agnostic**
  (`pallas-traverse/src/tx.rs:532,549,263`). `voting_procedures` (body field 19) and
  `proposal_procedures` (field 20) are **not** in traverse — read them via
  `tx.as_conway()?.transaction_body` (`pallas-primitives/src/conway/model.rs:684-704`). Info
  Actions = `GovAction::Information`; anchors sit on each procedure. No manual `minicbor`.
- **The rollback mechanics, precisely.** Node sources signal rollback **only** as
  `ChainEvent::Reset(point)` — *no record*, no per-block `Undo` (`sources/n2n.rs:143`):
  "chain is back at `point`; discard everything after." `rollback_buffer{min_depth=N}` absorbs
  reorgs shallower than N and forwards `Reset` for deeper ones. **The webhook sink is unsafe:**
  it early-returns on record-less events (drops every `Reset`, `sinks/webhook.rs:46`) and
  hard-codes `x-oura-chainsync-action: apply` (`:60`) → silent corruption on any reorg deeper
  than the buffer. `sinks/sql_db.rs:46-59` does it right (separate apply/undo/reset templates).
  A **correct sink** must handle all three variants, slot-tag every row, and on `Reset`
  `DELETE WHERE slot > point.slot`, committing the cursor only after the data write. Sinks are
  a **closed hard-coded enum** (`sinks/mod.rs:47`) and the crate is `publish=false`, so a
  custom sink means either using the built-in `sql_db` sink or depending on Oura via git and
  writing your own pipeline runner (reusing its source/buffer/split stages + Pallas).

### 7.2 The past-epoch ledger-state limitation (applies to all node-backed tools)

**LocalStateQuery cannot answer "what was true 3 epochs ago."** gouroboros's LSQ *API* allows
`Acquire(point)` at any `(slot,hash)` and has the cheap **filtered** queries you'd want — pass
only participant credentials: `GetDRepState([]Credential)`,
`GetCommitteeMembersState(cold,hot,statuses)`, `GetSPOStakeDistr`, `GetFilteredVoteDelegatees`,
`GetFilteredDelegationsAndRewardAccounts`, `GetStakeSnapshots` (all `client.go`, Conway-gated).
**But cardano-node only retains rollback-able ledger states within ~k=2160 blocks (well under
one 5-day epoch).** Acquiring an older point is rejected with `AcquireFailurePointTooOld`
(`error.go:19`). LSQ answers "now / recent tip," never the deep past. This is a *node*
limitation, not a library one — there is no gouroboros workaround.

Consequence: to validate a survey that closed several epochs ago, the authoritative state must
come from **your own persisted history**, not a live query. That means either:
- **(a)** validate *at close* (live at the tip = the snapshot) and persist the verdict, or
- **(b)** materialize/re-compute historical state yourself and store it, or
- **(c)** an external db-sync-backed API (Koios/Blockfrost) that keeps history.

### 7.3 Yaci Store: past-epoch from its own DB, and selective storage

- **Past-epoch *membership* — yes, from its own tables.** The governance and staking stores are
  **append-only logs, every row keyed by `slot`+`epoch`**: `drep_registration` (REG/DEREG/UPDATE),
  `committee_registration`/`committee_deregistration` + `committee_member(start_epoch,
  expired_epoch)`, `delegation_vote`, `delegation`, `pool_registration`/`pool_retirement`,
  `stake_registration` (schemas `stores/governance/.../V0_1100_1__init.sql`,
  `stores/staking/.../V0_800_1__init.sql`). Reconstruct "as-of epoch N" via *latest event where
  `slot ≤ end-of-epoch-N`*. This is the historical cert log Adder/Oura would make you build.
- **Per-epoch stake *amounts* — only via the heavy path.** `epoch_stake`/`drep_dist`
  (`aggregates/adapot`, `governance-aggr`) need `account`+`adapot` from genesis;
  `local_drep_dist` is LSQ-fed at the tip only (no backfill). See §8 — this is the crux.
- **Selective storage — real levers.** Disable stores (`store.utxo|assets|epoch|mir|script|
  epoch-nonce.enabled=false`); `store.transaction.save-cbor=false`/`save-witness=false`
  (defaults) + `pruning-enabled=true`; a `metadata.save` plugin filter keeping only label 17 +
  a cron `DELETE FROM transaction_metadata WHERE label <> '17'` (the admin-data pattern). Net
  storage ≈ (governance + staking cert history) + (label-17 metadata), independent of UTxO size.
- **Participants-only state is not achievable at ingestion** (participation is discovered later
  from responses; save-time filters have no foreknowledge) — but it doesn't matter for
  *membership*, which is small enough to keep in full.

---

## 8. The state-accuracy trilemma (the decisive constraint)

Two facts surfaced above collide with `GOAL.md`'s "lightweight" goal.

### 8.1 Validation needs membership; the *authority* needs weights — and weights need a full ledger

CIP-179 *validation* only checks membership/existence (registered DRep, active CC, SPO,
delegated-stake existence) — all cert-derivable. But the body computing a survey's **result**
needs **weighting** (DRep voting power, user active stake), and that is categorically different:

> A credential's stake = Σ(ada in every UTxO under that stake credential) + reward balance,
> **snapshotted at an epoch boundary**. There is **no certificate-only shortcut** — certs give
> the delegation *graph*, never the *weights*. Computing weights requires full UTxO accounting
> + the reward calculation, i.e. ledger replay.

### 8.2 Even *membership* isn't strictly a function of the local cert sequence

Naive register/deregister-chain following is ~99.99%, not 100%, because several states are
**ledger-enacted/computed at epoch boundaries**:

- **DRep registered ≠ active:** a DRep goes *inactive* after `drepActivity` epochs without
  voting and drops out of the active voting stake.
- **CC membership:** the committee's cold creds are set/removed by **enacted `UpdateCommittee`
  governance actions** (with term epochs), and no-confidence can dissolve it — only the hot-key
  auth is a cert.
- **Pool retirement** is epoch-*scheduled* and cancellable by re-registration.
- **Conway bootstrap** predefined DReps and transitional rules.

So strictly-correct results require consulting **authoritative ledger state** — which, given
§7.2, the live node cannot provide for past epochs.

### 8.3 The trilemma

You can have at most **two** of these three at once:

1. **Lightweight / cheap** — small storage, no full-ledger replay.
2. **Authoritative + historical** — exact stake & governance, re-derivable for any past epoch.
3. **Self-contained** — no third-party service.

And the **node is the elephant**: every self-contained option chainsyncs from a cardano-node,
and LSQ *requires* a local one. Once you accept running a node, "authoritative" is much cheaper
— which is what makes the pragmatic middle path (Solution A below) work.

### 8.4 Pragmatic solutions (pick your two)

- **A — Node + lean indexer + snapshot-at-close** *(recommended for an authority that runs
  continuously)*. Light label-17 indexer; the instant each survey's `end_epoch` passes (live at
  the tip), use LSQ's *filtered* queries to pull authoritative role **and stake** for exactly
  the participant credentials, and persist an **immutable result snapshot + raw inputs**.
  → relaxes (2): sacrifices *deep-past re-derivability* only (must be live at close).
- **B — Truly light, external state.** Light indexer vs public relays + Koios/Blockfrost
  (db-sync-backed; they *do* serve per-epoch history) for participant state.
  → relaxes (3): not self-contained. Fine for *non-binding sentiment*; mitigate by snapshotting
  inputs for independent re-verification and cross-checking two providers.
- **C — Self-contained + historical, heavy.** Full state indexer: db-sync, or Yaci Store
  `account`+`adapot`+`governance-aggr` from genesis, or Amaru/Dolos.
  → relaxes (1): heavy. Run once to build snapshots, then it's queries.
- **Hybrid** *(best for a serious authority)* — a **light serving layer** for real-time UX +
  a **heavy/authoritative finalization stage** for official tallies. This is exactly the CIP's
  *response-time vs tally-time* split and `GOAL.md`'s "post-process by another stage": decouple
  fast/light from heavy/correct and the incompatibility dissolves.

### 8.5 Infra-tooling improvement opportunities

1. **Point-in-time / historical LSQ (compact epoch-snapshot service)** — the #1 gap; the node
   discards past state, forcing everyone to re-derive or trust a third party.
2. **Snapshot-only "tally-inputs" indexer** — persist per-epoch *aggregates* (stake-per-cred,
   DRep power, pool stake, committee set, DRep active/inactive) instead of the full UTxO
   history; compute is sync-once-from-genesis but storage stays compact and bounded.
3. **Mithril-certified state snapshots** — extend Mithril's certified stake-distribution
   artifacts to per-epoch governance/stake tally-inputs → *trustless* historical state, removing
   the trust objection to the external-service path (light **and** authoritative **and**
   not-trusting-anyone).
4. **Amaru / Dolos** — a lighter Rust node / pruned data-node lowers the "run a node" cost and
   shifts the whole trilemma toward feasible.
5. **Oura utxorpc mapping fix** — adding `voting_procedures`/`required_signers`/`proposals` to
   the parsed record is a small concrete fix that would make Oura viable for governance indexing.
6. **Canonical tally-snapshot interchange format** (the CIP defers this) — so independent tools
   produce identical, cross-checkable tallies, satisfying the CIP's interop acceptance criteria.

---

## 9. Revised bottom line

- **The hard requirement is no longer "decode the metadata" but "obtain authoritative,
  point-in-time stake + governance state."** Validation is cert-derivable and light; the
  *authority's weighted result* needs full ledger state, which the live node can't serve for
  past epochs (§7.2, §8.1–8.2). So the indexer choice is secondary to the **state strategy**.
- **A truly lightweight, self-contained, *and* historically-accurate stack is not achievable —
  it's a genuine trilemma (§8.3).** Yes, this confirms the user's assessment. The way out is to
  **decouple** a light serving layer from a heavier/authoritative finalization stage (Hybrid),
  or to **snapshot authoritative state at each survey's close** while live (Solution A).
- **Tool selection, re-cast around the state strategy:**
  - For the **light serving + ingestion layer** (R1/R2/R4/B1): **Adder** (lean Go, full tx
    access, pre-parsed governance, embeddable) or a **lean Yaci Store** (governance+staking+
    label-17, rest off) are both good. Oura only as a thin transport with custom raw-CBOR sink.
  - For the **authoritative state layer**: **Yaci Store with `account`+`adapot`+`governance-aggr`
    from genesis** is the most self-contained option that already exists (Solution C);
    **LSQ-at-close** (Solution A) avoids storing full history if you run continuously;
    **Koios/Blockfrost** (Solution B) is the cheapest if an external dependency is acceptable.
- **Recommended default:** the **Hybrid** — a **lean Adder (or lean Yaci) indexer** for
  real-time survey/response UX, plus a **finalization stage** that, at each `end_epoch`, obtains
  authoritative role+stake state (LSQ-at-close if continuously live; otherwise Koios or a
  from-genesis Yaci ledger-state run) and writes an **immutable, fully-auditable tally snapshot
  with its raw inputs**. This satisfies "light + reliable + fast" for serving while keeping the
  weighted result correct and reproducible — and it matches both the CIP's two-phase validation
  model and `GOAL.md`'s explicit allowance for a post-processing stage.
