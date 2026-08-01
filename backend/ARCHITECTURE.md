# Tessera Data & Tally Architecture — PoC Phase (Koios + Cloudflare)

> **Status:** decided design for the current proof-of-concept phase. Continues
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
- **Scalable.** Koios load is decoupled from user count (one server-side scan
  serves everyone, instead of every browser re-scanning).
- **Reproducible.** Anyone can re-run the whole setup with their own Cloudflare
  account _or_ self-host it without a Cloudflare account at all.
- **Tally-ready.** Produce per-role, stake-weighted survey results from Koios,
  with results published as immutable, independently re-verifiable artifacts.
- **Forward-compatible.** The Koios path is the first implementation of a seam;
  the future node+indexer is the second, with no change to the artifact format,
  the verifier, or the UI.

**Non-goals (this phase)**

- Trustless / authoritative result production (needs node + ledger replay — see
  `RESEARCH.md` §8). Weights here are Koios-sourced and trusted.
- Committee (CC) role weighting — **TODO**, deferred.
- SPO role end-to-end — specified but not exercised, because browser wallets
  can't produce SPO responses (see §6.1).
- Cross-provider weight cross-checking (Koios-only for now).

---

## 1. Today's state and the two defects

The frontend talks to Koios **directly from every browser**, on each load/refresh
running the full read pipeline (`src/data/koios.ts`): paged
`/tx_by_metalabel?_label=17`, batched `/tx_metadata`, one `/tx_cbor` pass for the
owner-proofs of open surveys and of the transactions cancelling them,
`/proposal_list` for governance links, `/tip`, and polled `/tx_status`.

1. **Security.** `VITE_KOIOS_TOKEN` is baked into the JS bundle — a shared
   credential visible to anyone, burnable against one quota. The anonymous tier
   is CORS-blocked, so today a client-side token is effectively mandatory.
2. **Scalability.** Koios load scales with _users × refreshes_, all on one quota,
   and each client re-scans the full label-17 history from `sinceUnix` with no
   shared cache — cost grows for every user as surveys accumulate, and the
   `MAX_PAGES` cap (`incomplete` flag) is a real ceiling.

