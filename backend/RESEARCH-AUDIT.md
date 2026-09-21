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
| `/script_info` (JSON), creation tx position | native-script credentials whose script the carrying tx lacks               |
| `/proposal_list` (+ off-chain anchor fetch) | mechanism-B governance links                                               |

**B. Ledger facts at `end_epoch = E`** — the oracle part; this is where the
trust sits (`ARCHITECTURE.md` §8).

| Today (Koios)                            | Meaning                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `/account_stake_history?epoch_no=eq.E`   | per stake credential: active stake for `E`         |
| `/account_update_history`                | per stake credential: registered at the end of `E` |
| `/drep_voting_power_history` (epoch `E`) | per DRep: voting power for `E`                     |
| `/drep_updates`                          | per DRep: registered at the end of `E`             |
| `/epoch_info`, `/drep_epoch_summary`     | the two electorate totals, outside the hash        |

Keyholder surveys need nothing from B; a sealed survey's drand beacon is already
independently verifiable and is out of scope here. The totals only scale
turnout, and since ruleset 14 (2026-09-18) they sit in the artifact's unhashed
`info`: an audit that cannot read them still reproduces the hash, and the
verifier compares them only as a note.

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

A node that **validates the live chain from a downloaded state** sits between
Rungs 1 and 2. Amaru bootstraps from PRAGMA's end-of-epoch states, then
follows the network and applies every block to them; the maintainer accepts
that as enough for Tessera's audit (2026-09-16). Later blocks fail to validate
wherever they depend on a wrong part of the start state: an output they spend,
a reward balance they withdraw, a pool's stake in a leader check. Blocks carry
no ledger-state hash, though, so a part no later block touches stays
unchecked, such as the DRep delegation of an account that never transacts
again.

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

### Amaru — v10.11.20260912 (beta; mainnet, preprod, preview)

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
- **As a node** (read from source, 2026-09-16, not run). PRAGMA's preview
  bucket holds bootstrap sets ending at epochs 999, 1118 and 1392. The node
  checkpoints its store as snapshot `E` when the stable store crosses into
  `E+1`, so snapshot `E` is the state at the end of `E`
  (`amaru-ledger/src/state/volatile/overlay.rs`), and
  `--max-extra-ledger-snapshots N` keeps `N` epochs beyond those the node
  needs. Its chain store keeps every block it syncs; only `amaru dev chain`
  commands delete them. A block reaches the stable store once `k` later
  blocks exist, so snapshot `E` is written `k` blocks into `E+1`, or `3k/f`
  slots in when the chain grows slowly. The backend finalizes a survey on the
  same trigger, so an Amaru audit can run as soon as the artifact exists.
- **Verdict:** with a reader over its epoch snapshots and a walk over its
  blocks, an audit tool at the level between Rungs 1 and 2 (§2), with no
  Haskell tooling. Its `snapshot create` stays the route to a Haskell-exact
  state (Option 2).

### Dolos — 1.6.0 (2026-07-27), 2.0.0-alpha.0 (2026-09-11)

Rust "data node" by TxPipe. Bootstraps from Mithril by downloading the
immutable files and **replaying them from genesis through its own ledger**
("under 20 hours" for mainnet; "several minutes to a few hours" on a testnet),
stays under 2 GB of RAM at mainnet epoch boundaries, and has a documented
`chain.stop_epoch = E` that halts the sync **one block past the boundary into
`E`** — the exact cut TxPipe uses to publish its per-epoch steles.

Read from source on 2026-09-16 (`main` at 15f92c6e), not run:

- **Versions.** In 1.6.0 a DRep's `amount` is its deposit. The DRep
  distribution arrived in 1.7.0-alpha.1, and the 1.7 line was renamed
  2.0.0-alpha.0. That release also stops applying the certificates of
  phase-2-invalid transactions.
- **Stopping.** `stop_epoch = E` runs the whole `E-1 → E` boundary and then
  applies `E`'s first block before halting (`crates/cardano/src/work.rs`).
  Boundary work only runs when a block of the next epoch arrives, so a
  replay whose input ends at `E`'s last block stands exactly at the end of
  `E`. `dolos bootstrap mithril --download-end N` downloads and certifies
  immutables up to `N` only and replays them through `N-1` (seen on 2026-09-17), and
  `dolos serve` answers queries without syncing.

