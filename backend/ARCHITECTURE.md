# Tessera Data & Tally Architecture — PoC Phase (Koios + Cloudflare)

> **Status:** decided design for the current proof-of-concept phase, and a
> running one — the serving tier, the per-page routes, the per-epoch weight
> snapshot, the weighted tally and content-addressed artifacts are all live, with
> the standalone verifier re-deriving them from Koios independently. Continues
> `RESEARCH.md` §9 ("the indexer choice is secondary to the state strategy") by
> committing to the _light, Koios-backed_ corner of the trilemma now, and
> deferring the trustless node+indexer until after the app is validated with
> users. Nothing here is trustless; weights come from Koios (an oracle). The
> design's job is to **go as far as possible without a node** while staying
> **reproducible, self-hostable, and forward-compatible** with the eventual
> node+indexer — which drops in behind the same seams and produces the _same
> artifact format_.

---

## 0. Goals and non-goals

**Goals**

- **Secure by default.** No shared Koios token shipped in client code.
- **Scalable on both axes.** Koios load is decoupled from user count — one
  server-side scan serves everyone, instead of every browser re-scanning — and
  from corpus age: **no per-refresh or per-request cost may grow with the size
  of the archive.** Every predicate over all of history gets a banked frontier
  that retires the settled part of it. That invariant is why the refresh walks a
  window rather than rebuilding (§5.4), why governance links settle by epoch
  (§5.2), and why finalization and the proof cache carry frontiers of their own
  (§6.2); it is the standard those sections are held to.
- **Reproducible.** Anyone can re-run the whole setup with their own Cloudflare
  account _or_ self-host it without a Cloudflare account at all.
- **Tally-ready.** Produce per-role, stake-weighted survey results from Koios,
  with results published as immutable, independently re-verifiable artifacts.
- **Forward-compatible.** The Koios path is the first implementation of a seam;
  the future node+indexer (`RESEARCH.md`) is the second, implementing the same
  `TallyInputSource` and emitting the same artifact, so the swap is invisible to
  the verifier and the UI. The constraint that places on everything here is
  already in force: nothing may be built in a way that assumes Koios is the only
  possible provenance.

**Non-goals (this phase)**

- Trustless / authoritative result production (needs node + ledger replay — see
  `RESEARCH.md` §8). Weights here are Koios-sourced and trusted.
- Committee (CC) role weighting — **TODO**, deferred.
- SPO role end-to-end — specified but not exercised, because browser wallets
  can't produce SPO responses (see `TALLY-SPEC.md` §1).
- Cross-provider weight cross-checking (Koios-only for now).

---

## 1. Why the serving tier exists

The frontend originally read Koios **directly from every browser**, running the
full label-17 pipeline on each load. Two structural defects forced the move
server-side. **Security:** Koios's anonymous tier is CORS-blocked, so a
client-side token is effectively mandatory, and any token shipped with an app is
visible to everyone and burnable against one quota. **Scalability:** load scaled
with _users × refreshes_ against that quota, each client re-scanning all of
history with no shared cache and a hard page ceiling.