The `DataSource` seam (`cardano-tessera-core`'s `source.ts`) was built for exactly this swap:
_"a future semantic indexer backend can implement the same interface and drop in
with no change to the domain or UI layers."_

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
- The tiers are decoupled by a **content-addressed tally artifact** (§7): the
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

| Layer                                                                                                   | Portable? | Notes                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core** (TS): chain-follow/decode + pure `cip-179` domain/tally (audit, tally) + tally-input gathering | yes       | No Cloudflare APIs. Runs in Worker, Node/Bun, or a CLI.                                                                                                  |
| **Storage**: repository interface over **SQL (SQLite dialect)**                                         | yes       | D1 _is_ SQLite. Self-host → libsql/better-sqlite3 (or Postgres). KV/Cache used **only** as an optional edge cache, never as the source of truth.         |
| **Runtime adapter**                                                                                     | thin      | CF: `wrangler.toml` + fetch handler + `[triggers] crons` + D1 binding. Self-host: tiny HTTP server + `node-cron`/loop + SQLite file. Both call **Core**. |
| **HTTP `/api` contract**                                                                                | yes       | What `IndexerDataSource` speaks. Identical whether served by a Worker or a process.                                                                      |

**Consequences**

- The **baseline reproducible artifact is a container/compose stack**; Cloudflare
  is _one_ managed deploy target for Tier 1, not a requirement.
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

---

## 4. Workspace packaging (prerequisite refactor)

Running the _same_ validation + tally code in the browser, the serving tier, and
a standalone verifier requires factoring the shared code out of the app. This is
load-bearing for the verifiability story, not just hygiene.

- **`cip-179`** — a pnpm-workspace package at `packages/cip179`, imported by
  name. It has since grown beyond the codec into the reusable, cross-implementation
  surface (subpath exports `cip-179/domain`, `cip-179/tally`, `cip-179/txproof`,
  `cip-179/tlock`, and the `cip-179/evolution` serialization adapter). The
  txproof/tlock stacks inject their Cardano-serialization primitives through
  `TxProofCodec` / `MetadatumCodec` ports, so evolution-sdk is confined to the
  adapter; see `packages/cip179/README.md`.
- **`cardano-tessera-core`** — extract the **pure** domain from `frontend/app/src`:
  - **Move:** the data-model **types** from `data/source.ts` (`ChainPos`,
    `ChainTip`, `SurveyRecord`, `ResponseRecord`, `CancellationRecord`,
    `Cip179Records`, `GovLink`, `CancellationProof`, `NativeScriptInfo`), and the
    pure logic: `audit.ts`, `tally.ts`, `survey.ts`, `cancellation.ts`,
    `answer.ts`, `govLink.ts`, `fee.ts`, plus `util/hex.ts`.
  - **Keep in the app:** anything touching CIP-30 / wallet (`roles.ts`'s
    wallet-facing helpers, `wallet/*`) or `~/config` runtime. `roles.ts` splits:
    the pure credential/eligibility core may move; the `WalletIdentity`-coupled
    helpers stay.
  - **Cut line:** _data-model types + pure validation/tally/aggregation →
    package; anything wallet/CIP-30/runtime → app._
- `cardano-tessera-core` is authored **BigInt- and rational-ready** from the outset
  (§6.6): the **weighted, content-addressed** tally (`weightedTally*` → the
  hashed artifact) uses BigInt aggregates and returns ratios as integer
  `{numerator, denominator}` pairs, never floats. Note this applies to the
  _hashed_ path only: `tally.ts` is the unweighted, count-based **display**
  tally (bar fill fractions, mean/median), which uses floats and is never
  hashed — a presentation helper that happens to live in the package.

`KoiosDataSource` (the concrete Koios reader) stays in the app/serving tier, not
in `cardano-tessera-core` — the package is pure logic + types only.

---

## 5. Read path (the snapshot)

Tier 1 reproduces today's read path server-side and caches it. The logic in
`src/data/koios.ts` is reused largely as-is (it already paginates, batches, and
degrades gracefully); it simply runs in the Worker/process behind the token
secret instead of in each browser.

- A **scheduled refresh** (Cron / loop) rebuilds the current label-17 snapshot
  (surveys, responses, cancellations, tip, governance links) into the SQL store.
  One run at a time, enforced by a lease row (`migrations/0008_refresh_lease.sql`):
  neither scheduler serializes itself — Cloudflare may start a cron while the
  previous one is still running, and the loop's interval fires regardless — and
  two concurrent runs would let the slower one write its older scan last. The
  lease is held for a bounded TTL so a run killed mid-flight, which never
  releases, blocks its successors only until it expires.
- The refresh stores the snapshot **materialized as rows** — one per survey
  (`survey_index`), one per response (`response`), plus a shared envelope
  (`snapshot_meta`: tip, incomplete flag, `fetchedAt`) — written in a single
  transaction, so the whole snapshot becomes visible at once and a reader never
  sees one run's rows beside another's. `fetchedAt` is the scan's **start**,
  the instant `tip` was read: the envelope then describes one point in time
  instead of straddling the run, and reported age never understates staleness
  by the run's duration.
- The serving endpoints read only the rows they serve (§5.1) plus that
  freshness stamp; `/tip` and `/tx_status` may stay live passthroughs for
  immediacy.
- Freshness target: snapshot is interval-old (e.g. 60–120s); acceptable for a
  survey app. The browser shows "updated Ns ago".

The browser's `IndexerDataSource` becomes "one bounded fetch per page" —
lighter client, faster load, no per-device paging/batching.

### 5.1 Phase 2: split the snapshot into per-page slices — DONE

The monolithic `GET /api/snapshot` shipped every response record to every
client, and `responses` is the one unbounded section (it grows with users ×
surveys; sealed responses each carry a tlock ciphertext blob). Phase 1
mitigated with compression + an `ETag` versioned by `fetchedAt` (304 between
refreshes); the real fix — **implemented, `/api/snapshot` is retired** — is to
serve what each page actually reads:

- **`GET /api/surveys`** — the Explore-list payload: survey records + tip +
  gov links + raw cancellations (tiny, and shipping them raw keeps cancellation
  proofs client-verifiable) + a server-computed **deduped** `responseCount` per
  survey, and the `fetchedAt`/`ageSeconds` stamp. Bounded regardless of
  participation. Also carries `finalizedCancelled` — the survey keys whose
  artifact finalized them as cancelled: the scan keeps `proof: null` for
  cancellations of closed surveys, so without this overlay the list would show
  a cancelled-then-closed survey as plain "Ended" while the artifact says
  cancelled. Derived from the stored artifact JSON at query time
  (`json_extract`), so no extra schema; the claim stays auditable against the
  served artifact itself.
- **`GET /api/surveys/{txHash}/{index}`** — the self-contained per-survey
  bundle: the definition record, **all** its `ResponseRecord`s (including sealed
  ciphertexts), the cancellations targeting it, and the tip. One request serves
  the detail/respond pages _and_ the standalone verifier — a survey result is
  re-verified from exactly this slice, so **the verifier never needs the full
  snapshot** (which is why `/api/snapshot` could be dropped outright once the
  app migrated). It also carries `verdicts` — the decided §6.3 rule-2 proof
  verdicts, keyed `"<txHash>:<responseIndex>"` — beside the chain data rather
  than inside it, for `finalizedCancelled`'s reason: the verifier re-derives
  `SurveyBundle` and must never read the serving tier's opinion as part of it.
  A key the map lacks is **pending, not failed**, and stays counted in the live
  tally (counting only what is proven would make every fresh response vanish
  until the next refresh decided it); only a decided `false` excludes, applied
  before latest-wins dedup.
- **`GET /api/responded?credentials=key:<hex>,script:<hex>`** — slim
  `[surveyKey]` projection so Explore can flag "surveys I answered" without
  downloading responses (the mapping is public on-chain data; it was the only
  reason the list view touched raw responses). Credentials travel in the core
  `credentialKey` form and several fit one request, since a wallet controls
  both a payment and a stake credential.
- **`GET /api/surveys/{txHash}/{index}/artifact`** and
  **`GET /api/artifacts/{hash}`** — the final tally artifact (§7) of a
  finalized survey, by ref or by content address. The stored JSON text is
  served **verbatim** (byte identity with the hash), with a strong
  `ETag: "<artifactHash>"` and `Cache-Control: public, max-age=31536000,
immutable`; 404 while the survey is open or not yet finalized.

How it landed (shared with Phase 2's tally work, which is why it waited):

- The **dedupe rule** (latest-valid-per-credential) lives in `cardano-tessera-core`
  (`dedupe.ts`: `refKey`/`credentialKey`/`dedupeResponses`/`responseCounts`),
  so the server's `responseCount` and the client's audit agree by construction.
- **Nothing is stored as a whole-snapshot document**
  (`migrations/0010_response_rows.sql`). Each route reads only the rows it
  serves: a survey bundle is one `survey_index` row plus that survey's
  `response` rows, and `/api/responded` is a `credential IN (…)` lookup. The
  store the routes used to share was a single JSON value, which had two
  ceilings — D1 caps one value at ~2,000,000 bytes (past that every refresh's
  write fails and the snapshot silently freezes at its last good state while
  validation and finalization stop advancing), and every request parsed the
  entire corpus, including padded sealed ciphertexts that grow with
  participation, inside a Worker's CPU and memory limits. Rows remove both; what
  a request costs now scales with the survey it asked for.
- The rows are **replaced wholesale** each refresh, in one transaction, because
  a record can leave the snapshot (reorged out, or aged past the scan's floor)
  and a merging write would keep serving it. `refresh_run.payload_bytes` records
  the total stored wire JSON as the growth metric behind the health footer.
- The frontend seam widened: `state.tsx`'s single eager resource became a list
  resource + a lazy per-survey bundle resource, and `DataSource` is now exactly
  `surveyList`/`surveyBundle`/`respondedKeys`/`txStatus` (`KoiosDataSource`
  implements the per-page methods by filtering one memoized full scan, so the
  direct/power-user path keeps working unchanged; its full-scan reads remain as
  concrete methods for the serving tier's refresh).

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
  action stays **unresolved** — unknown, not unlinked (finding 6).
- **A proposal's expiration epoch is in the future when it is proposed**, so
  once the tip reaches epoch X the set of proposals expiring at X is frozen and
  its link set can be decided once and for all (`gov_epoch`). A settled epoch
  leaves the query filter for good and its anchors leave the bank, which is what
  keeps the pass **O(active surveys)** instead of growing with all-time history.

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

Three different meters run on this backend, and each bounds a different set of
requests:

| Budget                | Metered by                 | Window         | Counts                       |
| --------------------- | -------------------------- | -------------- | ---------------------------- |
| Koios tier quota      | Koios, per token identity  | 24 h           | Koios requests on that token |
| Worker subrequest cap | Cloudflare, per invocation | one invocation | every outbound fetch         |
| Other service limits  | each upstream service      | 24 h           | requests to that service     |

So requests are counted by the budget they spend (`meter.ts`): `koios` for the
operator identity, `koios-passthrough` for the segregated identity behind
`/api/tx_status` (§ finding 15 — a separate account bucket, never summed into
the first), and `anchor` for governance documents on whatever host serves them.
One number covering all of them cannot be compared against any of these limits
without being wrong in one direction or the other.

The counts land in two places, because they answer two questions.
`refresh_run` carries the per-run totals — a per-_invocation_ cap needs a
per-invocation number, and when a run trips it, the Koios/anchor split is what
says which half spent it. `upstream_tally` carries five-minute buckets per kind,
summed over 24 h for the health footer; refresh runs drain into it at the end of
each pass, and the serving tier drains after each request, since `/api/tip` and
`/api/pparams` spend the operator's Koios quota outside any run and a total
summed from run rows alone would report that identity as quieter than it is.

What the footer reports without a limit to compare against is deliberate:
Koios's per-tier quota is account-side and not discoverable through the API
(hence `KOIOS_DAILY_LIMIT`, when the operator knows it), and no upstream service
publishes its number to us. The volume is still worth showing.

---

## 6. Tally model

### 6.1 Roles, weights, membership

Tallies and weighting are **always per-role; never combined** (the same ada would
otherwise be double-counted across a holder's stakeholder stake, their DRep's
voting power, and their pool's stake).

| Role            | Weight measure                   | Membership gate                                        | Browser-producible?          |
| --------------- | -------------------------------- | ------------------------------------------------------ | ---------------------------- |
| **Stakeholder** | active ada stake at `end_epoch`  | stake address **registered** at `end_epoch`            | yes                          |
| **DRep**        | DRep voting power at `end_epoch` | DRep **registered** at `end_epoch`                     | yes                          |
| **SPO**         | pool active stake at `end_epoch` | pool registered at `end_epoch`                         | **no** (specified, deferred) |
| **Keyholder**   | **count-only** (weight = 1)      | credential proof (already on-chain, client-verifiable) | yes                          |
| **CC**          | **TODO**                         | **TODO**                                               | no                           |

- **Membership = registration.** A Stakeholder/DRep response whose credential is
  **not registered** at `end_epoch` is **excluded as invalid** (it is not a
  member). A registered credential is counted with `weight = snapshot value`,
  which **may legitimately be 0** (registered but empty). There is no separate
  "weight-0 vs excluded" ambiguity: registration is the gate, the snapshot value
  is the weight.
- **Keyholder is count-only.** It is rendered as its own per-role result with each
  response contributing weight 1 — i.e. the unweighted path. (Uniform with the
  weighted path by passing weight = 1; see §6.6.)
- **SPO** is fully specified but not exercised: `roles.ts` establishes that
  browser wallets cannot hold SPO/CC keys, so the app cannot generate SPO
  responses. Wiring stays ready for non-browser responders / Tier 2.

### 6.2 Epoch semantics (the load-bearing definition)

> **Weight = the `active_stake` / voting power for the survey's `end_epoch`.**

- This is the **deadline snapshot**, not response-time stake. A responder who
  held stake mid-survey but moved it before `end_epoch` is weighted at their
  `end_epoch` value (possibly 0). Deliberate, matching governance snapshot
  semantics. This rule string is part of `ruleset_hash` (§7).
- **Row-freeze timing.** Koios per-epoch history freezes epoch `E`'s row once
  epoch `E` _begins_ (the latest row, for the next epoch, is the live-evolving
  value until the boundary). Finalization runs **after `end_epoch` closes**, so
  `E`'s row is always frozen and available — no estimation needed.
- **Sealed surveys** use **deadline weights**: freeze the `end_epoch` weights at
  close; compute the tally later, after the drand reveal, re-validating decrypted
  answers (`audit.ts` already separates sealed handling). The artifact records
  deadline weights even though it is emitted at reveal time.

### 6.3 Validation → the hashed counted set

The hashed `tally` (§7) is a pure function of _which responses count_ and _their
answer values_, so the validation ruleset **is** part of the hash preimage — a
verifier reproduces the hash only by applying it byte-for-byte, which is what
`rulesetHash` binds. This authoritative validation is distinct from the browser's
fast **approximate** pass (`audit.ts`: `epochOfSlot`-estimated deadline,
`(slot, txHash)` dedup) that drives the live UI but is _not_ authoritative for the
artifact; the serving tier produces the counted set below from ledger facts.

A response is **tally-valid** iff all of:

1. **On-time.** The response tx's block epoch ≤ `end_epoch` (inclusive, §6.2),
   read from the block's authoritative `epoch_no` (Koios) — _not_ the tip-relative
   `epochOfSlot` estimate, which can disagree at a boundary slot.
2. **Credential proof** (CIP-179 Mechanism A/B). Control of `credential` is proven
   by `required_signers` (field 14: key hash present, or native script resolved +
   satisfied) or by a `voting_procedures` entry binding it to `linked_action_id`.
   Unproven ⇒ excluded; without this the tally is forgeable (anyone could name
   another's credential). Needs the tx body + witnesses / native-script resolution
   (the `NativeScriptInfo` seam).
3. **Well-formed.** Passes `cip-179` `validateResponse` (mode, eligible-role claim,
   in-constraint answers, no duplicate/out-of-range indices, required answered).
   The **pinned validator version** is part of the ruleset.
4. **Member.** `credential` is **registered at `end_epoch`** (§6.1; inactive ⇒
   weight 0). Membership is checked **only** at `end_epoch` — response-time
   membership (CIP-179 phase 1) is presentation-only, a deliberate deviation.

**Dedup.** Among the tally-valid responses, one wins per
`(survey_ref, role, credential)` by CIP-179 chain order
**`(slot, tx_index_in_block, response_index)`** — a total order (no ties), latest
wins. Deduping over the _tally-valid_ set (not all responses) means an invalid
later response never suppresses a valid earlier one. This requires two read-model
fields the UI lacks — `tx_index_in_block` (Koios block tx index) and
`response_index` (payload array position); the UI's `(slot, txHash)` key is a
display approximation only.

**Validate early what can be validated early.** Rules 1–3 need only the response
transaction plus complementary network info — its block `epoch_no` (on-time), the
tx witnesses / `required_signers` and any native-script resolution (proof), and
the payload itself (well-formed) — all fixed once the tx is confirmed, well before
`end_epoch`. The serving tier should check and **persist** them incrementally as
responses land (e.g. during the read-path refresh, §5), not re-run them in a batch
at close. Only rule 4 (membership) and the weights (§6.5) need the `end_epoch`
snapshot, so finalization does just that boundary-bound work over the
already-validated responder set — flattening what would otherwise be a burst of tx
fetches, proof-checking, and CPU at epoch end (and the Koios rate-limiting it would
invite). Dedup's ordering fields (`slot`, `tx_index_in_block`, `response_index`)
are likewise known early; only the final winner can shift, since dedup runs over
the membership-filtered set.

**Sealed surveys.** The counted set is final only at reveal: decrypt, re-run
`validateResponse`, drop undecryptable/invalid. Deadline is by submission slot;
weights by `end_epoch`.

**Cancelled surveys.** An owner-verified, in-window cancellation ⇒ the survey
emits an artifact whose hashed body is a single **cancellation record** (cancelling
`txHash`, owner-proof reference, slot/epoch) and no per-role tally. Unverified
("claimed") cancellations are ignored.

### 6.4 Koios endpoints

| Purpose                       | Endpoint                                                                     | Shape                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stakeholder stake (per epoch) | `POST /account_stake_history?epoch_no=eq.E`                                  | **bulk** (many stake addresses) | exact, historical, queryable any time after `E`; one row per **pool-delegated** account — a registered account with no row counts with weight 0. (The similarly-named `/account_history` is the deprecated variant — don't use.)                                                                                                                                                                                                                                 |
| Stakeholder membership at `E` | `POST /account_update_history?epoch_no=lte.E`                                | **bulk**                        | registration/deregistration event rows; registered at `E` iff the last event in `absolute_slot` order isn't a deregistration. Read **newest-first and stopped** at the first page that settles an address, the rest re-asked as a narrower batch — only an account's newest slot decides, so a lifetime of registration churn costs no more than a single registration and never crowds out the batch it shares. (`/account_updates` is the deprecated variant.) |
| DRep voting power (per epoch) | `GET /drep_voting_power_history?_drep_id=…&epoch_no=eq.E`                    | one DRep per request            | exact; a row exists iff the DRep was registered at `E`. N = **distinct** responding DReps (small). NB: the endpoint's own `_epoch_no` parameter misbehaves for current epochs — use the PostgREST column filter (verified live).                                                                                                                                                                                                                                 |
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

### 6.5 The snapshotting system

The key efficiency rule: **aggregate by epoch, not by survey.**

- When epoch `E` closes, compute the **union of counted responder credentials
  across all surveys with `end_epoch = E`**, deduped per role. Overlapping
  credentials (a participant who answered several surveys closing at `E`) are
  fetched **once**.
- Persist a **shared snapshot** keyed `(epoch, role, credential) → {weight,
registered, provenance}`, plus per-`(epoch, role)` totals. This table is shared
  by every survey ending at `E`.
- **Finalization** (implemented in `backend/server/src/finalize.ts`, run at the
  end of every refresh): a survey is a candidate once `tip.epoch > end_epoch`
  **and** `now ≥ voteDeadlineUnix(end_epoch) + 600 s` (the margin absorbing
  Koios indexing lag / shallow reorg near the boundary) and it has no artifact
  row yet. Fill any missing snapshot rows from Koios, then emit each survey's
  artifact once complete: every counted responder has a weight row **and**
  every covered role has its electorate total (a flaky `/epoch_info` postpones
  emission to a later cron, never fails it).
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
- **Known caveat (PoC):** the refresh only scans transactions since the
  configured `SINCE` floor. A survey that ages out of that window before it
  closes never becomes a finalization candidate — acceptable at PoC scale;
  Tier 2's full index removes the window.

Store (SQLite/D1 — `migrations/0003_tally.sql`; the `migrations/` files are
the single schema source for both backends: D1 applies them via `wrangler d1
migrations apply`, the local node:sqlite database via `store-node.ts`'s
runner, which tracks applied files in a `schema_migration` table):

```sql
-- shared across all surveys ending at the same epoch; a row is written only
-- once fetched (complete), so "row exists" = "weight known" = resume cursor.
-- Insert-or-ignore: an artifact may already have been emitted from a stored
-- weight, so a row is never revised once written
weight_snapshot(
  epoch      INTEGER NOT NULL,
  role       INTEGER NOT NULL,          -- CIP-179 Role
  credential TEXT    NOT NULL,          -- core credentialKey form ("key:<hex>" | "script:<hex>")
  weight     TEXT    NOT NULL,          -- lovelace as decimal string ("1" per Keyholder)
  registered INTEGER NOT NULL,          -- 0/1 membership at `epoch`
  fetched_at INTEGER NOT NULL,          -- fill time (debug only; endpoint = f(role))
  PRIMARY KEY (epoch, role, credential)
);

epoch_totals(
  epoch INTEGER NOT NULL,
  role  INTEGER NOT NULL,
  total TEXT NOT NULL,                  -- decimal string
  endpoint TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (epoch, role)
);

-- one immutable row per survey, written once when end_epoch is finalized
tally_artifact(
  survey_key   TEXT PRIMARY KEY,
  end_epoch    INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL,          -- content address = H(canonical(tally)) (§7)
  artifact     TEXT NOT NULL,           -- the full {tally, provenance} JSON, served verbatim
  created_at   INTEGER NOT NULL
);
```

There is also `validated_response` (`migrations/0002_validated_responses.sql`):
the §6.3 rules 1–3 verdicts per `(tx_hash, response_index)`, filled
**incrementally during each snapshot refresh** — only never-seen keys cost the
`/tx_cbor` + `/tx_info` reads, so the steady state adds zero subrequests, and a
failed enrichment leaves NULLs that are retried on the next refresh.

And `tx_metadata_cache` (`migrations/0005_tx_metadata_cache.sql`): fetch-once
label-17 metadata per tx hash, making the snapshot scan itself resumable the
same way. A tx's metadata is immutable (content-addressed by its hash), so each
fulfilled `/tx_metadata` batch is banked as it completes and never re-fetched;
a refresh cut short by the Worker subrequest cap keeps the batches it fetched
and converges over successive crons. Snapshot membership still comes from each
run's fresh label-index scan, so rolled-back txs age out — their cache entries
just stop being requested.

Its twin `tx_proof_cache` (`migrations/0015_tx_proof_cache.sql`) banks the tx
**CBOR** behind every owner-proof and response proof, which an open survey would
otherwise re-fetch on every scan. The raw bytes are stored, never a decoded
proof: mechanism-A resolution merges scripts fetched by hash from the chain, and
a script absent today can be registered tomorrow, so a merged proof is only true
as of its fetch — decoding and merging therefore run per call. Only bytes Koios
actually returned are banked; a hash it returned no row for is a node that is
behind, not an answer.

This is the one cache here that is **evicted** (`proofCache.ts`), because its
rows are whole transactions and a proof stops being read once nothing can still
be decided from it. Once per refresh, after finalization, the sweep runs over
the table's own keys and keeps only what a _live_ survey still bears on — no
artifact yet **and** within 5 epochs of its end epoch. The artifact is the
normal exit; the epoch backstop covers surveys that never produce one (a
spec-invalid definition is untalliable, so finalization emits nothing for it).

Sweeping the cache rather than deriving a drop set from the records is what
keeps each run proportional to the _cache_ instead of to the survey archive: the
archive only grows, so a records-driven sweep would re-delete every historical
hash on every refresh until the batch outgrew what D1 accepts — at which point
eviction would start failing, silently, exactly when the cache first needed it.
Sweeping also collects transactions no record mentions any more, which nothing
else would claim. The keep set is re-derived every run rather than tracked, so a
run that dies before pruning loses nothing, and over-deleting only ever costs a
re-fetch.

### 6.6 Weighted tally computation (`cip-179/tally`)

Weighting is the mechanical generalization of the existing tally: **replace
"count 1 per responder" with "add the responder's weight."**

- Input is the **validated, deduped** `counted` set (§6.3) — joined to each
  responder's `weight` from the snapshot. Count-only roles (Keyholder) pass
  **weight = 1**, so a single uniform code path covers weighted and unweighted
  roles.
- **All aggregates are BigInt.** Lovelace sums exceed 2^53.
  - singleChoice / multiSelect / ranking-first-preference → `Σ weight` per option.
  - numericRange / rating / pointsAllocation → store the **rational as two
    integers**: `Σ(weightᵢ · valueᵢ)` and `Σ weightᵢ`.
- **No floats anywhere in the result.** Averages, percentages, and participation
  rates are derived by the **presentation layer** from the integer aggregates +
  the totals. This eliminates float canonicalization and makes the artifact hash
  stable across implementations.
- The function is pure and identical in browser, serving tier, and verifier.

---

## 7. Artifact format

The unit of result publication and the Koios→node seam.

- **Canonical JSON**, content-addressed by hash. Pinned (implemented in
  `cip-179/tally`'s `canonical.ts`, shared by emitter and verifier):
  `canonicalJson()` is a strict JCS-lite — keys sorted by UTF-16 code units, no
  whitespace, **safe integers only** (throws on floats/bigints/non-plain
  objects) — and the hash is **blake2b-256** of its UTF-8 bytes (the hash
  family everything on Cardano already uses). The hash is the artifact's
  identity.
- **Large integers as decimal strings.** JSON-the-format has no precision limit,
  but (a) JavaScript's `JSON.parse` coerces to lossy doubles and `JSON.stringify`
  throws on BigInt, and (b) the JCS canonicalization profile only covers
  IEEE-754 doubles. So lovelace, weights, and all aggregates are **decimal
  strings**; this dodges both and removes any dependency on consumers using a
  lossless parser.
- **Integer-only aggregates, no floats** (§6.6).
- **Deterministic ordering** (e.g. responders sorted by credential hex; options
  in definition order) so independent re-serialization reproduces the hash.

**Hash domain.** The document splits into a hashed inner `tally` and an unhashed
`provenance` envelope; `artifactHash = H(canonical(tally))`. The split is
structural (not a field denylist). Ledger-determined facts that any correct
re-derivation must reproduce go in `tally`; whatever records who read the ledger,
how, and when goes in `provenance`.

- **`tally` (hashed):** `rulesetHash`, `network`, `survey`, `sealed` (true iff
  the definition's submission mode is sealed — set on cancellation artifacts
  too), and per role: `role`, `total`, `responders` (`credential`, `weight`, and
  the counted answer's full on-chain coordinate `txHash` + `responseIndex` —
  unregistered responders are excluded rather than flagged, so no `registered`
  field; **sealed** responders additionally carry `answers`, their revealed
  answers in JSON-safe wire form, since the on-chain response is only a
  ciphertext and can't be rejoined), integer `questions` aggregates.
- **`provenance` (not hashed):** `source`, snapshot `fetchedAt`, per-role
  `endpoint`, and — for a sealed survey — `sealedReveal` (`chainHash`, `round`,
  and the drand `beacon` used), unhashed because the definition already pins
  `(chainHash, round)` and the beacon is independently fetchable + BLS-verifiable.

Excluding provenance is what lets Koios- and node-produced artifacts share one
hash when results are identical — keeping the Tier 1 → Tier 2 swap invisible to
the verifier (§2, §9).

Contents (sketch):

```jsonc
{
  // hashed:  artifactHash = H(canonical(tally))
  "tally": {
    "rulesetHash": "...", // binds §6.3 validation ruleset + epoch semantics + role→measure + pinned cip-179 validator
    "network": "mainnet",
    "survey": { "txId": "...", "index": 0, "endEpoch": 642 },
    "sealed": false, // true iff sealed submission mode; reveal context in provenance
    "perRole": [
      {
        "role": 1, // CIP-179 Role
        "total": "12345678901234", // epoch total for this role (denominator; presentation decides use)
        "responders": [
          {
            "credential": "…",
            "weight": "1000000000",
            "txHash": "…",
            "responseIndex": 0, // position in the tx's label-17 payload
            // sealed surveys only: the revealed answers in JSON-safe wire form
            // (bytes→hex, bigint→decimal string, Map→tagged pairs sorted by the
            // canonical JSON of the tagged key), e.g.
            // "answers": [{ "type": "singleChoice", "questionIndex": 0, "optionIndex": 1 }]
          },
          // unregistered responders are excluded, not listed here
        ],
        "questions": [
          /* BigInt-string aggregates + {numerator,denominator} ratios */
        ],
      },
    ],
  },
  // NOT hashed: provenance envelope
  "provenance": {
    "source": {
      "provider": "koios",
      "baseUrl": "https://api.koios.rest/api/v1",
    },
    "fetchedAt": 0,
    "byRole": [
      { "role": 1, "endpoint": "/account_stake_history" },
      // fallback-estimated weights, if any: "estimated": [ "<cred>", … ]
    ],
    // sealed surveys only: the reveal context an offline auditor re-checks.
    // "sealedReveal": {
    //   "chainHash": "52db9ba7…c84e971", // quicknet
    //   "round": 19000000,
    //   "beacon": { "round": 19000000, "randomness": "…", "signature": "…" },
    // },
  },
}
```

- **Immutable** once `end_epoch` is finalized. **Stored in the D1/SQLite
  `tally_artifact` table** (deliberate deviation from the original R2 sketch:
  artifacts are small JSON documents, the store already exists on both
  runtimes, and one storage system beats two at PoC scale — R2 remains an easy
  later move since rows are keyed by the same content hash). Served verbatim by
  the two artifact routes (§5.1).
- The **frontend can pin the identical bytes to IPFS** (reusing
  `enrichment/pin.ts`) for durability / censorship-resistance; same bytes → same
  hash → same id.
- **Future:** the `tally` hash is the natural handle for an **on-chain anchor**,
  closing the loop with CIP-179 itself.
- **Verifiability.** The `tally` embeds the counted responders, their answers (or
  refs), weights, and totals, so any third party re-runs the pure `cip-179/tally`
  computation and reproduces both the results and the hash; every weight is re-fetchable
  from Koios at `end_epoch`. Trust reduces to Koios's stake numbers for epoch E,
  which the node tier later removes — without changing this format.

---

## 8. Frontend integration

- New **`IndexerDataSource`** (HTTP) behind the existing `DataSource`. Swapped in
  via the existing seam in `state.tsx`; `KoiosDataSource` is retained as the
  direct/power-user/offline path (and the user-token override keeps working
  against it).
- Results UI consumes artifacts — **implemented**: `DataSource` grew
  `artifact(ref)` (`IndexerDataSource` maps the route's 404 to null;
  `KoiosDataSource` always answers null, so direct mode keeps the raw tally).
  The survey page fetches it lazily for closed/cancelled surveys and renders a
  **final weighted results** view — per-role sections, stake-weighted bars,
  turnout against the embedded totals — with a toggle back to the raw
  per-credential tally. Every float (bar fractions, means, percentages) is
  derived presentation-side from the integer aggregates
  (`frontend/app/src/domain/artifactView.ts`).
- The existing "no weighting applied / out of scope" disclaimer is replaced (in
  the weighted view; the raw view keeps it) by an honest **provenance + trust**
  note: weights are Koios-sourced at `end_epoch`, re-verifiable, not yet
  trustless — plus the artifact's content hash.
- **The browser reads the serving tier's proof verdicts (§5.1) instead of
  re-deriving them.** A complete in-browser audit was considered and rejected:
  ≈40 Koios requests per survey view (dominated by one GET per DRep), per
  visitor, with no place to bank them across page loads — and it would be a
  second implementation of `packages/verifier`, which already _is_ the complete
  Koios-based audit. Evaluating only the contested subset was rejected in the
  same breath: an audit deserves more care than the claim it checks, not less.
- **Standalone verifier** — implemented as the workspace package
  `packages/verifier` (`cardano-tessera-verifier`):
  `pnpm --filter cardano-tessera-verifier verify -- --backend <url> --survey
<txHash>:<index>`. It fetches the bundle + artifact from the backend, refetches
  every verification input straight from Koios (tx proofs, block indices,
  weights, membership, totals, governance links), re-runs the pinned ruleset
  via the same `cardano-tessera-core` code, and compares content hashes —
  `MATCH`/`MISMATCH` (with a diff), exit 0/1. It never reads the backend's
  validation tables; a total the upstream can't re-serve is taken from the
  artifact with an explicit "not independently confirmed" note.

---

## 9. Trust & honesty

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

---

## 10. Phasing

1. **Phase 1 — security + scale + packaging.**
   - Promote `cip-179` to a workspace package; extract `cardano-tessera-core`
     (BigInt/rational-ready).
   - Stand up Tier 1 serving (read path moved server-side; token as
     secret/anonymous; SQL snapshot cache; Cron refresh). Frontend swaps to
     `IndexerDataSource`.
   - Reproducible via `wrangler` **and** a container/compose. No node required.
2. **Phase 2 — Koios tally inputs + artifacts.**
   - ~~`TallyInputSource` (Koios impl): per-epoch shared snapshot (§6.5).~~
     **Done** — `packages/koios/src/tallyInputs.ts` + `finalize.ts`.
   - ~~Weighted per-role tally in `cip-179/tally` (§6.6).~~ **Done** —
     `weightedTally.ts` (+ §6.3 rules 1–3 in `proof.ts`/`audit.ts`/`dedupe.ts`,
     persisted incrementally in `validated_response`).
   - Content-addressed artifacts (§7 — in D1, not R2; **done**); optional IPFS
     pin from the frontend; standalone verifier reusing `cardano-tessera-core`.
   - ~~Split `/api/snapshot` into per-page slices (§5.1): `/api/surveys` list,
     per-survey bundle (also the verifier's input — it never needs the full
     snapshot), `/api/responded` projection; then retire `/api/snapshot`.~~
     **Done** — the three per-page routes serve everything; `/api/snapshot`
     is removed.
3. **Phase 3 — node + indexer (post-PoC, `RESEARCH.md`).**
   - Tier 2 implements the same `TallyInputSource` and emits the same artifact.
     The Koios→node swap is invisible to the verifier and UI.

---

## 11. Open items / TODO

- **CC (committee) role** — weighting + membership semantics. Deferred
  (artifacts pin covered roles {DRep, Stakeholder, Keyholder} in their ruleset).
- **SPO role** — specified, not exercised until non-browser responders / Tier 2.
- ~~**Exact Koios shapes**~~ — resolved empirically; see the §6.4 table (incl.
  the deprecated-variant and `_epoch_no` pitfalls and `/epoch_info` flakiness).
- ~~**Credential-proof verification** (§6.3 rule 2)~~ — **done**: mechanism A/B
  evaluated in `cip-179/domain`'s `proof.ts` over `TxProof` evidence decoded by
  `packages/cip179/src/txproof/txProof.ts` (voting_procedures shape pinned by real
  preview vote-tx fixtures); verdicts persisted per response (§6.5).
- ~~**Credential encodings**~~ — **done**: `packages/cip179/src/evolution/index.ts`
  (`stakeAddress` / `drepId` / `govActionId`, behind the `TxProofCodec` port) (§6.4).
- ~~**Canonicalization profile**~~ — **done**: `cip-179/tally` `canonical.ts`
  (JCS-lite + decimal-string bigints + blake2b-256), used by emitter and
  verifier (§7).
- ~~**Finalization safety margin**~~ — chosen: 600 s past the `end_epoch`
  boundary (§6.5).
- ~~**Sealed-survey artifact emission**~~ — **done**: once the definition's
  drand round publishes, finalization decrypts every in-window response
  (server-side, one BLS-verified `fetchBeacon` per survey per pass), runs
  reveal→validate→dedup (`auditRevealedResponses`), and emits a `sealed=true`
  artifact committing each responder's revealed answers plus the reveal beacon
  in provenance (§6.5, §7). The verifier re-reveals with its own beacon.
  Non-quicknet sealed surveys are unsupported and skipped (no artifact).
- **End-to-end closure of the paths chain timing has never exercised** — sealed
  reveal against real sealed responses, mechanism-B (governance-vote) proof, and
  DRep/Stakeholder weights and totals are implemented and unit-tested, but no
  live survey has yet driven them from response to artifact. Preview survey
  `e34f46df3410f1e21e25067076fd3129a254c49afee7e3cec8185b3cd42e28b8#0` was
  created to close them and answered from two Stakeholder credentials; it
  expires 2026-08-04, after which re-verifying it with `packages/verifier` is
  the check.
- **On-chain anchor** of the artifact hash — future, closes the CIP-179 loop.
- **Two-network split** (mainnet/preview) — resolved: wrangler environments
  (`backend/server/wrangler.toml` — top-level is preview, `[env.mainnet]` its
  own D1 + vars), two deployments of one Worker, no network path segment. The
  frontend mirrors this: **one network per frontend deployment** (`VITE_NETWORK`
  - `VITE_INDEXER_URL`, no runtime switch), cross-linked via
    `VITE_OTHER_NETWORK_URL`, and `IndexerDataSource` verifies the backend's
    network against `/health` so a misconfigured pairing fails loudly instead of
    mixing networks.
