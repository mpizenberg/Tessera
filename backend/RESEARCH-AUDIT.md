# Auditing one survey result without an oracle

> **Question (2026-09-09):** reproduce a single `tally_artifact` byte-for-byte
> (same `artifactHash`) with no trusted third party, as cheaply as possible in
> wall time, CPU, disk and RAM. Not a continuously running backend — that was
> `RESEARCH.md`'s question, and its trilemma (§8) still holds for that goal.
> Candidates, as the user scoped them: **Amaru, Dingo, Dolos, Adder, Yaci
> Store, Oura**, at their September 2026 versions. Every claim below was read
> from the projects' current sources, release notes or live endpoints on the
> date above; the sources are listed in §7.

---

## 1. What one audit consumes

`packages/verifier` already rebuilds an artifact from first principles
(`verify.ts`, `cli.ts`); the only thing it takes from the backend is the
artifact under test. Everything else comes from Koios today. Those calls are
the yardstick — a candidate is measured by whether it can answer each of them,
for a **past** epoch, and at what cost.

**A. Chain facts** — any faithful block archive can answer these.

| Today (Koios)                               | Needed for                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `/tx_by_metalabel` (label 17, slot window)  | the definition, every response and cancellation in the survey's window     |
| `/tx_metadata`, `/tx_cbor`                  | payload bytes; `required_signers`, witnesses, `voting_procedures` (proofs) |
| `/tx_info` (`tx_block_index`, block epoch)  | the CIP-179 chain order for dedup; the block's authoritative epoch         |
| `/script_info`                              | native-script credentials                                                  |
| `/proposal_list` (+ off-chain anchor fetch) | mechanism-B governance links                                               |

**B. Ledger facts at `end_epoch = E`** — the oracle part; this is where the
trust sits (`ARCHITECTURE.md` §8).

| Today (Koios)                            | Meaning                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `/account_stake_history?epoch_no=eq.E`   | per stake credential: active stake for `E`         |
| `/account_update_history`                | per stake credential: registered at the end of `E` |
| `/drep_voting_power_history` (epoch `E`) | per DRep: voting power for `E`                     |
| `/drep_updates`                          | per DRep: registered at the end of `E`             |
| `/epoch_info`, `/drep_epoch_summary`     | the two electorate totals                          |

Keyholder surveys need nothing from B; a sealed survey's drand beacon is already
independently verifiable and is out of scope here.

**Which ledger state holds B.** These are not "the state at the end of `E`":

