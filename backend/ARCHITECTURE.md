# Tessera Data & Tally Architecture — PoC Phase (Koios + Cloudflare)

> **Status:** decided design for the current proof-of-concept phase. Continues
> `RESEARCH.md` §9 ("the indexer choice is secondary to the state strategy") by
> committing to the *light, Koios-backed* corner of the trilemma now, and
> deferring the trustless node+indexer until after the app is validated with
> users. Nothing here is trustless; weights come from Koios (an oracle). The
> design's job is to **go as far as possible without a node** while staying
> **reproducible, self-hostable, and forward-compatible** with the eventual
> node+indexer — which drops in behind the same seams and produces the *same
> artifact format*.

---

## 0. Goals and non-goals

**Goals**

- **Secure by default.** No shared Koios token shipped in client code.
- **Scalable.** Koios load is decoupled from user count (one server-side scan
  serves everyone, instead of every browser re-scanning).
- **Reproducible.** Anyone can re-run the whole setup with their own Cloudflare
  account *or* self-host it without a Cloudflare account at all.
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
`/tx_by_metalabel?_label=17`, batched `/tx_metadata`, `/tx_cbor` for cancellation
proofs, `/proposal_list` for governance links, `/tip`, and polled `/tx_status`.

1. **Security.** `VITE_KOIOS_TOKEN` is baked into the JS bundle — a shared
   credential visible to anyone, burnable against one quota. The anonymous tier
   is CORS-blocked, so today a client-side token is effectively mandatory.
2. **Scalability.** Koios load scales with *users × refreshes*, all on one quota,
   and each client re-scans the full label-17 history from `sinceUnix` with no
   shared cache — cost grows for every user as surveys accumulate, and the
   `MAX_PAGES` cap (`incomplete` flag) is a real ceiling.

The `DataSource` seam (`src/data/source.ts`) was built for exactly this swap:
*"a future semantic indexer backend can implement the same interface and drop in
with no change to the domain or UI layers."*

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

### Two seams

- **`DataSource`** (exists) — reads CIP-179 records + chain tip. Implementations:
  `KoiosDataSource` (direct, kept as power-user/offline path) and a new
  `IndexerDataSource` (HTTP to Tier 1).
- **`TallyInputSource`** (new) — *given a survey at its `end_epoch`, return each
  counted responder's weight + membership.* Implementations: `KoiosTallyInputs`
  (this spec) and, later, the node+indexer. Everything downstream (artifact,
  pure tally, verifier, UI) is provenance-agnostic.

---

## 3. Reproducibility & deployment model

The two constraints — "anyone can re-run on their own Cloudflare account" **and**
"self-hostable without much effort" — are reconciled by **layering**: a portable
core, a thin swappable runtime/storage adapter, and a portable HTTP contract.

| Layer | Portable? | Notes |
|---|---|---|
| **Core** (TS): chain-follow/decode + pure `@tessera/core` (audit, tally) + tally-input gathering | yes | No Cloudflare APIs. Runs in Worker, Node/Bun, or a CLI. |
| **Storage**: repository interface over **SQL (SQLite dialect)** | yes | D1 *is* SQLite. Self-host → libsql/better-sqlite3 (or Postgres). KV/Cache used **only** as an optional edge cache, never as the source of truth. |
| **Runtime adapter** | thin | CF: `wrangler.toml` + fetch handler + `[triggers] crons` + D1 binding. Self-host: tiny HTTP server + `node-cron`/loop + SQLite file. Both call **Core**. |
| **HTTP `/api` contract** | yes | What `IndexerDataSource` speaks. Identical whether served by a Worker or a process. |

**Consequences**

- The **baseline reproducible artifact is a container/compose stack**; Cloudflare
  is *one* managed deploy target for Tier 1, not a requirement.
- Substrate is **SQL/SQLite**, the most portable Cloudflare primitive (vs KV,
  which is the least). Avoid Durable Objects in the core path; if used later for
  live push, treat as a CF-only enhancement.