The `DataSource` seam (`cardano-tessera-core`'s `source.ts`) was built for
exactly this swap. The direct path survives as the power-user/offline mode (§7);
it is no longer what the app does by default.

---

## 2. Architecture: two tiers meeting at an artifact

```
                        ┌─────────────────────────────────────────────┐
  Browser (SolidJS) ────┤ Tier 1 — SERVING (light)                    │
   IndexerDataSource    │  CF Worker  *or*  Node/Bun container         │
   (HTTP, same-origin)  │   • read path (label-17 snapshot, tip, …)   │
        ▲               │   • tally-input snapshotting (Koios)         │
        │ artifact +    │   • serves snapshot + tally artifacts        │
        │ snapshot      │   • token = server secret / anonymous tier   │
        │               └───────────────┬─────────────────────────────┘
        │                               │ Koios REST (server-side, no CORS)
        │                               ▼
        │                         api.koios.rest
        │
        │   (post-PoC) Tier 2 — AUTHORITY (heavy): cardano-node + Adder/Yaci
        │   indexer + snapshot-at-close. Implements the SAME TallyInputSource
        └── seam and emits the SAME artifact format. See RESEARCH.md.
```

- **Tier 1 (this spec)** is the existing read path moved server-side, plus a
  Koios-backed tally-input snapshotting system. It is light enough to run on a
  stateless edge runtime (Cloudflare Workers) **or** as a plain process.
- **Tier 2 (deferred)** is the node-following indexer from `RESEARCH.md`. It
  **cannot** be a Worker (no node, no LocalStateQuery, no long-running
  chainsync). It replaces Koios as the `TallyInputSource` when it lands.
- The tiers are decoupled by a **content-addressed tally artifact** (`TALLY-SPEC.md` §5): the
  unit of result publication and the seam across the Koios→node swap.
- **Two Koios identities.** The critical path (snapshot refresh, response
  validation, artifact finalization) and the short-cached `tip`/`pparams`
  passthroughs use the operator's `KOIOS_TOKEN`. The uncached `/api/tx_status`
  comfort passthrough (browser confirmation polling) uses a **separate**
  `KOIOS_PASSTHROUGH_TOKEN`, default unauthenticated — so a flood of that public
  endpoint can only exhaust its own quota, never the one artifact correctness
  depends on. See `backend/server/.env.example`.

### Two seams

- **`DataSource`** (exists) — reads CIP-179 records + chain tip. Implementations:
  `KoiosDataSource` (direct, kept as power-user/offline path) and a new
  `IndexerDataSource` (HTTP to Tier 1).
- **`TallyInputSource`** (new) — _given a survey at its `end_epoch`, return each
  counted responder's weight + membership._ Implementations: `KoiosTallyInputs`
  (this spec) and, later, the node+indexer. Everything downstream (artifact,
  pure tally, verifier, UI) is provenance-agnostic.

---

## 3. Reproducibility & deployment model

The two constraints — "anyone can re-run on their own Cloudflare account" **and**
"self-hostable without much effort" — are reconciled by **layering**: a portable
core, a thin swappable runtime/storage adapter, and a portable HTTP contract.

| Layer                                                                                                   | Portable? | Notes                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core** (TS): chain-follow/decode + pure `cip-179` domain/tally (audit, tally) + tally-input gathering | yes       | No Cloudflare APIs. Runs in Worker, Node/Bun, or a CLI.                                                                                                                                                                                                  |
| **Storage**: repository interface over **SQL (SQLite dialect)**                                         | yes       | One `BackendStore` (`store-sql.ts`) over a four-method `SqlDriver`; a runtime supplies only the driver. D1 _is_ SQLite. Self-host → libsql/better-sqlite3 (or Postgres). KV/Cache used **only** as an optional edge cache, never as the source of truth. |
| **Runtime adapter**                                                                                     | thin      | CF: `wrangler.toml` + fetch handler + `[triggers] crons` + D1 binding. Self-host: tiny HTTP server + `node-cron`/loop + SQLite file. Both call **Core**.                                                                                                 |
| **HTTP `/api` contract**                                                                                | yes       | What `IndexerDataSource` speaks. Identical whether served by a Worker or a process.                                                                                                                                                                      |

**Consequences**

- Cloudflare is _one_ managed deploy target for Tier 1, not a requirement: the
  same server already runs as a plain process against a `node:sqlite` file
  (`pnpm start`), with no Cloudflare account. Packaging that process as a
  container/compose stack is the intended baseline artifact and is **not built
  yet**.
- Substrate is **SQL/SQLite**, the most portable Cloudflare primitive (vs KV,
  which is the least). Avoid Durable Objects in the core path; if used later for
  live push, treat as a CF-only enhancement.
- **Token handling:** the Koios token becomes a server secret
  (`wrangler secret put` / env var). Because server-side `fetch` is not
  CORS-bound, Tier 1 may even use Koios's **anonymous tier with no token** — so
  there is, by default, _no shared secret to leak_. A token remains optional for
  rate headroom.
- The existing **user-token override is preserved** as the direct
  `KoiosDataSource` path (decentralization escape hatch / "verify against chain
  directly"). The serving tier is an addition, not a removal.
- **One deployment serves exactly one network.** Each backend and frontend parses
  its network strictly at startup — no path segment, no runtime switch — and
  `IndexerDataSource` verifies its backend against `/health`, so a misconfigured
  pairing fails loudly instead of quietly mixing two chains' data. This is not
  fastidiousness: preview and preprod both report CIP-30 network id 0, so wallet
  selection cannot tell them apart, while their Koios hosts, storage, explorers
  and transaction-builder chain parameters are all different.

---

## 4. Workspace packaging

Running the _same_ validation and tally code in the browser, the serving tier and
a standalone verifier is load-bearing for the verifiability story, not hygiene.
Two cut lines, in this order — _reusable CIP-179 semantics_ before
_Tessera-specific but pure_ before _concrete I/O and runtime_:

- **`cip-179`** (`packages/cip179`) — everything a second, independent
  implementation of the CIP would need: the codec, plus the pure domain
  (`cip-179/domain`: on-chain record shapes, `audit`, `dedupe`, `proof`,
  `survey`, `govLink`), the weighted tally and its canonical content-addressed
  artifact (`cip-179/tally`), `cip-179/content`, `cip-179/txproof`,
  `cip-179/tlock`, and the `cip-179/evolution` serialization adapter. The
  txproof/tlock stacks inject their Cardano-serialization primitives through
  `TxProofCodec` / `MetadatumCodec` ports, so evolution-sdk is confined to that
  adapter; see `packages/cip179/README.md`.
- **`cardano-tessera-core`** (`packages/core`) — the Tessera seam and nothing
  else: the `DataSource` read interface with the Explore-list and health payload
  shapes (`source.ts`), keyset paging (`page.ts`), the list-aggregation adapter
  (`surveyList.ts`), portable config. It imports the `cip-179` subpaths and
  never re-exports them, so no consumer can reach reusable semantics _through_
  Tessera.
- **`cardano-tessera-koios`** (`packages/koios`) — the concrete Koios reader and
  tally inputs. Outside the pure packages, shared by the browser's direct path
  and the serving tier's refresh.
- **The app** keeps everything touching CIP-30, wallet, or `~/config` runtime —
  including `domain/results.ts`, which turns the integer aggregates into the
  floats a chart needs. It does not tally: a pre-artifact ("live") result is
  `weightedTally*` run with every weight `1n`, so there is one set of counting
  rules, not a display copy of them.

The hashed path is **BigInt- and rational-ready** by construction (`TALLY-SPEC.md` §4):
`weightedTally*` aggregates in BigInt and returns ratios as integer
`{numerator, denominator}` pairs, never floats, so canonicalization has no
float profile to pin and the artifact hash is stable across implementations.

---

## 5. Read path (the snapshot)

Tier 1 reproduces the browser's read path server-side and stores it. The Koios
reader itself is shared code (`packages/koios`), so the same paging, batching and
graceful degradation runs in the Worker/process behind the token secret as in the
direct browser path — the difference is that the backend walks the index in
resumable slot segments and keeps what it derived (§5.4), while the browser
re-scans from the floor on every load.

- A **scheduled refresh** (Cron / loop) integrates one _slot segment_ of the
  label-17 index into the SQL store — the stored rows are the durable truth for
  settled history, and each run re-derives only what can still move (§5.4).
  One run at a time, enforced by a lease row (`migrations/0008_refresh_lease.sql`):
  neither scheduler serializes itself — Cloudflare may start a cron while the
  previous one is still running, and the loop's interval fires regardless — and
  two concurrent runs would let the slower one write its older scan last. The
  lease is held for a bounded TTL so a run killed mid-flight, which never
  releases, blocks its successors only until it expires.
- The store holds the corpus **materialized as rows** — one per survey
  (`survey_index`), one per response (`response`), one per cancellation
  (`cancellation`), plus a shared envelope (`snapshot_meta`: tip, incomplete
  flag, `fetchedAt`). A run's upserts, its slot-range deletions and the envelope
  are committed in one transaction, so a reader never sees half of one segment's
  integration. `fetchedAt` is the scan's **start**, the instant `tip` was read:
  the envelope then describes one point in time instead of straddling the run,
  and reported age never understates staleness by the run's duration.
- The serving endpoints read only the rows they serve (§5.1) plus that freshness
  stamp. Three routes stay Koios passthroughs, each cached by how fast its answer
  can actually change: `/api/tip` is memoized for seconds, `/api/pparams` is keyed
  by the stored snapshot's epoch (protocol parameters are fixed within one), and
  `/api/tx_status` is uncached by nature — it exists to watch a specific
  transaction land. Keying pparams on _this tier's_ epoch rather than on a fresh
  `/tip` read is what makes the cache free, and it buys that with one refresh
  interval of staleness across an epoch boundary: a transaction built in that
  window against changed fee parameters is rejected at submit — loudly, and
  retryable.
- Freshness target: the snapshot is one cron interval old (`*/3`, so ≤180 s),
  acceptable for a survey app. The browser shows "updated Ns ago".

The browser's `IndexerDataSource` becomes "one bounded fetch per page" —
lighter client, faster load, no per-device paging/batching.

### 5.1 One route per page-shaped read

`responses` is the one unbounded section of the corpus — it grows with users ×
surveys, and each sealed response carries a tlock ciphertext blob — so no route
ships it wholesale. Each serves what one page actually reads, out of the rows the
refresh materialized, and a request costs what the survey it asked for costs:

- **`GET /api/surveys`** — the Explore list, **keyset-paginated**
  (`filter`/`q`/`cursor`/`limit`): survey records, tip, governance links, raw
  cancellations (tiny, and raw keeps their owner-proofs client-verifiable), a
  server-computed **deduped** `responseCount` per survey, and the
  `fetchedAt`/`ageSeconds` stamp. Ordering, filters and counts are the core
  `pageSurveyList` spec implemented in SQL, so the direct-Koios path pages the
  same list in memory by the same rule. Chip counts are global over the matching
  set rather than per page: banked in the envelope at refresh time
  (`migrations/0017_list_counts.sql`), aggregated live only when a search narrows
  the set. A cursor carries the snapshot generation it was minted against, and one
  from an older generation is still answered — with `resync` set, so the client
  silently refreshes page one, since rows may have crossed the cursor boundary
  when their bucket changed. The payload also carries `finalizedCancelled`, the
  survey keys whose artifact finalized them as cancelled: the scan keeps
  `proof: null` for cancellations of closed surveys, so without that overlay a
  cancelled-then-closed survey would read as plain "Ended" while its artifact says
  cancelled. The claim stays auditable against the served artifact.
- **`GET /api/surveys/{txHash}/{index}`** — the self-contained per-survey bundle:
  the definition record, **all** its `ResponseRecord`s (sealed ciphertexts
  included), the cancellations targeting it, and the tip. One request serves the
  detail/respond pages _and_ the standalone verifier — a result is re-verified
  from exactly this slice, so **the verifier never needs the whole corpus**. It
  also carries `verdicts`, the decided `TALLY-SPEC.md` §3 rule-2 proof verdicts keyed
  `"<txHash>:<responseIndex>"` — beside the chain data, never inside it, because
  the verifier re-derives `SurveyBundle` and must not read the serving tier's
  opinion as part of it. A key the map lacks is **pending, not failed**, and stays
  counted in the live tally (counting only what is proven would make every fresh
  response vanish until a refresh decided it); only a decided `false` excludes,
  applied before latest-wins dedup.
- **`GET /api/responded?credentials=key:<hex>,script:<hex>`** — a slim
  `[surveyKey]` projection, so Explore can flag "surveys I answered" without
  downloading responses; the mapping is public on-chain data. Credentials travel
  in the core `credentialKey` form, and several fit one request since a wallet
  controls both a payment and a stake credential.
- **`GET /api/surveys/{txHash}/{index}/artifact`** and
  **`GET /api/artifacts/{hash}`** — the final tally artifact (`TALLY-SPEC.md` §5), by ref or by
  content address. The stored JSON text is served **verbatim** (byte identity with
  the hash), with a strong `ETag: "<artifactHash>"` and
  `Cache-Control: public, max-age=31536000, immutable`; 404 while the survey is
  open or not yet finalized.

The **dedupe rule** behind `responseCount` is the shared one
(`cip-179/domain`'s `dedupe.ts`, latest-valid-per-credential), so the server's
count and the client's audit agree by construction rather than by review.

### 5.2 Governance links: verified anchors, settled epochs

A CIP-179 survey link lives in a governance action's CIP-108 anchor document,
which the action commits to on-chain by hash. The refresh **dereferences that
anchor itself** and checks the bytes against the committed hash
(`cip-179/content`), rather than reading an indexer's own off-chain resolution:
a parsed document handed over by an indexer can never be re-verified against the
hash it came from, and on preview roughly 70% of expired proposals have an
anchor db-sync permanently gave up fetching. So the scan
(`/proposal_list?select=proposal_id,expiration,meta_url,meta_hash`) reads only
on-chain columns — small, immutable, identical across nodes.

Two on-chain facts bound the work (`backend/server/src/govLinks.ts`):

- **An anchor is hash-fixed**, so one verified fetch classifies a document
  permanently. Classifications are banked by anchor hash (`gov_anchor`) and
  never re-fetched — including verified _non_-links, which are as final as
  links. A fetch _failure_ is banked nowhere: it is absence of evidence, and the
  action stays **unresolved** — unknown, not unlinked.
- **A proposal's expiration epoch is in the future when it is proposed**, so
  once the tip reaches epoch X the set of proposals expiring at X is frozen and
  its link set can be decided once and for all (`gov_epoch`). A settled epoch
  leaves the query filter for good and its anchors leave the bank, which is what
  keeps the pass **O(active surveys)** instead of growing with all-time history.
  The filter is a banked **settlement floor** — the lowest expiration not yet
  settled, kept on the scan-state row — rather than a fixed `tipEpoch − K`
  horizon: a deployment down for longer than K would otherwise let unsettled
  epochs fall out under the horizon and never settle them, stamping those
  surveys' artifacts with whatever partial links the last refresh saw. Below the
  floor a survey's own `gov_links` slice **is** the frozen answer, so
  integration, validation and finalization read links from the rows they were
  projected into instead of re-deriving them.

Settlement waits for every anchor at the epoch, but not forever: after one epoch
of patience it settles with the links it has and records the rest as given up.
That bound is load-bearing, not tidiness — validation holds a bindable response's
verdict at "unknown" while an epoch-aligned action is unresolved, and
finalization postpones on any unknown verdict, so one permanently dead anchor
would otherwise postpone that survey's artifact forever.

The direct-Koios path resolves the same anchors the same way, but with no place
to bank them (each page load is a fresh context), so it runs the whole
resolution under one wall-clock budget and publishes what resolved.

### 5.3 Upstream metering: one counter per budget

Three meters run on this backend, each bounding a different set of requests:

| Budget                | Metered by                 | Window         | Counts                       |
| --------------------- | -------------------------- | -------------- | ---------------------------- |
| Koios tier quota      | Koios, per token identity  | 24 h           | Koios requests on that token |
| Worker subrequest cap | Cloudflare, per invocation | one invocation | every outbound fetch         |
| Other service limits  | each upstream service      | 24 h           | requests to that service     |

So requests are counted by the budget they spend (`meter.ts`): `koios` for the
operator identity, `koios-passthrough` for the segregated identity behind
`/api/tx_status` (a separate account bucket, never summed into the first), and
`anchor` for governance documents on whatever host serves them. One number
covering all three cannot be compared against any of these limits without being
wrong in one direction or the other.

Per-run totals live on `refresh_run`, because a per-_invocation_ cap needs a
per-invocation number and the Koios/anchor split is what says which half spent
it. The rolling 24 h totals (`upstream_tally`) are drained by the serving tier as
well as by refresh runs: `/api/tip` and `/api/pparams` spend the operator's Koios
quota outside any run, so a total summed from run rows alone would report that
identity as quieter than it is.

The footer reports volume with no limit to compare against, deliberately: Koios's
per-tier quota is account-side and not discoverable through the API (hence
`KOIOS_DAILY_LIMIT`, when the operator knows it), and no upstream service
publishes its number to us.

### 5.4 The windowed refresh: one segment per run

A refresh that re-derives the whole corpus every cron violates §0's invariant
five ways at once, and hits a hard wall at 5,000 transactions where the listing
truncates and every snapshot is permanently `incomplete`. What it buys is that
_any_ divergence between stored rows and chain truth self-corrects within one
cron. Decomposed, that divergence splits three ways:

- **chain-caused** — rollbacks removing or repositioning a tx, indexer lag and
  backfill, this app's own truncated scans. Continuous, but nothing deeper than
  the stability window (36 h on mainnet/preprod) can roll back;
- **event-caused** — a deploy that changes derivation, a restore, manual
  surgery, an upstream data correction. Rare and observable;
- **not healed by a rebuild either** — an out-of-band `validated_response`
  deletion, a mutated `tally_artifact` row.

Only the first class is why the scan runs continuously, and it is bounded by
_settlement_, not by corpus age. That is the whole design.

**The segment walker.** Banked state lives on one row (`scan_state`): the main
cursor (the last `(slot, tx_hash)` whose segment is fully integrated), whether
that walk was caught up, the derivation generation, the trickle cursor, and the
two frontiers (§5.2, §6.2). Every refresh integrates one segment:

- **steady state** — `[cursor − SETTLEMENT_MARGIN, tip]`, listed ascending by
  `(absolute_slot, tx_hash)`, normally one page. The margin is ~3 days
  (259,200 slots), about twice the stability window, one constant for all
  networks;
- **catch-up** — after downtime or a rewind, the same walk capped at a page
  budget per run; the cursor advances to the last fully covered slot and the next
  cron continues from the pair. Serving keeps the existing rows meanwhile;
- **generation rewind** — the deployed code carries a generation constant, and a
  mismatch with the banked one resets the cursor to the config floor so the
  ordinary walker re-derives everything forward. This is the escape hatch for a
  deploy that changes how records project into rows;
- **trickle rescan** — a caught-up run additionally spends one listing page
  re-deriving a page of the _settled prefix_, rotating oldest→newest and wrapping.
  Integration is idempotent, so a row that never moved changes nothing and a
  nonzero change count _is_ the drift signal. This is what heals the
  event-caused class without operator discipline, in ~corpus/100 refreshes.

Integration is **idempotent re-derivation**, never a delta: list the segment,
fetch the metadata it is missing (keyed by hash, chunked), classify, then
reconcile that slot range. A survey is _touched_ — its projection rebuilt from
scratch, every aggregate recomputed over stored rows merged with the segment's
records — when the segment carries its definition or something targeting it, when
a stored response/cancellation in the swept range is about to vanish, when its
governance link set differs from the stored one, or when its verified-while-open
cancellation expired at close. Sweep bounds exclude uncovered boundary slots: a
keyset continuation never sweeps the cursor's own slot (rows at-or-before the
cursor hash were not re-listed) and a budget-capped walk stops one slot below its
last listed one (that slot may hold further unlisted txs). A failed page or a
dropped metadata batch flags the envelope `incomplete`, banks no cursor and
sweeps nothing — an unfetched tx is indistinguishable from a vanished one.

A settled survey row can still change, and every cause has a bounded driver:

| change                              | driver                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| response / cancellation arrives     | segment tx targeting it → touched-survey re-projection                                  |
| response / cancellation rolls back  | segment sweep removes it → same re-projection                                           |
| open → closed                       | nothing — computed at query time from `end_epoch` vs tip                                |
| governance links resolve or settle  | the pass's epoch set (§5.2) → link-change diff → touched                                |
| `finalized_cancelled` overlay flips | this run's finalization → one idempotent targeted UPDATE                                |
| banked chip counts move             | any run that changed rows, flipped the overlay, or crossed an epoch → one SQL aggregate |

**What is traded away.** Retroactive semantics changes stop being free: a deploy
that changes derivation must bump the generation, or old rows keep the old
derivation until the trickle passes them. Silent corruption or a restore heals
via rewind or trickle rather than within three minutes. And the all-in-memory
purity of the full rebuild is gone — that is the real complexity cost. The
mitigation is that the pure rebuild is **kept as a test oracle**: differential
tests replay seeded-random event sequences (new txs, rollbacks, link changes,
epoch turnover, overlays) through segment integration and assert the rows stay
identical to what a from-scratch rebuild would produce, after every step.

### 5.5 What the refresh banks

Three tables exist so that a later run never redoes work an earlier one
finished — the growth invariant applied to storage rather than to queries.

- **`validated_response`** (`migrations/0002`) — the `TALLY-SPEC.md` §3 rules 1–3
  verdicts per `(tx_hash, response_index)`, filled incrementally as responses
  land. A completed verdict is re-judged only when what it was decided against
  has moved, so the steady state adds no subrequests; a failed enrichment leaves
  NULLs the next refresh retries.
- **`tx_metadata_cache`** (`migrations/0005`) — fetch-once label-17 metadata per
  tx hash. Metadata is immutable, so each fulfilled batch is banked as it
  completes and a refresh cut short by the subrequest cap keeps what it fetched.
  Corpus membership comes from the label-index listing, not from this cache: a
  rolled-back transaction is swept out of the rows by the segment that no longer
  lists it, and its cache entry simply stops being requested.
- **`tx_proof_cache`** (`migrations/0015`) — the transaction CBOR behind every
  owner and response proof, which an open survey would otherwise re-fetch on
  every scan. Raw bytes only, never a decoded proof: mechanism-A resolution
  merges scripts fetched by hash, and a script absent today can be registered
  tomorrow, so a merged proof is true only as of its fetch. A hash Koios returned
  no row for is a node that is behind, not an answer, and is banked as nothing.

`tx_proof_cache` is the one that is **evicted** (`proofCache.ts`): its rows are
whole transactions, and a proof stops being read once nothing can still be decided
from it. The sweep runs over the _cache's own keys_, keeping what a live survey
still bears on — bounded by the open set, where a drop set derived from the
records would be bounded by the archive and so re-delete every dead hash on every
refresh. Over-deleting only ever costs a re-fetch; under-deleting is the permanent
mistake.

---

## 6. Tally inputs and finalization (Koios)

**What a correct result _is_ — roles and their weight measures, epoch semantics,
the validation ruleset, the weighted computation, and the artifact format — is
`TALLY-SPEC.md`.** It is provenance-agnostic and pinned by `rulesetHash`, so it
survives the Tier 1 → Tier 2 swap unchanged. This section is the other half: how
_this_ deployment obtains those inputs from Koios and when it does the work.

### 6.1 Koios endpoints

| Purpose                       | Endpoint                                                                     | Shape                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stakeholder stake (per epoch) | `POST /account_stake_history?epoch_no=eq.E`                                  | **bulk** (many stake addresses) | exact, historical, queryable any time after `E`; one row per **pool-delegated** account — a registered account with no row counts with weight 0. (The similarly-named `/account_history` is the deprecated variant — don't use.)                                                                                                                                                                                                                                 |
| Stakeholder membership at `E` | `POST /account_update_history?epoch_no=lte.E`                                | **bulk**                        | registration/deregistration event rows; registered at `E` iff the last event in `absolute_slot` order isn't a deregistration. Read **newest-first and stopped** at the first page that settles an address, the rest re-asked as a narrower batch — only an account's newest slot decides, so a lifetime of registration churn costs no more than a single registration and never crowds out the batch it shares. (`/account_updates` is the deprecated variant.) |
| DRep voting power (per epoch) | `GET /drep_voting_power_history?_epoch_no=E&epoch_no=eq.E&drep_id=in.(…)`    | **bulk** (many DRep ids)        | exact; a row per DRep registered at `E`, an absent id = not registered (derived by set difference). Chunked at 50 ids (~3 KB URL), verified live to return amounts byte-identical to the single-`_drep_id` form. Both epoch filters: `_epoch_no` bounds the server-side query, and the PostgREST column filter guards against its known misbehaviour for current epochs.                                                                                         |
| SPO pool stake (per epoch)    | `GET /pool_voting_power_history` (exact) or bulk `POST /pool_info` (current) | —                               | deferred; not browser-producible.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Stakeholder total             | `GET /epoch_info`                                                            | per epoch                       | total active stake denominator. **Flaky**: some (preview) epochs answer db-sync `word128` errors — treated as "unavailable, retry next cron", never fatal.                                                                                                                                                                                                                                                                                                       |
| DRep total                    | `GET /drep_epoch_summary`                                                    | per epoch                       | total DRep voting power denominator.                                                                                                                                                                                                                                                                                                                                                                                                                             |

- **Totals** (`/epoch_info`, `/drep_epoch_summary`) are O(1) per epoch, fetched
  once, and **distributed with the artifact**. What to do with them (participation
  rate, % of stake, etc.) is a **presentation** responsibility — the tally itself
  does not bake in a denominator.
- **Provenance** is recorded coarsely, not per weight: `source` once at the top
  level, `endpoint` per role, one snapshot `fetched_at`. Per-credential rows would
  be redundant (`epoch` = `end_epoch`, `endpoint` = f(role)); only
  fallback-estimated weights, if any, need a per-credential note.
- **Batch caps:** bulk POSTs have per-request element limits (cf. the existing
  `TX_METADATA_BATCH = 50` in `koios.ts`); chunk accordingly. At PoC scale this
  is a handful of batches in one invocation.
- **Encodings** — resolved: thin wrappers over evolution-sdk in the
  `cip-179/evolution` adapter (`packages/cip179/src/evolution/index.ts`, no
  hand-rolled bech32), exposed through the `TxProofCodec` port: `stakeAddress`
  (CIP-19 headers, key **and** script credentials, both networks), `drepId`
  (CIP-129 `drep1…`), `govActionId` (CIP-129 `gov_action1…`) — each verified
  against ids Koios itself emits.

### 6.2 The snapshotting system

The key efficiency rule: **aggregate by epoch, not by survey.**

- When epoch `E` closes, compute the **union of counted responder credentials
  across all surveys with `end_epoch = E`**, deduped per role. Overlapping
  credentials (a participant who answered several surveys closing at `E`) are
  fetched **once**.
- Persist a **shared snapshot** keyed `(epoch, role, credential) → {weight,
registered, provenance}`, plus per-`(epoch, role)` totals. This table is shared
  by every survey ending at `E`.
- **Finalization** (implemented in `backend/server/src/finalize.ts`, run at the
  end of every refresh): a survey is a candidate once `tip.epoch > end_epoch`,
  it has no artifact row yet, and **the integrated prefix has covered its vote
  deadline plus 600 s** — the reorg margin, measured on the chain the scan has
  actually banked rather than on the wall clock, so a survey whose window a
  catch-up has not reached yet cannot finalize early. Its governance epoch must
  also be settled (§5.2): an artifact's provenance is immutable, so it may only
  ever commit a link set that can no longer move. Fill any missing snapshot rows
  from Koios, then emit each survey's artifact once complete: every counted
  responder has a weight row **and** every covered role has its electorate total
  (a flaky `/epoch_info` postpones emission to a later cron, never fails it).
- **The candidate read has its own frontier.** "Closed, no artifact yet" is a
  predicate over the whole archive, so it is bounded by a banked **finalization
  floor** — the lowest end epoch still holding a survey the pass expects to
  decide — kept beside the settlement floor on the scan-state row, with the
  artifact anti-join scoped to the same bound. A survey the pass declares
  permanently untalliable (spec-invalid definition, unproven owner credential,
  a sealed survey on an unsupported drand chain) counts as _decided_ and stops
  holding the floor down: without that, one junk label-17 transaction would pin
  it at its epoch forever. The consequence is that such a survey is never looked
  at again — a generation rewind, which resets the floor to 0, is the way back.
- **Sealed surveys** freeze weights the same way (the credential union is
  identical pre- and post-dedup, so the deadline snapshot is correct), then add
  a reveal step: emission waits until the definition's drand round has published
  (`roundIsAvailable`), decrypts the **pre-dedup** in-window set (one
  BLS-verified `fetchBeacon` per survey), runs reveal→validate→dedup, and emits a
  `sealed=true` artifact. A transient reveal failure postpones (never aborts)
  the pass; a non-quicknet sealed survey is skipped forever (no artifact).
- **Reveal is bounded by Worker CPU, not by subrequests.** One
  `decryptWithBeacon` measures ~20 ms on workerd, against the 30 s a cron under
  an hour apart gets on the paid plan (`limits.cpu_ms` cannot raise that; the
  free plan's 10 ms cannot fit a single decrypt). A pass therefore spends at most
  `MAX_SEALED_DECRYPTS_PER_PASS` decryptions across all surveys — and `sealed_reveal`
  is the cursor that makes that a pacing limit rather than a size limit: each
  ciphertext's outcome (the decrypted response, or NULL for one that didn't
  decrypt or decode) is written as it is produced, so a survey larger than the
  budget finishes over several passes instead of never. Determinism comes from
  the definition pinning the round and drand beacons being immutable: the same
  beacon, re-fetched and re-verified each pass, yields the same plaintext. The
  beacon the artifact commits is the one from the emitting pass, which is why
  that pass calls reveal even when it has nothing left to decrypt.
- **Execution.** At PoC scale (stakeholders bulk; DReps small-N single-GET) this
  fits a single Worker invocation. The `(epoch, role, credential)` table **is**
  the resume cursor if it ever doesn't: rows are written only once known, so a
  run cut short (Worker subrequest cap) just resumes next cron — fill missing
  weights idempotently, emit artifacts when complete (INSERT-OR-IGNORE), no
  separate job orchestration.
- **Known caveat (PoC):** the configured `SINCE` floor is where a walk from
  nothing starts — a fresh database, or a generation rewind. Rows above it are
  durable once integrated (§5.4), so nothing "ages out" of the corpus any more,
  but a survey defined before the floor is not in it to begin with and never
  becomes a finalization candidate. Tier 2's full index removes the floor.

The `migrations/` files are the single schema source for both backends — D1
applies them via `wrangler d1 migrations apply`, the local node:sqlite database
via `store-node.ts`'s runner, which tracks applied files in a `schema_migration`
table. Three tables carry the tally state (`migrations/0003_tally.sql`), each
enforcing one rule:

- **`weight_snapshot`**, keyed `(epoch, role, credential)` — shared by every
  survey ending at that epoch. A row is written only once **fetched**, so "row
  exists" = "weight known" = the resume cursor; and it is never revised once
  written (insert-or-ignore), because an artifact may already have been emitted
  from it. Weights are lovelace as decimal strings, `1` for Keyholder.
- **`epoch_totals`**, keyed `(epoch, role)` — the electorate denominator, decimal
  strings again, recorded with the endpoint it came from.
- **`tally_artifact`**, one immutable row per survey, written once at
  finalization: the content hash (`TALLY-SPEC.md` §5) and the full `{tally, provenance}` JSON,
  stored as the text that is served verbatim.

---

## 7. Frontend integration

`IndexerDataSource` (HTTP) sits behind the existing `DataSource` seam;
`KoiosDataSource` is retained as the direct/power-user/offline path, and the
user-token override keeps working against it. The survey page fetches an
artifact lazily for closed and cancelled surveys and renders the weighted
result, deriving every float presentation-side from the integer aggregates
(`frontend/app/src/domain/results.ts`). Two decisions are worth recording:

- **The browser reads the serving tier's proof verdicts (§5.1) rather than
  re-deriving them.** A complete in-browser audit costs ≈40 Koios requests per
  survey view, dominated by one GET per DRep, per visitor, with nowhere to bank
  them across page loads — and it would be a second implementation of
  `packages/verifier`, which already _is_ the complete Koios-based audit.
  Evaluating only the contested subset was rejected in the same breath: an audit
  deserves more care than the claim it checks, not less.
- **The weighted view states provenance instead of disclaiming it.** Where the
  raw view still says "no weighting applied", the artifact view says weights are
  Koios-sourced at `end_epoch`, re-verifiable, and not yet trustless — with the
  content hash beside it.

The **standalone verifier** is the workspace package `packages/verifier`. It
fetches the bundle and artifact from a backend, refetches every verification
input straight from Koios, re-runs the pinned ruleset through the same shared
code, and compares content hashes — `MATCH`/`MISMATCH` with a diff, exit 0/1. It
never reads the backend's validation tables, and a total the upstream cannot
re-serve is taken from the artifact with an explicit "not independently
confirmed" note.

---

## 8. Trust & honesty

- **Metadata and proofs are trust-minimized** (self-contained in tx CBOR,
  client-re-verifiable — survey definitions, responses, definition and
  cancellation owner-proofs)
  and stay that way.
- **Weights are an oracle dependency.** A credential's stake = Σ(ada in every UTxO
  under that credential) + rewards, snapshotted at an epoch boundary — there is no
  certificate-only shortcut (`RESEARCH.md` §8.1). Koios (db-sync-backed) is the
  pragmatic oracle, and crucially it _retains epoch history_ that a live node
  cannot serve (`RESEARCH.md` §7.2) — so on the historical axis Koios is not a
  downgrade from a bare node, only a different trust basis.
- The honest framing in the UI: results are **reproducible** (anyone re-runs the
  tally and matches the hash) but **trusted** (the weights' provenance is Koios).
  The node+indexer phase upgrades provenance to authoritative without changing the
  artifact, verifier, or UI.
- **What none of this claims**, each easy for a surface built on it to overstate:
  a **sealed** response delays answer disclosure and is not anonymous — role and
  credential are in clear on-chain from submission, and only the answers are
  timelocked; a **governance link** is a discovery relation, not evidence that the
  action's proposer and the survey's owner are the same party; a response is
  authenticated by its carrying transaction and never by a login session; and the
  artifact format and its ruleset are a **Tessera profile**, not part of CIP-179,
  which leaves weighting and aggregation out of scope deliberately.

---

## 9. Open items / TODO

- **CC (committee) role** — weighting + membership semantics. Deferred
  (artifacts pin covered roles {DRep, Stakeholder, Keyholder} in their ruleset).
- **SPO role** — specified, not exercised until non-browser responders / Tier 2.
- **End-to-end closure of the paths chain timing has not yet exercised** — the
  preprod fixtures recorded in `interop/` have driven public and sealed
  Stakeholder surveys from response to artifact (a sealed reveal and its
  provenance included), but no live survey has yet exercised DRep weights or
  mechanism-B (governance-vote) proof, both implemented and unit-tested. Both
  need a DRep-eligible fixture, since every fixture so far admits Stakeholder
  only, and its epoch must pass before finalization can be measured.
- **Full-text search** — `/api/surveys?q=` matches `haystack LIKE` against every
  survey row, so it is the one per-request cost that still grows with the archive,
  and the one place §0's invariant does not hold. Deliberate for now: the banked
  chip counts already cover the no-`q` case, which is the common one, and an index
  (FTS5 or equivalent) is a design of its own. Trigger: search traffic heavy
  enough to show up in `d1 insights`.
- **A reusable `<tessera-results>` element** — result rendering is app-internal
  (`domain/results.ts`, `ui/results/`), so a host that embeds `<tessera-respond>` has
  no matching way to show the outcome, and re-implementing seven question methods,
  per-role separation and provenance disclosure is exactly the fork the widget
  seam exists to prevent. Until it exists, the honest MVP for a host is a compact
  summary plus a deep link, not a partial renderer that silently mishandles the
  methods it does not cover.
- **Container/compose packaging** — the self-hostable process runs (§3); the
  reproducible image and stack around it are not built.
- **Optional IPFS pin of the artifact bytes** from the frontend, reusing
  `enrichment/pin.ts` — same bytes, same hash, same id (`TALLY-SPEC.md` §5).
- **On-chain anchor** of the artifact hash — future, closes the CIP-179 loop.

---

## 10. Weighed and rejected

Cheaper-looking alternatives that were measured or reasoned through and turned
down. They are recorded because each is the obvious next idea, and re-deriving
the reason costs more than reading it.

- **A slower cron on preview** (`*/10` rather than `*/3`) — roughly 70% off that
  deployment's entire upstream and D1 bill, for no code. Rejected by the operator:
  preview exists for rapid prototyping and needs the three-minute feedback loop.
  The cadence is `*/3` on every network.
- **ETag by content digest instead of `fetchedAt`** — would let an unchanged
  corpus answer 304 across refresh generations, but the body legitimately carries
  `fetchedAt`/`ageSeconds` and `IndexerDataSource` reads them, so it is an API
  contract change bought with a transfer win. The 304 path already costs one row.
- **Edge-caching `/api/surveys` with `s-maxage`** — the rows may change at any
  refresh, so `no-cache` plus ETag revalidation is already the right shape;
  artifacts, the one response worth caching hard, are already `immutable`.
- **A whole-snapshot blob for serving** — a regression of migrations 0009→0010,
  which moved to rows precisely so the list could be paged and filtered in SQL.
- **Dropping the `response_credential` index** to cut write amplification — it
  serves `/api/responded`, and an ignored-conflict insert bills nothing, so the
  amplification only ever taxes genuinely new data.
- **Replacing the refresh lease with a Durable Object, or simply not releasing
  it** — the lease is three rows a run and is the whole overlap-correctness
  mechanism; leaving it held would stretch the effective cadence to its TTL. A
  platform dependency for pennies.
- **Workers Analytics Engine for `refresh_run` / `upstream_tally`** —
  `/api/health` would then need the Analytics SQL API (a token, eventual
  consistency, a new dependency) to serve numbers D1 already gives it for about
  two writes a run.
- **Shrinking `OPERATIONAL_RETENTION_SECONDS`** to lighten the health scan — that
  scan is bounded by its 24 h predicate on the primary key, not by table size.
  Retention moves storage only; it is not a read lever.
- **D1 read replicas** — a latency feature. Rows bill the same either way.