Its Mini-Blockfrost router (read from `crates/minibf/src/lib.rs`) covers the
whole of column A and most of B:

| Need                      | Dolos route                                                                | History?                                                |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| label-17 window           | `/metadata/txs/labels/17`, `…/cbor`                                        | archive index, bounded by `from`/`to` block heights     |
| tx bytes and proof fields | `/txs/{h}/cbor`, `/txs/{h}/required_signers`, `/txs/{h}/metadata/cbor`     | yes                                                     |
| chain order, block epoch  | `/txs/{h}` (`index`), `/blocks/{h}`, `/blocks/slot/{s}`                    | yes                                                     |
| native scripts            | minikupo `/scripts/{hash}` (bytes); minibf's `…/cbor` is null for them     | yes                                                     |
| governance links          | `/governance/proposals`, `…/{tx}/{idx}`, `…/{id}/metadata` (anchor)        | yes                                                     |
| active stake for `E`      | `/epochs/E/stakes` (paged), `/accounts/{id}/history`                       | **yes** — `AccountEpochLog`, written when `E+1` closes  |
| stake total (unhashed)    | `/epochs/E` (`active_stake`)                                               | yes                                                     |
| stake registration        | `/accounts/{id}` (`registered`); `…/registrations` omits certificate 12    | current only; the list has history                      |
| DRep voting power         | `/governance/dreps/{id}` (`amount`; a deposit if registered during `E`)    | **no** — current value only; per-epoch history deferred |
| DRep registration         | `/governance/dreps/{id}` (`active`, `retired`)                             | current only                                            |
| DRep total (unhashed)     | none — no `/governance/dreps` list; `abstain`, `no_confidence` answer `""` | —                                                       |

The DRep gap is explicit in the source: "a per-epoch history, if APIs ever
want one, is a new field at a higher index." So the Stakeholder role is fully
historical and needs no stopping, while the DRep role needs the node to
**stand at the right boundary** when it is read.