- **Token handling:** the Koios token becomes a server secret
  (`wrangler secret put` / env var). Because server-side `fetch` is not
  CORS-bound, Tier 1 may even use Koios's **anonymous tier with no token** — so
  there is, by default, *no shared secret to leak*. A token remains optional for
  rate headroom.
- The existing **user-token override is preserved** as the direct
  `KoiosDataSource` path (decentralization escape hatch / "verify against chain
  directly"). The serving tier is an addition, not a removal.

---

## 4. Workspace packaging (prerequisite refactor)

Running the *same* validation + tally code in the browser, the serving tier, and
a standalone verifier requires factoring the shared code out of the app. This is
load-bearing for the verifiability story, not just hygiene.

- **`cip-179`** — already a directory with its own `package.json`
  (`frontend/cip179`), today consumed via a Vite/tsconfig path alias
  (`../cip179/src/index.ts`). Promote it to a real pnpm-workspace package imported
  by name. Low risk.
- **`@tessera/core`** — extract the **pure** domain from `frontend/app/src`:
  - **Move:** the data-model **types** from `data/source.ts` (`ChainPos`,
    `ChainTip`, `SurveyRecord`, `ResponseRecord`, `CancellationRecord`,
    `Cip179Records`, `GovLink`, `CancellationProof`, `NativeScriptInfo`), and the
    pure logic: `audit.ts`, `tally.ts`, `survey.ts`, `cancellation.ts`,
    `answer.ts`, `govLink.ts`, `fee.ts`, plus `util/hex.ts`.
  - **Keep in the app:** anything touching CIP-30 / wallet (`roles.ts`'s
    wallet-facing helpers, `wallet/*`) or `~/config` runtime. `roles.ts` splits:
    the pure credential/eligibility core may move; the `WalletIdentity`-coupled
    helpers stay.
  - **Cut line:** *data-model types + pure validation/tally/aggregation →
    package; anything wallet/CIP-30/runtime → app.*
- `@tessera/core` is authored **BigInt- and rational-ready** from the outset
  (§6.6): weighted aggregates are BigInt; ratios are returned as integer
  `{numerator, denominator}` pairs, never floats.

`KoiosDataSource` (the concrete Koios reader) stays in the app/serving tier, not
in `@tessera/core` — the package is pure logic + types only.

---

## 5. Read path (the snapshot)

Tier 1 reproduces today's read path server-side and caches it. The logic in
`src/data/koios.ts` is reused largely as-is (it already paginates, batches, and
degrades gracefully); it simply runs in the Worker/process behind the token
secret instead of in each browser.

- A **scheduled refresh** (Cron / loop) rebuilds the current label-17 snapshot
  (surveys, responses, cancellations, tip, governance links) into the SQL store.
- The serving endpoint returns the cached snapshot (`GET /api/snapshot`) plus a
  freshness stamp; `/tip` and `/tx_status` may stay live passthroughs for
  immediacy.
- Freshness target: snapshot is interval-old (e.g. 60–120s); acceptable for a
  survey app. The browser shows "updated Ns ago".

The browser's `IndexerDataSource` becomes "fetch one snapshot" — lighter client,
faster load, no per-device paging/batching.

---

## 6. Tally model

### 6.1 Roles, weights, membership

Tallies and weighting are **always per-role; never combined** (the same ada would
otherwise be double-counted across a holder's stakeholder stake, their DRep's
voting power, and their pool's stake).

| Role | Weight measure | Membership gate | Browser-producible? |
|---|---|---|---|
| **Stakeholder** | active ada stake at `end_epoch` | stake address **registered** at `end_epoch` | yes |
| **DRep** | DRep voting power at `end_epoch` | DRep **registered** at `end_epoch` | yes |
| **SPO** | pool active stake at `end_epoch` | pool registered at `end_epoch` | **no** (specified, deferred) |
| **Owner** | **count-only** (weight = 1) | owner-proof (already on-chain, client-verifiable) | yes |
| **CC** | **TODO** | **TODO** | no |

- **Membership = registration.** A Stakeholder/DRep response whose credential is
  **not registered** at `end_epoch` is **excluded as invalid** (it is not a
  member). A registered credential is counted with `weight = snapshot value`,
  which **may legitimately be 0** (registered but empty). There is no separate
  "weight-0 vs excluded" ambiguity: registration is the gate, the snapshot value
  is the weight.
- **Owner is count-only.** It is rendered as its own per-role result with each
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
  epoch `E` *begins* (the latest row, for the next epoch, is the live-evolving
  value until the boundary). Finalization runs **after `end_epoch` closes**, so
  `E`'s row is always frozen and available — no estimation needed.
- **Sealed surveys** use **deadline weights**: freeze the `end_epoch` weights at
  close; compute the tally later, after the drand reveal, re-validating decrypted
  answers (`audit.ts` already separates sealed handling). The artifact records
  deadline weights even though it is emitted at reveal time.

### 6.3 Validation → the hashed counted set

The hashed `tally` (§7) is a pure function of *which responses count* and *their
answer values*, so the validation ruleset **is** part of the hash preimage — a
verifier reproduces the hash only by applying it byte-for-byte, which is what
`rulesetHash` binds. This authoritative validation is distinct from the browser's
fast **approximate** pass (`audit.ts`: `epochOfSlot`-estimated deadline,
`(slot, txHash)` dedup) that drives the live UI but is *not* authoritative for the
artifact; the serving tier produces the counted set below from ledger facts.

A response is **tally-valid** iff all of:

1. **On-time.** The response tx's block epoch ≤ `end_epoch` (inclusive, §6.2),
   read from the block's authoritative `epoch_no` (Koios) — *not* the tip-relative
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
wins. Deduping over the *tally-valid* set (not all responses) means an invalid
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

| Purpose | Endpoint | Shape | Notes |
|---|---|---|---|
| Stakeholder stake (per epoch) | `POST /account_stake_history` | **bulk** (many stake addresses) | exact, historical, queryable any time after `E`. |
| DRep voting power (per epoch) | `GET /drep_voting_power_history` | one DRep per request | exact; N = **distinct** responding DReps (small). Chosen over the bulk-but-current `/drep_info` estimate: exact, lazy, re-derivable, and no boundary-timing job. `/drep_info` kept only as a fallback if a history row is missing. |
| SPO pool stake (per epoch) | `GET /pool_voting_power_history` (exact) or bulk `POST /pool_info` (current) | — | deferred; not browser-producible. |
| Stakeholder total | `GET /epoch_info` | per epoch | total active stake denominator. |
| DRep total | `GET /drep_epoch_summary` | per epoch | total DRep voting power denominator. |

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
- **Encodings to verify at build:** stake-credential → bech32 stake address must
  handle **script** stake credentials, not just keys; DRep credential → the
  `drep_id` format Koios expects (CIP-129 `drep1…`).

### 6.5 The snapshotting system

The key efficiency rule: **aggregate by epoch, not by survey.**

- When epoch `E` closes, compute the **union of counted responder credentials
  across all surveys with `end_epoch = E`**, deduped per role. Overlapping
  credentials (a participant who answered several surveys closing at `E`) are
  fetched **once**.
- Persist a **shared snapshot** keyed `(epoch, role, credential) → {weight,
  registered, provenance}`, plus per-`(epoch, role)` totals. This table is shared
  by every survey ending at `E`.
- **Finalization** (after `end_epoch` + a small safety margin (5 min?) for Koios indexing
  lag / shallow reorg near the boundary): fill any missing snapshot rows from
  Koios, then emit each survey's artifact once all its responders' weights are
  present.
- **Execution.** At PoC scale (stakeholders bulk; DReps small-N single-GET) this
  fits a single Worker invocation. The `(epoch, role, credential)` table **is**
  the resume cursor if it ever doesn't: fill missing weights idempotently, emit
  artifacts when complete — no separate job orchestration.

Suggested store (SQLite/D1):

```sql
-- shared across all surveys ending at the same epoch
weight_snapshot(
  epoch      INTEGER NOT NULL,
  role       INTEGER NOT NULL,          -- CIP-179 Role
  credential TEXT    NOT NULL,          -- hex (stake cred / drep id / pool id)
  weight     TEXT,                      -- lovelace as decimal string; NULL until fetched
  registered INTEGER,                   -- 0/1 membership at `epoch`; NULL until fetched
  fetched_at INTEGER,                   -- fill time (debug/resume only; endpoint = f(role))
  PRIMARY KEY (epoch, role, credential)
);

epoch_totals(
  epoch INTEGER NOT NULL,
  role  INTEGER NOT NULL,
  total TEXT NOT NULL,                  -- decimal string
  endpoint TEXT, fetched_at INTEGER,
  PRIMARY KEY (epoch, role)
);

-- one immutable row per survey, written once when end_epoch is finalized
tally_artifact(
  survey_key   TEXT PRIMARY KEY,
  end_epoch    INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL,          -- content address = H(canonical(tally)) (§7)
  artifact     TEXT NOT NULL,           -- the full {tally, provenance} JSON
  created_at   INTEGER NOT NULL
);
```

### 6.6 Weighted tally computation (`@tessera/core`)

Weighting is the mechanical generalization of the existing tally: **replace
"count 1 per responder" with "add the responder's weight."**

- Input is the **validated, deduped** `counted` set (§6.3) — joined to each
  responder's `weight` from the snapshot. Count-only roles (Owner) pass
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

- **Canonical JSON**, content-addressed by hash (e.g. RFC 8785 / JCS profile,
  with the number caveat below). The hash is the artifact's identity.
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

- **`tally` (hashed):** `rulesetHash`, `network`, `survey`, `sealed` +
  deterministic reveal context, and per role: `role`, `total`, `responders`
  (`credential`, `weight`, `registered`, answer `txHash`), integer `questions`
  aggregates.
- **`provenance` (not hashed):** `source`, snapshot `fetchedAt`, per-role
  `endpoint`.

Excluding provenance is what lets Koios- and node-produced artifacts share one
hash when results are identical — keeping the Tier 1 → Tier 2 swap invisible to
the verifier (§2, §9).

Contents (sketch):

```jsonc
{
  // hashed:  artifactHash = H(canonical(tally))
  "tally": {
    "rulesetHash": "...",        // binds §6.3 validation ruleset + epoch semantics + role→measure + pinned cip-179 validator
    "network": "mainnet",
    "survey": { "txId": "...", "index": 0, "endEpoch": 642 },
    "sealed": false,             // if true, also records deterministic reveal context
    "perRole": [
      {
        "role": 1,               // CIP-179 Role
        "total": "12345678901234", // epoch total for this role (denominator; presentation decides use)
        "responders": [
          { "credential": "…", "weight": "1000000000",
            "registered": true, "txHash": "…" }
          // unregistered responders are excluded, not listed here
        ],
        "questions": [ /* BigInt-string aggregates + {numerator,denominator} ratios */ ]
      }
    ]
  },
  // NOT hashed: provenance envelope
  "provenance": {
    "source": { "provider": "koios", "baseUrl": "https://api.koios.rest/api/v1" },
    "fetchedAt": 0,
    "byRole": [
      { "role": 1, "endpoint": "/account_stake_history" }
      // fallback-estimated weights, if any: "estimated": [ "<cred>", … ]
    ]
  }
}
```

- **Immutable** once `end_epoch` is finalized. Stored on **R2** keyed by hash.
- The **frontend can pin the identical bytes to IPFS** (reusing
  `enrichment/pin.ts`) for durability / censorship-resistance; same bytes → same
  hash → same id.
- **Future:** the `tally` hash is the natural handle for an **on-chain anchor**,
  closing the loop with CIP-179 itself.
- **Verifiability.** The `tally` embeds the counted responders, their answers (or
  refs), weights, and totals, so any third party re-runs the pure `@tessera/core`
  tally and reproduces both the results and the hash; every weight is re-fetchable
  from Koios at `end_epoch`. Trust reduces to Koios's stake numbers for epoch E,
  which the node tier later removes — without changing this format.

---

## 8. Frontend integration

- New **`IndexerDataSource`** (HTTP) behind the existing `DataSource`. Swapped in
  via the existing seam in `state.tsx`; `KoiosDataSource` is retained as the
  direct/power-user/offline path (and the user-token override keeps working
  against it).
- Results UI consumes artifacts: it derives every float (averages, percentages,
  participation-by-stake using the embedded totals) from the integer aggregates.
- The existing "no weighting applied / out of scope" disclaimer is replaced by an
  honest **provenance + trust** note: weights are Koios-sourced at `end_epoch`,
  re-verifiable, not yet trustless.

---

## 9. Trust & honesty

- **Metadata and proofs are trust-minimized** (self-contained in tx CBOR,
  client-re-verifiable — survey definitions, responses, cancellation owner-proofs)
  and stay that way.
- **Weights are an oracle dependency.** A credential's stake = Σ(ada in every UTxO
  under that credential) + rewards, snapshotted at an epoch boundary — there is no
  certificate-only shortcut (`RESEARCH.md` §8.1). Koios (db-sync-backed) is the
  pragmatic oracle, and crucially it *retains epoch history* that a live node
  cannot serve (`RESEARCH.md` §7.2) — so on the historical axis Koios is not a
  downgrade from a bare node, only a different trust basis.
- The honest framing in the UI: results are **reproducible** (anyone re-runs the
  tally and matches the hash) but **trusted** (the weights' provenance is Koios).
  The node+indexer phase upgrades provenance to authoritative without changing the
  artifact, verifier, or UI.

---

## 10. Phasing

1. **Phase 1 — security + scale + packaging.**
   - Promote `cip-179` to a workspace package; extract `@tessera/core`
     (BigInt/rational-ready).
   - Stand up Tier 1 serving (read path moved server-side; token as
     secret/anonymous; SQL snapshot cache; Cron refresh). Frontend swaps to
     `IndexerDataSource`.
   - Reproducible via `wrangler` **and** a container/compose. No node required.
2. **Phase 2 — Koios tally inputs + artifacts.**
   - `TallyInputSource` (Koios impl): per-epoch shared snapshot (§6.5).
   - Weighted per-role tally in `@tessera/core` (§6.6).
   - Content-addressed artifacts on R2 (§7); optional IPFS pin from the frontend;
     standalone verifier reusing `@tessera/core`.
3. **Phase 3 — node + indexer (post-PoC, `RESEARCH.md`).**
   - Tier 2 implements the same `TallyInputSource` and emits the same artifact.
     The Koios→node swap is invisible to the verifier and UI.

---

## 11. Open items / TODO

- **CC (committee) role** — weighting + membership semantics. Deferred.
- **SPO role** — specified, not exercised until non-browser responders / Tier 2.
- **Exact Koios shapes** — confirm `/account_stake_history` POST element cap,
  the `active_stake` field semantics, `/drep_epoch_summary` total field, and the
  per-tx block `epoch_no` + `tx_block_index` fields the §6.3 deadline/dedup rules
  depend on.
- **Credential-proof verification** (§6.3 rule 2) — implement Mechanism A
  (`required_signers` + native-script resolution) / B (`voting_procedures`
  binding); the read path must surface the tx body witnesses. Anti-forgery, so
  not deferrable past the first tally.
- **Credential encodings** — script stake credentials → stake address; CIP-129
  `drep_id`.
- **Canonicalization profile** — pin JCS (RFC 8785) subset + the
  big-integer-as-string convention in a small shared serializer used by both the
  emitter and the verifier.
- **Finalization safety margin** — choose the post-`end_epoch` delay (epochs /
  hours) that absorbs Koios indexing lag and shallow reorgs.
- **On-chain anchor** of the artifact hash — future, closes the CIP-179 loop.
- **Two-network split** (mainnet/preview) — two Worker environments or one Worker
  with a network path segment; mirror `config.ts`'s per-network `koiosUrl`.
