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