**Accuracy evidence.** Dolos runs an `epoch_pots` suite against db-sync ground
truth (delegation, stake, rewards, pots, pparams, eras) for fixed epochs —
mainnet 242–500 in steps, preview 550–700 — and ships per-network boundary
hacks (`mainnet_epoch526`, `preprod_epoch191`, `preview_epoch736`) that show
the target is db-sync parity. PR #1228 reports the whole DRep distribution,
`abstain` and `no_confidence` included, equal to db-sync on preprod epoch 306
and preview epoch 1184. Open at the time of writing: `/epochs/2/stakes`
empty on preview (#1248, a gating bug at the chain's start), a stake-address
indexing mismatch (#448). Nothing open names a wrong active-stake amount on a
recent epoch, but the suite is explicitly "best-effort"; §4, Option 1 measures
it on preview's epoch 1395.

**Verdict:** the cheapest Rung-2 path; it answers A and every part of B the
hash needs over HTTP, from two stopping points (§4, Option 1). The residual
risk is Dolos's ledger versus db-sync on the specific accounts in the
artifact: on preview it keeps one protocol-9 vote delegation the Haskell
ledger cleared (txpipe/dolos#1364), which moves a DRep's power and the DRep
total.

### Dingo — v0.70.12 (2026-09-15; testnets only)

Go node by Blink Labs. **Not viable for an audit yet, mostly because its
stake accounting is still being corrected.** Reward balances still drift from
the chain on preview (#3885, 2026-09-14), fixes to stake and reward
attribution land almost daily, and its Koios parity check covers pool totals
and rewards, not per-credential stake, DReps or registration. It never stores
DRep voting power: it computes it at the epoch transition, only while
proposals are active and without their deposits, so the distribution db-sync
labels `E` cannot be read from it (`GetDRepStakeDistr` is not implemented).
A pin point exists (`dingo load` replays a local immutable directory from
genesis and stops at its end); worth re-reading once its cross-network parity
issue (#1903) closes.

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

### Option 1 — Dolos from Mithril, stopped at two boundaries (Rung 2)

One binary, certified blocks in, HTTP out. Tried on preview on 2026-09-17
and 2026-09-18 with release 2.0.0-alpha.0, on the survey `1356f08e…:0`
(`end_epoch` 1395): the verifier's rebuild from two Dolos nodes, read through
queries alone, gives the `artifactHash` its Koios rebuild gives. The recipe,
and what an auditor needs, is `docs/AUDIT.md`; the verifier takes the two nodes with
`--dolos-end` and `--dolos-after`, and checks that each stands where the
steps below put it.

1. **The end of `E`.** `dolos bootstrap mithril --download-end 20E+20`
   downloads and certifies files 0 to `20E+20`, and replays them through
   `20E+19`, `E`'s last block. The immutable reader skips the highest file on
   disk, and no boundary runs until a block of `E+1` arrives. Standing there,
   `/governance/dreps/{id}` gives the distribution labelled `E` and DRep
   registration at `E`'s end. `/accounts/{id}` `registered` gives stake
   registration at `E`'s end. `/accounts/{id}/registrations` would serve it
   at any later tip, but it omits the certificate that registers and
   delegates a vote together.
2. **One block into `E+2`.** A copy of that store is set to
   `stop_epoch = E+2` and continued with `bootstrap --continue`, downloading
   from file `20E+19`. It runs the two boundaries and stops.
   `/accounts/{id}/history` then gives each account's active stake for `E`,
   logged when the replay closes `E+1`, and the node answers the whole of
   column A. The release exits there without seeding its write-ahead log,
   and `dolos doctor reset-wal` seeds it (fixed on `main` by #1327).
3. **The totals.** `/epochs/E` `active_stake` is the stake total, and no
   route serves the DRep total. Both sit outside the hash, and the Dolos
   source reads neither. A draft PR, #1121, adds a DRep list with amounts.

**Measured at 1395** against the Haskell state of the Rung 1 snapshots and
against Koios:

- DRep registration agrees on all 8978 DReps either state knows. Power agrees
  on all but one, which keeps a delegation the ledger cleared under protocol
  9 (#1364) and was not a responder.
- Every row of `/epochs/1395/stakes` (79734) equals the state's `set`, and
  their total equals Koios's `active_stake`.
- Stake registration agrees on all 302383 credentials.
- Column A equals Koios's on every label-17 transaction of the window, with
  the transaction CBOR identical byte for byte.
- A replay from genesis to one block into 1397 gives the same
  `dolos snapshot digest` as the resumed copy, so step 2 loses nothing by
  resuming.

**Costs on preview**, on the maintainer's Mac (12 cores, 36 GB RAM):

| Step                                   | Wall time                  | Memory (macOS `time -l`)          | Disk                           |
| -------------------------------------- | -------------------------- | --------------------------------- | ------------------------------ |
| Replay from genesis to the end of 1395 | 53 min, 6 of them download | 7.0 GB resident, 1.8 GB footprint | 14 GB download, 14 GB store    |
| Continue a copy into 1397              | 19 s                       | 0.9 GB resident                   | a second store, 14 MB download |
| Rebuild from both nodes                | 2.1 s (4.8 s from Koios)   | —                                 | —                              |

The resident set counts pages the footprint leaves out. Which of the two
numbers bounds the RAM an audit needs has not been measured. The download is
deleted after the replay unless `--retain-snapshot` is given. An APFS clone
shares the second store's blocks with the first. The same replay from
genesis, taken on to 1397, ran 108 minutes, on a machine that was likely
busy.

Preprod and mainnet have not been tried. The developers report 94 minutes
for a preprod bootstrap, download included (PR #1222), and under 20 hours
for mainnet. They put mainnet's archive at an estimated 250–300 GB. A kept
store at the end of one epoch continues to a later one as step 2 does, paying
only for the files in between. This has been tried across two epochs only.

**One node instead of two (future work).** The second store exists for one
value, each account's active stake for `E`, and the first store already
holds it: an account's version for `E-2` in Dolos's state. At the end of 1395
it equalled the Haskell `set` on every account read with `dolos data
dump-state`. No route serves it per account, since `/epochs/E/stakes` and
`/accounts/{id}/history` read the log that the close of `E+1` writes. Two
ways would drop the second store:

- A small Rust program, built against the same Dolos release, that reads the
  responders' stake from the first store through Dolos's own types. Only
  Rust reads the store: Fjall has no bindings for other languages and no
  format specification outside its code. It needs `serve` stopped, since
  Fjall locks the store and has no read-only mode.
- A Dolos route serving an account's active stake for its tip's epoch.

The snapshot export (`dolos snapshot publish`) is no way around it: it
always writes the whole state, the UTxO set included, and `--epochs` only
narrows the block, index and log layers. Either way, the chain source must
also learn to read at the first store's tip, since it finds `E`'s last block
through the first block of `E+1`.

### Option 2 — the Haskell ledger state through Amaru's tooling (Rung 2, exact)

`amaru snapshot create --network preprod --epoch E+1` yields the Haskell
`NewEpochState` at the ends of `E-2`, `E-1` and `E` — the three boundaries §1
needs — from Mithril immutables and db-analyser, reproducibly. A dump binary
over `amaru-ledger` turns each into the B rows; column A still comes from a
block reader (a Dolos archive, or pallas over the same immutables). Numbers
are what db-sync saw, so a disagreement with Koios is a Koios bug, not a
ledger-implementation question.

Cost: db-analyser's replay from genesis (Amaru's CI replayed preprod to the
end of epoch 296 in 28 minutes, node 11.0.1, hardware unknown; mainnet wants
well over 16 GB of RAM, a node figure not verified here), 50 / 500 GB of
disk, and the dump binary to write. db-analyser ships in the cardano-node
release archives, macOS arm64 included; in 11.0.1 it ignores
`--analyse-from`, so every run starts from genesis, which 11.1.1 fixes. Worth building as the **adjudicator**, not the daily
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

- **The artifact moved once for this** (maintainer, 2026-09-18): the two
  electorate totals left the hashed `tally` for an unhashed `info` section
  (ruleset 14), since alternative ledgers disagree with the Haskell node on
  them and they only scale turnout. Provenance was already unhashed (§5
  there); a Dolos-fed rebuild reproducing the same `tally` hash is the whole
  point of that split.
- **The verifier's seam is `TallyInputSource` plus `SurveyChain`**,
  implemented for Koios and, in `packages/dolos`, for two Dolos nodes; the
  totals sit apart in `ElectorateTotals`, which the Dolos source leaves out.
  The backend still reads Koios. Fed by Dolos, its provenance would carry
  `provider: dolos`, the Mithril certificate hash, and the stop epochs read.
- **The infrastructure gap `RESEARCH.md` §8.5 named is narrower now, not
  closed.** Historical per-account stake is served by Dolos; historical DRep
  power is served by nobody's API — Dolos deferred it in a comment, Dingo
  never stores it, Amaru has no API. Mithril's ledger-state
  certification, when it ships, collapses Rung 1 into Rung 2 for recent
  epochs and makes Option 3 the cheap trustless path — for an audit, only if
  the certified state sits at an epoch boundary (§4, Option 3).

---

## 6. Next step

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

**The stopping point comes from the immutable files.** Every Cardano network
completes twenty immutable files per post-Byron epoch, cut on slot
boundaries, so on preview file `20E+19` ends with `E`'s last block. The
latest Mithril snapshot certifies every file from genesis, and a download
can end at any of them, so a replay of that range stands exactly at the end
of `E` for a survey of any age.

**Two experiments follow** (maintainer, 2026-09-16), both on the
preview survey `1356f08e…:0`: created in epoch 1365, `end_epoch` 1395,
Stakeholder and DRep responders and one governance link, with a Koios-built
artifact to reproduce.

- **Dolos, read through its queries only** (Option 1). The difficulty is
  holding the node at the two stopping points reliably. The DRep total, which
  no route serves, left the hash for that reason (§5). Done on 2026-09-18:
  the rebuild equals the Koios one (§4, Option 1).
- **Amaru as a node and a library, without the Haskell tools**, at the
  level between Rungs 1 and 2 (§2). Bootstrap from PRAGMA's states, sync with
  the epoch snapshots retained, read them with a small Rust program over
  `amaru-stores` and `amaru-ledger`, and walk the survey window's blocks for
  its CIP-179 transactions.

Dingo is dropped (§3).

**Blockfrost is not a practical second oracle** (maintainer, 2026-09-17).
Checking an artifact against it instead of Koios stays at Rung 0, and its
API (OpenAPI 0.1.93) blocks the check twice:

- No route gives a DRep's voting power or the DRep total for a past epoch,
  only the current `amount`, so the DRep role cannot be checked. Requested
  upstream as blockfrost/openapi#471.
- `/metadata/txs/labels/{label}` takes no slot or block bounds, so finding one
  survey's records means listing every label-17 transaction on the chain, at a
  cost that grows with the chain rather than the survey. Dolos's copy of the
  route accepts `from`/`to` block heights.

---

## 7. Sources

- Amaru: repository README and `docs/BOOTSTRAP.md`, `docs/PUBLISHING_SNAPSHOTS.md`, `CHANGELOG.md`, `crates/amaru-ledger/src/summary/stake_distribution.rs`, `crates/amaru/src/bin/amaru/cmd/`, and on 2026-09-16 at f664b29 `crates/amaru-ledger/src/state/volatile/overlay.rs`, `crates/amaru-stores/src/rocksdb/mod.rs`, `crates/amaru/src/bin/amaru/cmd/node/run.rs` (https://github.com/pragma-org/amaru); releases page (v10.11.20260820 to v10.11.20260912); the preview bootstrap index `https://pub-b844360df4774bb092a2bb2043b888e5.r2.dev/preview/index.json`; CI run 28745354271 (`publish-bootstrap-snapshots`, preprod).
- Dolos: `crates/minibf/src/lib.rs` (router), `routes/accounts.rs`, `routes/epochs/mod.rs`, `routes/governance/mod.rs`, `crates/cardano/src/model/{logs,dreps,gov}.rs`, `crates/snapshot/PROFILE.md`, `skills/debug-epoch-mismatch/SKILL.md`, `.github/workflows/epoch-tests.yml`, `docs/content/operations/performance.mdx`, issues #1248, #448, #1078, #1082; on 2026-09-16 at 15f92c6e `crates/cardano/src/work.rs`, `crates/cardano/src/ewrap/loading.rs`, `crates/minibf/src/routes/metadata.rs`, `crates/minibf/src/pagination.rs`, `src/bin/dolos/bootstrap/mithril.rs`, `crates/mithril/src/lib.rs`, PRs #1121, #1212, #1222, #1228, #1266, #1327 and issues #1018, #1364 (https://github.com/txpipe/dolos); configuration schema and bootstrap pages at https://docs.txpipe.io/dolos; release `v2.0.0-alpha.0` (`a08c9d13`), run on preview from 2026-09-17 to 2026-09-18.
- Dingo: README (bootstrap, disk, timings), `dingo.yaml.example`, `api/blockfrost/blockfrost.go`; on 2026-09-16 at d9080904 `ledger/queries.go`, `internal/node/load.go`, `database/plugin/metadata/internal/drepquery/voting_power.go`, `ledger/governance/epoch.go`, issues #3885, #1903 (https://github.com/blinklabs-io/dingo); releases v0.70.6 to v0.70.12.
- Blockfrost: `openapi.yaml` version 0.1.93 (`blockfrost/openapi` master of 2026-09-15), issue #471 (https://github.com/blockfrost/openapi).
- Yaci Store: `docs/app/docs/v2/ledger-state-mismatches/2-0-0/overview/page.mdx`, `getting-started/requirements` (https://github.com/bloxbean/yaci-store); release announcement https://cardanofoundation.org/blog/yaci-store-2; getting-started page at https://store.yaci.xyz.
- Adder releases https://github.com/blinklabs-io/adder/releases; Oura releases https://github.com/txpipe/oura/releases.
- Mithril: live artifact lists and details from `aggregator.release-preprod`, `aggregator.pre-release-preview`, `aggregator.release-mainnet` (`/aggregator/artifact/cardano-database`); ancillary and client documentation https://mithril.network/doc; issues #2704, #3269 and PR #2747 (https://github.com/IntersectMBO/mithril); dev blog through 2026-08-04.
- db-sync schema (`epoch_stake`, `drep_distr`): https://github.com/IntersectMBO/cardano-db-sync/blob/master/doc/schema.md.