- **Active stake for `E`** is the snapshot the ledger took at the `E-2 → E-1`
  boundary (db-sync's `epoch_stake` for `E` is "extracted from the `set`
  snapshot" and inserted during `E-1`). A node standing at the end of `E`
  holds it as its `set` snapshot, and anywhere in `E+1` as its `go`.
- **DRep voting power for `E`** is the distribution the ledger computed
  entering `E`: the completed pulsing snapshot in a state taken during `E` is
  what db-sync labels `drep_distr.epoch_no = E`, and its sum, the `abstain`
  and `no_confidence` buckets included, is `/drep_epoch_summary`'s amount.
- **Registration at the end of `E`**, of stake credentials and DReps alike, is
  the state after `E`'s last block.

Measured on preview against Koios (2026-09-10 to 2026-09-16, epochs 1405,
1406, 1408, 1409 and 1411 to 1414), with Mithril ancillary states taken 2 to
30 blocks before each epoch's end: both totals and every sampled weight equal
Koios for `E` through `set` and the pulsing distribution, which hold for the
whole of `E`; and every sampled registration agrees, including every stake
credential that registered or deregistered between two consecutive states
(109 registrations, 23 deregistrations) and the two DReps that registered
during `E`. That supports registration being read at the end of `E` but does
not measure the last blocks before it, which no ancillary state covered (§4,
Option 3). A registered DRep retiring during `E` did not occur in the window
and is untested.

So the ledger facts are computed at three consecutive boundaries, `E-2 → E-1`
through `E → E+1`, and the Haskell ledger carries all of them into its state
at the end of `E`. A tool that keeps **per-epoch history** answers them at any
later tip; a tool that keeps only **current state** must stand exactly at the
end of `E`, or, if it does not carry the snapshots the way the Haskell ledger
does, be walked through the boundaries and read at each. That distinction
decides most of §3.

**The floor.** Every option below starts from Mithril-certified immutable
files unless it trusts someone's ledger snapshot. Live sizes on 2026-09-09
(`cardano_node_version` 11.0.1 on all three aggregators):

| Network | Immutable DB, uncompressed | Ancillary (ledger state + last immutable) |
| ------- | -------------------------- | ----------------------------------------- |
| preview | 15.4 GB (epoch 1415)       | 0.69 GB                                   |
| preprod | 18.9 GB (epoch 312)        | 1.00 GB                                   |
| mainnet | 234.5 GB (epoch 654)       | 2.56 GB                                   |

---

## 2. The trust ladder

"Trustless" has three distinct rungs here, and the candidates sort by which
rung they reach, not by which language they are written in.

- **Rung 0 — an oracle.** Koios's numbers. Where the project stands.
- **Rung 1 — one named party's ledger snapshot.** The Mithril _ancillary_
  archive (the node's ledger-state file) is signed with an Ed25519 key held by
  the aggregator operator, not by the stake-based multi-signature; the
  documentation says so and Dingo's README repeats it ("that signature
  authenticates that payload; it is not a stake certificate"). PRAGMA's Amaru
  bootstrap snapshots and TxPipe's Dolos steles are the same rung: a ledger
  state you download, produced by a party you name. Cheap — minutes — and the
  trust is a key, not a service. Mithril's _ledger-state certification_
  prototype (issue #3269, closed June 2026) would move this rung up; no such
  distribution is announced through the August 2026 dev blog.
- **Rung 2 — certified blocks, your own ledger.** Mithril-certified immutable
  files, replayed from genesis by a ledger implementation you run. Trust is the
  Mithril multi-signature plus that implementation's correctness. Hours on a
  testnet, most of a day on mainnet.
- **Rung 3 — your own chain sync from genesis.** Removes Mithril; buys nothing
  for this goal.

One axis the ladder does not capture: **the reference numbers are db-sync's.**
The artifact's weights were fetched from Koios, and a Rung-2 reimplementation
that disagrees with db-sync by one lovelace on one responder does not reproduce
the hash. Every alternative ledger publishes a known-mismatch list against
db-sync or the Haskell node (Yaci Store's `ledger-state-mismatches`, Dolos's
open issues and per-network hacks, Amaru's conformance failures file). The one
ledger that is _by construction_ what db-sync saw is the Haskell node's own
code, which is why db-analyser appears in §4 even though it is not on the
candidate list: Amaru's tooling is built on it.

---

## 3. The six candidates, September 2026

### Amaru — v10.11.20260903 (beta; mainnet, preprod, preview)

Rust node by PRAGMA. **No query surface**: no node-to-client socket, no
LocalStateQuery, no HTTP beyond a transaction submit API. What it has that
matters here is its bootstrap pipeline and its ledger model.

- **Bootstrap.** `amaru node bootstrap` downloads three consecutive
  end-of-epoch ledger snapshots from PRAGMA's R2 bucket (Rung 1). Those
  snapshots are produced by a public, resumable command anyone can run:
  `amaru snapshot create --network <n> --epoch <E>` downloads Mithril immutable
  files up to the needed slot, runs cardano-node's **`db-analyser
--store-ledger <slot>`** on them, and packs the resulting Haskell
  `NewEpochState` for epochs `E-3`, `E-2`, `E-1`. Koios is consulted only to
  find each epoch's last block point, a fact the immutables themselves confirm.
  This is a Rung-2 route to the exact ledger state db-sync was fed, at any past
  epoch — Mithril retention does not limit it. PRAGMA's runner budget: about
  50 GB disk per testnet, 500 GB for mainnet.
- **Ledger model.** `amaru-ledger`'s `StakeSummary` is computed from a store
  snapshot "taken at the end of an epoch" and carries `active_stake`,
  `dreps_voting_stake`, `dreps → { voting_stake, valid_until }`, and
  `accounts → AccountState` — "only accounts delegated to a registered pool",
  which is exactly Koios's row semantics for `/account_stake_history`. Stake
  distributions are conformance-tested against Haskell-node snapshots per
  network. The runtime keeps only slim summaries in memory and rebuilds the
  account-level distribution from stored snapshots when needed, so the data is
  on disk after a bootstrap.
- **Reading it** means a short Rust binary over `amaru-ledger` +
  `amaru-stores` (open the RocksDB snapshot for an epoch, as `amaru dev ledger
states list` does, then `StakeSummary::new`). No such dump exists today.
- **Verdict:** the best _source_ of a Haskell-exact ledger state at an
  arbitrary past epoch, and the only Rust decoder for it; not an audit tool on
  its own. Cost is dominated by the db-analyser replay, whose duration was not
  measured in this pass (it replays from genesis unless a ledger snapshot is
  present, and starting it from the Mithril ancillary would drop the route to
  Rung 1).

### Dolos — 1.6.0 (2026-07-27), 1.7.0-alpha.1 (2026-08-24)

Rust "data node" by TxPipe. Bootstraps from Mithril by downloading the
immutable files and **replaying them from genesis through its own ledger**
("under 20 hours" for mainnet; "several minutes to a few hours" on a testnet),
stays under 2 GB of RAM at mainnet epoch boundaries, and has a documented
`chain.stop_epoch = E` that halts the sync **one block past the boundary into
`E`** — the exact cut TxPipe uses to publish its per-epoch steles.

Its Mini-Blockfrost router (read from `crates/minibf/src/lib.rs`) covers the
whole of column A and most of B:

| Need                      | Dolos route                                                            | History?                                                |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| label-17 window           | `/metadata/txs/labels/17`, `…/cbor`                                    | archive index, yes                                      |
| tx bytes and proof fields | `/txs/{h}/cbor`, `/txs/{h}/required_signers`, `/txs/{h}/metadata/cbor` | yes                                                     |
| chain order, block epoch  | `/txs/{h}` (`index`), `/blocks/{h}`, `/blocks/slot/{s}`                | yes                                                     |
| native scripts            | `/scripts/{hash}/cbor`, `…/json`                                       | yes                                                     |
| governance links          | `/governance/proposals`, `…/{tx}/{idx}`                                | yes; **anchor url/hash exposure to verify**             |
| active stake for `E`      | `/epochs/E/stakes` (paged), `/accounts/{id}/history`                   | **yes** — `AccountEpochLog`, written at `E+1`'s RUPD    |
| stake total for `E`       | `/epochs/E` (`active_stake`)                                           | yes                                                     |
| stake registration        | `/accounts/{id}/registrations` (slot-bounded)                          | yes                                                     |
| DRep voting power         | `/governance/dreps/{id}` (`amount`)                                    | **no** — current value only; per-epoch history deferred |
| DRep registration         | `/governance/dreps/{id}` (`active`, `retired`)                         | current only                                            |
| DRep total                | none — `GovDistr.drep_distr` is internal; no `/governance/dreps` list  | —                                                       |

The DRep gap is explicit in the source: "a per-epoch history, if APIs ever
want one, is a new field at a higher index." So the Stakeholder role is fully
historical and needs no stopping, while the DRep role needs the node to
**stand at the right boundary** when it is read.

**Accuracy evidence.** Dolos runs an `epoch_pots` suite against db-sync ground
truth (delegation, stake, rewards, pots, pparams, eras) for fixed epochs —
mainnet 242–500 in steps, preview 550–700 — and ships per-network boundary
hacks (`mainnet_epoch526`, `preprod_epoch191`, `preview_epoch736`) that show
the target is db-sync parity. Open at the time of writing: `/epochs/2/stakes`
empty on preview (#1248, a gating bug at the chain's start), a stake-address
indexing mismatch (#448). Nothing open names a wrong active-stake amount on a
recent epoch, but the suite is explicitly "best-effort", so §6's spike has to
measure it on the responders that matter.

**Verdict:** the cheapest Rung-2 path that answers A and B over HTTP with no
new code; one calibration and one node-walk for the DRep role; the residual
risk is Dolos's ledger versus db-sync on the specific accounts in the artifact.

### Dingo — README as of 2026-09 (testnets only; "not ready for mainnet")

Go node by Blink Labs. Its fast path, `dingo mithril sync`, imports the
**ancillary** ledger state (Rung 1) and validates forward from it; a genesis
sync is Rung 2 but "days on mainnet". Footprint is the heaviest of the nodes:
about 150 GB for preprod (60 GB snapshot + 80 GB database), 400 GB for
mainnet; preprod bootstraps in 38 minutes, mainnet in 9 hours.

It exposes LocalStateQuery with the governance queries the audit would want —
`GetStakeSnapshots`, `GetDRepStakeDistr`, `GetDRepState`,
`GetFilteredDelegationsAndRewardAccounts` — but LSQ answers at the **tip**, and
no configuration halts the sync at an epoch. The Blockfrost-compatible REST
subset (routes read from `api/blockfrost/blockfrost.go`) has
`/accounts/{id}/registrations`, `/governance/dreps` (with a list),
`/metadata/txs/labels/{l}`, `/txs/{h}/cbor` and `/required_signers`, but
**no `/epochs/{n}/stakes` and no `/accounts/{id}/history`**; reward history is
pruned to a trailing four-epoch window in `core` mode. It does carry a
`koiosParity` observer that checks each closed epoch's reward state against
Koios — the same parity question this document asks, asked by the tool itself.

**Verdict:** a tip-only ledger with no pin point — `RESEARCH.md` §8.4's
"snapshot at close" shape, usable while `E+1` is the current epoch and not
after. Not the audit tool for a survey that closed months ago.

### Yaci Store — 2.0.1 (2026-05); 2.1.0 pre-releases through June

Java/Spring indexer on PostgreSQL. Its `ledger-state` profile derives
`epoch_stake`, `drep_dist`, `reward` and the ADA pots **from genesis**, with
the stated goal of matching db-sync and a published mismatch ledger
(`ledger-state-mismatches/2-0-0`: DRep-distribution amount mismatches on
preview epochs 681–830, DRep expiry-epoch mismatches on preprod 207–268;
mainnet has its own pages). Parity was declared verified at mainnet 637,
preprod 295, preview 1329. Its getting-started page puts mainnet ledger-state
work at 20–40 minutes **per epoch transition**, which over Shelley's
five-hundred-odd epochs is on the order of a week or two of transitions alone
(a derivation, not a measurement — the requirements page is still "work in
progress"). There is no snapshot bootstrap.

**Verdict:** the most db-sync-shaped reimplementation — its tables are the
tables Koios serves — and the heaviest by far. Feasible on preprod as a
second opinion; not "as cheap as possible" anywhere.

### Adder 0.44.0 (2026-08-31) and Oura 2.2.0 (2026-06-15)

Both are still transports: chain-sync in, events out, no ledger state. Their
2026 releases are about notifications, installers, filters and packaging. They
would matter only if the block source were a node with no archive API — Adder
over Dingo's node-to-client socket, Oura over Dolos's UTxO-RPC. Dolos already
indexes label 17 and serves transaction CBOR, and Amaru has no socket to tail,
so neither transport shortens any path in §4.

---

## 4. The options, cheapest first

Costs are for **preprod / mainnet**; testnet figures are the ones that matter
for the next step, since mainnet has no deployment (`ARCHITECTURE.md` §9).

### Option 1 — Dolos from Mithril, walked through the boundaries (Rung 2)

One binary, certified blocks in, HTTP out.

1. `dolos bootstrap mithril` with `chain.stop_epoch = E`. Read the DRep
   `amount` and registration flags for the artifact's DRep responders.
2. Raise `stop_epoch` to `E+1`, `dolos sync`, read them again. Which of the
   two readings equals Koios's `drep_voting_power_history` for `E` is the
   calibration; after it, only one stop is needed.
3. Raise to `E+2`, sync, then read `/epochs/E/stakes` for the Stakeholder
   responders (their rows are written during `E+1`'s reward update), `/epochs/E`
   for the total, `/accounts/{id}/registrations` bounded by `E`'s last slot,
   and the whole of column A.
4. The DRep electorate total is not served; the verifier's existing
   "total taken from the artifact" path (exit 5) covers it until Dolos exposes
   `GovDistr` or a DRep list with amounts — a small upstream request.

Cost: disk of the order of the immutable DB plus indexes (about 20–30 GB /
250–300 GB — an estimate; Dolos publishes no disk figures, and `max_history`
can bound the archive to the survey's window), RAM under 2 GB, wall time
"minutes to a few hours" / under 20 hours, all of it the initial replay. A
kept Dolos serves any later audit of the same network for the cost of the
tail sync.

### Option 2 — the Haskell ledger state through Amaru's tooling (Rung 2, exact)

`amaru snapshot create --network preprod --epoch E+1` yields the Haskell
`NewEpochState` at the ends of `E-2`, `E-1` and `E` — the three boundaries §1
needs — from Mithril immutables and db-analyser, reproducibly. A dump binary
over `amaru-ledger` turns each into the B rows; column A still comes from a
block reader (a Dolos archive, or pallas over the same immutables). Numbers
are what db-sync saw, so a disagreement with Koios is a Koios bug, not a
ledger-implementation question.

Cost: db-analyser's replay from genesis (unmeasured here; the Haskell ledger
replay on mainnet is a many-hours job that wants well over 16 GB of RAM — a
known node figure, not verified in this pass), 50 / 500 GB of disk, and the
dump binary to write. Worth building as the **adjudicator**, not the daily
path.

### Option 3 — a signed ledger snapshot (Rung 1, minutes)

- **Mithril ancillary** — tried on preview, 2026-09-09 to 2026-09-16
  (`packages/mithril`). An hourly archive of the node's newest ledger
  snapshot plus the unfinished immutable file after the one it is named for,
  signed with the aggregator operator's Ed25519 key and kept 28 days on the
  CDN (28 epochs on preview, about five on preprod and mainnet). On preview:
  255 MB down, about 40 MB of state, decoded in about 1.3 s by a generic CBOR
  decoder. **Its snapshot is not at an epoch boundary.** The aggregator
  copies whichever snapshot is newest in the node's `db/ledger` when it
  builds the archive and never compares its slot with the immutable number
  (`mithril-aggregator/src/services/snapshotter/compressed_archive_snapshotter.rs`,
  `unstable` at 621a9bd), and node 11.0.1, which the preview aggregator runs,
  takes snapshots on a timer. Of thirteen preview archives, twelve states sit 2 to
  30 blocks before the end of the immutable file in the name and one 2 blocks
  past an epoch boundary. A state inside `E` gives `E`'s weights and totals
  exactly — for the one finalized preview survey still in reach
  (`end_epoch` 1395), both totals and both responders' weights equal the
  artifact's from a state 4,543 slots before the boundary — but it gives
  registration as of its own slot, not the end of `E`.

  That makes it an **estimate**, not an audit: a result recomputed from the
  latest state inside `end_epoch` equals the artifact unless a counted
  responder's registration changed between that state and the epoch's end
  (from under a minute to over an hour on preview), which the state cannot
  show. Closing the
  gap takes the certificates of the blocks in between, from a block decoder
  over the certified immutable files or from Koios, and past that point a
  Rung 2 replay that stops exactly at the boundary is the cleaner tool.
  Node 11.1 is reported to take snapshots at fixed slot multiples that
  include every epoch boundary, which would put some archives exactly at an
  epoch's end; not verified here, and not what the preview aggregator runs as
  of 2026-09-16.

- **A Dolos stele** (`ghcr.io/txpipe/dolos-snapshots/<network>:epoch-E`), cut
  exactly at `stop_epoch = E`; its `digests` layer lets the blocks be checked
  against Mithril, the state is TxPipe's. Minutes.
- **PRAGMA's Amaru bootstrap set**, latest three epochs only.
- **Dingo's Mithril v2 import**, tip-only, so only "at close".

These replace an oracle _service_ with a named party's _key_. They are a real
upgrade for anyone auditing soon after close, and none of them can audit an
old survey.

### Option 4 — Yaci Store from genesis (Rung 2, db-sync-shaped)

The most faithful table-for-table reproduction and the slowest. Preprod is
small enough to be a meaningful cross-check of Option 1's numbers; mainnet
is a multi-day PostgreSQL job.

---

## 5. What this changes and what it does not

- **`TALLY-SPEC.md` and the artifact do not move.** Provenance is unhashed by
  design (§5 there); a Dolos-fed rebuild reproducing the same `tally` hash is
  the whole point of that split.
- **The seam is `TallyInputSource` plus `DataSource`**, already implemented
  once for Koios. A Dolos implementation is the endpoint mapping in §3 and the
  node walk in §4; provenance would carry `provider: dolos`, the Mithril
  certificate hash, and the stop epochs read.
- **The infrastructure gap `RESEARCH.md` §8.5 named is narrower now, not
  closed.** Historical per-account stake is served by Dolos; historical DRep
  power is served by nobody's API — Dolos deferred it in a comment, Dingo
  keeps four epochs of reward rows, Amaru has no API. Mithril's ledger-state
  certification, when it ships, collapses Rung 1 into Rung 2 for recent
  epochs and makes Option 3 the cheap trustless path — for an audit, only if
  the certified state sits at an epoch boundary (§4, Option 3).

---

## 6. Recommended next step

**Rung 1 was tried first and is set aside** (2026-09-16). The Mithril
ancillary gave every weight and total exactly and settled which DRep
distribution db-sync labels `E` (§1), but no archive holds the state at an
epoch boundary (§4, Option 3), so registration at `end_epoch` needs block
data a Rung 1 snapshot does not carry. What remains of it is a cheap estimate
of a recent result. What carries over to a Rung 2 test:

- **The readings to expect.** A state at the end of `E` answers all of B
  through `set`, the pulsing distribution and the two registration maps (§1).
  A replay that stops exactly there needs no calibration against the Haskell
  ledger's readings, only of how the tool labels its own.
- **The sample.** Registration can only go wrong on credentials whose
  registration changed during `E`, and ten per kind never reaches one among
  tens of thousands of long-registered accounts; diffing the registration
  maps of two states finds every change.
- **The decoder.** `packages/mithril` reads the Haskell `NewEpochState` a node
  writes to `db/ledger`. A state db-analyser stores at `E`'s last slot
  (Option 2) should be the same format; not tried.

The spike below is still the cheapest Rung 2 test. Option 2 is the one whose
output the existing decoder should read, and preview now has both a finalized survey
with Stakeholder and DRep responders (`1356f08e…:0`, `end_epoch` 1395) and a
Koios calibration, so either network serves. A one-day spike on preprod,
decisive because the reference artifact exists:

1. Bootstrap Dolos from the preprod Mithril aggregator with
   `chain.stop_epoch = 308`; record `/governance/dreps/{id}` for the DRep
   responders of the epoch-308 artifact. Continue to 309, record again;
   continue to 310.
2. Compare `/epochs/308/stakes` rows for the artifact's Stakeholder responders
   and `/epochs/308`'s total against Koios `account_stake_history` and
   `epoch_info`; compare the two DRep readings against
   `drep_voting_power_history` for 308.
3. If every number matches to the lovelace, add a `--source dolos` mode to
   `packages/verifier` behind the same seam and re-run it against every
   preprod artifact. If one does not, that account is the input to Option 2,
   which says whether Koios or Dolos is wrong.

Disk about 25 GB, RAM under 2 GB, wall time a few hours, no code before the
numbers are in.

---

## 7. Sources

- Amaru: repository README and `docs/BOOTSTRAP.md`, `docs/PUBLISHING_SNAPSHOTS.md`, `CHANGELOG.md`, `crates/amaru-ledger/src/summary/stake_distribution.rs`, `crates/amaru/src/bin/amaru/cmd/` (https://github.com/pragma-org/amaru); releases page (v10.11.20260820 to v10.11.20260903).
- Dolos: `crates/minibf/src/lib.rs` (router), `routes/accounts.rs`, `routes/epochs/mod.rs`, `routes/governance/mod.rs`, `crates/cardano/src/model/{logs,dreps,gov}.rs`, `crates/snapshot/PROFILE.md`, `skills/debug-epoch-mismatch/SKILL.md`, `.github/workflows/epoch-tests.yml`, `docs/content/operations/performance.mdx`, issues #1248, #448, #1078, #1082 (https://github.com/txpipe/dolos); configuration schema and bootstrap pages at https://docs.txpipe.io/dolos.
- Dingo: README (bootstrap, disk, timings), `dingo.yaml.example`, `api/blockfrost/blockfrost.go` (https://github.com/blinklabs-io/dingo).
- Yaci Store: `docs/app/docs/v2/ledger-state-mismatches/2-0-0/overview/page.mdx`, `getting-started/requirements` (https://github.com/bloxbean/yaci-store); release announcement https://cardanofoundation.org/blog/yaci-store-2; getting-started page at https://store.yaci.xyz.
- Adder releases https://github.com/blinklabs-io/adder/releases; Oura releases https://github.com/txpipe/oura/releases.
- Mithril: live artifact lists and details from `aggregator.release-preprod`, `aggregator.pre-release-preview`, `aggregator.release-mainnet` (`/aggregator/artifact/cardano-database`); ancillary and client documentation https://mithril.network/doc; issues #2704, #3269 and PR #2747 (https://github.com/IntersectMBO/mithril); dev blog through 2026-08-04.
- db-sync schema (`epoch_stake`, `drep_distr`): https://github.com/IntersectMBO/cardano-db-sync/blob/master/doc/schema.md.
