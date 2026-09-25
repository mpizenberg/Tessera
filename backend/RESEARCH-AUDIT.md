# Auditing one survey result without an oracle

> **Question (2026-09-09):** reproduce a single `tally_artifact` byte-for-byte
> (same `artifactHash`) with no trusted third party, as cheaply as possible in
> wall time, CPU, disk and RAM. Not a continuously running backend — that was
> `RESEARCH.md`'s question, and its trilemma (§8) still holds for that goal.
> Candidates: Amaru, Dingo, Dolos, Adder, Yaci Store, Oura, at their
> September 2026 versions.
>
> This is the evidence behind `docs/AUDIT.md`, which holds each route's
> recipe, cost and limits. It was condensed on 2026-09-25 to ruleset 15; the
> research as done for ruleset 14, which read the ledger at three boundaries,
> is this file at commit `0a6edad`. Sources are in §5.

---

## 1. What one audit consumes

`packages/verifier` rebuilds an artifact from first principles; the only
thing it takes from the backend is the artifact under test. A route is
measured by whether it can answer each Koios call below for a **past**
epoch, and at what cost.

**A. Chain facts** — any faithful block archive can answer these.

| Today (Koios)                               | Needed for                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `/tx_by_metalabel` (label 17, slot window)  | the definition, every response and cancellation in the survey's window     |
| `/tx_metadata`, `/tx_cbor`                  | payload bytes; `required_signers`, witnesses, `voting_procedures` (proofs) |
| `/tx_info` (`tx_block_index`, block epoch)  | the CIP-179 chain order for dedup; the block's authoritative epoch         |
| `/script_info` (JSON), creation tx position | native-script credentials whose script the carrying tx lacks               |
| `/proposal_list` (+ off-chain anchor fetch) | mechanism-B governance links                                               |

**B. Ledger facts at the end of `end_epoch = E`** — the oracle part; this is
where the trust sits (`ARCHITECTURE.md` §8).

| Today (Koios)                           | Meaning                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `/account_stake_history`, row `E+2`     | per stake credential: stake in the snapshot taken at the end of `E` (the `mark`) |
| `/account_update_history`               | per stake credential: registered at the end of `E`                               |
| `/drep_voting_power_history`, row `E+1` | per DRep: power in the distribution taken at the end of `E`                      |
| `/drep_updates`                         | per DRep: registered at the end of `E`                                           |
| `/epoch_info`, `/drep_epoch_summary`    | the two electorate totals, outside the hash                                      |

Keyholder surveys need nothing from B; a sealed survey's drand beacon is
already independently verifiable. The totals only scale turnout, and since
ruleset 14 they sit in the artifact's unhashed `info`: an audit that cannot
read them still reproduces the hash.

Every fact in B is taken at one instant, the boundary out of `E`, so a
ledger state standing early in `E+1` holds all of it. A tool that keeps
**per-epoch history** answers at any later tip; a tool that keeps only
**current state** must be stopped there, or keep its epoch snapshots. That
distinction decides most of §3.

**The floor.** Every route starts from Mithril-certified immutable files
unless it trusts someone's ledger snapshot: 15.4 GB uncompressed on preview,
18.9 GB on preprod, 234.5 GB on mainnet (2026-09-09).

---

## 2. The trust ladder

- **Rung 0 — an oracle.** Koios's numbers. Where the backend stands.
- **Rung 1 — one named party's ledger snapshot.** The Mithril _ancillary_
  archive is signed with an Ed25519 key held by the aggregator operator, not
  by the stake-based multi-signature. PRAGMA's Amaru bootstrap states and
  TxPipe's Dolos steles are the same rung: a ledger state produced by a
  party you name. Cheap — minutes — and the trust is a key, not a service.
- **Rung 2 — certified blocks, your own ledger.** Mithril-certified immutable
  files, replayed from genesis by a ledger implementation you run. Trust is
  the Mithril multi-signature plus that implementation's correctness. Hours
  on a testnet, most of a day on mainnet.

A node that **validates the chain from a downloaded state** sits between
Rungs 1 and 2. Amaru bootstraps from PRAGMA's end-of-epoch states, then
applies every later block to them; the maintainer accepts that as enough for
Tessera's audit (2026-09-16). Later blocks fail to validate wherever they
depend on a wrong part of the start state: an output they spend, a reward
balance they withdraw, a pool's stake in a leader check. Blocks carry no
ledger-state hash, though, so a part no later block touches stays unchecked,
such as the DRep delegation of an account that never transacts again.

**The reference numbers are db-sync's.** The artifact's weights come from
Koios, and a reimplementation that disagrees with db-sync by one lovelace on
one responder does not reproduce the hash. Every alternative ledger
publishes known mismatches against db-sync or the Haskell node. The one
ledger that is _by construction_ what db-sync saw is the Haskell node's own
code (§3, the Haskell ledger state).

---

## 3. Routes tried

### Dolos 2.0.0-alpha.0, from Mithril (Rung 2)

TxPipe's Rust data node replays Mithril's immutable files from genesis
through its own ledger, and `chain.stop_epoch = E+1` halts it one block
into `E+1`, after the boundary out of `E`. Mini-Blockfrost and minikupo
answer the whole of column A. No route serves B at a past epoch, and the
DRep power route serves the current value only, so the verifier reads B
from the stopped store with `dolos data dump-entity`. The gaps are written
up for TxPipe as txpipe/dolos#1373. Earlier releases are unfit: in 1.6 a
DRep's `amount` is its deposit.

**Measured on preview:**

- At 1428, one node stopped at 1429's first block: all 3023 DRep powers and
  the stake of 372 accounts equal Koios's rows for the end of 1428. The 372
  are the delegators of the 25 largest pools and every account with a
  certificate in 1428.
- At 1395, with ruleset 14's readings, against the Haskell ledger state of
  the Mithril ancillary archive and against Koios: DRep registration agrees
  on all 8978 DReps, and power on all but one, which keeps a vote delegation
  the Haskell ledger cleared under protocol 9 (txpipe/dolos#1364). Every row
  of `/epochs/1395/stakes` (79734) equals the Haskell `set`, and their total
  Koios's `active_stake`. Stake registration agrees on all 302383
  credentials. Column A equals Koios's on every label-17 transaction of the
  window, CBOR byte for byte.
- A store resumed with `bootstrap --continue` gives the same
  `dolos snapshot digest` as a replay from genesis to the same point.

Dolos's own accuracy work: an `epoch_pots` suite against db-sync for fixed
epochs (mainnet 242–500, preview 550–700), per-network boundary hacks that
show db-sync parity is the target, and PR #1228's whole DRep distribution
equal to db-sync's on preprod 306 and preview 1184.

**Verdict:** the cheapest Rung-2 route, and the one that audits a survey of
any age, since the latest Mithril snapshot certifies every file from
genesis. The residual risks are Dolos's ledger against db-sync on the
responders in the artifact, and reading B through a debug print.

### Amaru v10.11.20260918, from PRAGMA's states and Mithril (between Rungs 1 and 2)

PRAGMA's Rust node has **no query surface**: no node-to-client socket, no
LocalStateQuery, no HTTP beyond transaction submission. What it has is a
bootstrap from PRAGMA's states, a Mithril sync that validates every block,
and epoch snapshots in its own stores.

- **Bootstrap.** `amaru node bootstrap --epoch X` loads PRAGMA's states for
  the ends of `X-3` to `X-1`. PRAGMA makes them with a public command,
  `amaru snapshot create`, which runs the Haskell node's `db-analyser` over
  Mithril immutable files. The preview bucket lists three sets, starting
  1000, 1119 and 1393; whether older sets stay published is not known.
- **Snapshots.** The node writes snapshot `E` when its stable store crosses
  into `E+1`, `k` blocks in, or `3k/f` slots in when the chain grows
  slowly. That is the state at the end of `E`. Each transition prunes
  below the current epoch less 3, so snapshot `E` is gone on entering
  `E+3`. `amaru node run --max-extra-ledger-snapshots` keeps more (a number
  or `all`); `amaru mithril sync` keeps none extra. The chain store keeps
  every block from the bootstrap point on.
- **Reading.** `packages/amaru-store-reader`, a Rust program over
  `amaru-ledger`, `amaru-stores`, `amaru-kernel` and
  `amaru-ouroboros-traits`, opens the stores directly: registration and the
  open governance actions from snapshot `E`, stake and pool per account and
  DRep voting stake from `StakeSummary::new` over it, and the survey's
  transactions from the chain store's best chain. `StakeSummary` lists every
  registered account, not only the delegated ones its comment names.
  `build-stores` in `packages/amaru` picks the bootstrap set and the sync
  slot and runs every step.

The release binary cannot sync after a bootstrap. The defects are fixed in
the maintainer's fork (`fix/fast-sync-unavailable-stake-dist`) and reported
as pragma-org/amaru#1390, with fixes proposed in #1391, and #1393; they are
expected to land with PRAGMA's rework of that workflow, #1376.

**Measured on preview**, survey `1356f08e…:0` (`end_epoch` 1395):

- The rebuild from snapshot 1395, in stores `build-stores` made from the
  1119 set, matches the served ruleset-15 `artifactHash` (2026-09-25).
- In the ruleset-14 run, against the Haskell ledger state of the Mithril
  ancillary archive on the whole population: registration agrees on all
  110641 accounts and 8978 DReps (snapshot 1395); stake on all 79734 rows
  of the Haskell `set` and in total (snapshot 1393), Amaru also listing 641
  registered accounts of stake 0 that the Haskell snapshot omits, which
  reads the same; DRep power on all 3016 rows (snapshot 1394). A sample of
  129 credentials and 66 DReps chosen for the ways a row can go wrong
  agrees with Koios. Snapshots 1393 to 1395 go through the same code.
- Column A: the same 18 label-17 transactions as Koios in the window, slot,
  epoch and block index equal, CBOR identical byte for byte, and the one
  linking action equal.
- Two behaviours that change no reading. The snapshots keep the delegation
  rows of 79 accounts to pools since retired and 69 to DReps since
  deregistered, which the Haskell ledger deletes; `StakeSummary` drops them.
  And a DRep that registers and deregisters in one block (epochs 1353, 1354
  and 1360) makes the node log `ledger.dreps.remove … unknown drep` at the
  boundary, with the end state right on both sides.

The sync costs 10 s an epoch early on and 40 s on the full epochs past
1300, so the bootstrap set decides the cost. Amaru's conformance tests
cover preview epochs 1000 to 1315; this audit is the check for 1395.

**Verdict:** an audit with no Haskell tooling and nothing served, for a
survey no older than PRAGMA's oldest published set. The residual risks are
the unvalidated parts of the start state (§2) and the store format, which
is not a stable interface: the reader opens it directly and pins one
release. Native scripts need Koios (`docs/AUDIT.md`): the ledger rejects
script witnesses a transaction does not need, so a record's transaction
rarely carries the script, and Amaru's stores have no index from a script
hash to a script.

### The Haskell ledger state through Amaru's tooling (Rung 2, exact; not tried)

`amaru snapshot create --epoch E+1` yields the Haskell `NewEpochState` at the
end of `E` from Mithril immutables and `db-analyser`, reproducibly; a dump
program over `amaru-ledger` would turn it into the B rows, and column A
would still come from a block reader. Numbers are what db-sync saw, so a
disagreement with Koios is a Koios bug. Cost: `db-analyser`'s replay from
genesis (Amaru's CI replayed preprod to epoch 296 in 28 minutes), 50 GB of
disk on a testnet and 500 GB on mainnet. `db-analyser` 11.0.1 ignores
`--analyse-from`; 11.1.1 fixes it. **Verdict:** the adjudicator when two
routes disagree, not the daily path.

### Mithril ancillary archive (Rung 1; tried, set aside)

`packages/mithril`, tried on preview 2026-09-09 to 2026-09-16. An hourly
archive of the node's newest ledger snapshot, signed by the aggregator
operator's key and kept 28 days (28 epochs on preview, about five on preprod
and mainnet): 255 MB down, decoded in about 1.3 s. **Its state is never at
an epoch boundary**: the aggregator takes whichever snapshot is newest, and
node 11.0.1 takes them on a timer. Twelve of thirteen preview archives sat 2
to 30 blocks before the end of an immutable file, one 2 blocks past an epoch
boundary. A state inside `E` gives weights exactly, but registration as of
its own slot. **Verdict:** an estimate of a recent result, not an audit;
node 11.1's slot-aligned snapshots might change that (not verified).

---

## 4. Set aside

- **Dingo** (v0.70.12, testnets only). Its stake accounting was still being
  corrected (#3885), it never stores DRep voting power, and
  `GetDRepStakeDistr` is not implemented. Worth re-reading once its
  cross-network parity issue (#1903) closes.
- **Yaci Store** (2.0.1). Derives `epoch_stake` and `drep_dist` from genesis
  with db-sync parity as the goal and a published mismatch list: the most
  db-sync-shaped reimplementation, and the heaviest, at 20–40 minutes per
  mainnet epoch transition with no snapshot bootstrap. A possible preprod
  cross-check, not a cheap audit.
- **Adder and Oura.** Transports with no ledger state; Dolos already serves
  what they would carry.
- **Blockfrost as a second oracle** (maintainer, 2026-09-17). Still Rung 0,
  no route gives a past DRep power or the DRep total (blockfrost/openapi#471),
  and its label-17 route has no slot bounds.
- **Named-party snapshots other than Mithril's.** A Dolos stele, a PRAGMA
  set or Dingo's Mithril import replace an oracle service with a key, and
  none reaches an old survey. PRAGMA's sets serve as Amaru's starting point
  instead.

The gap `RESEARCH.md` §8.5 named is narrower, not closed: no API serves a
past epoch's DRep power (Dolos defers it, Dingo never stores it, Amaru has
none). Mithril's ledger-state certification, when it ships, would move
Rung 1 to Rung 2, and help an audit only if the certified state sits at an
epoch boundary.

---

## 5. Sources

- Amaru (https://github.com/pragma-org/amaru): README, `docs/BOOTSTRAP.md`,
  `docs/PUBLISHING_SNAPSHOTS.md`; at tag v10.11.20260918 and on the fork
  branch, `crates/amaru-ledger/src/summary/stake_distribution.rs`,
  `crates/amaru-ledger/src/state.rs`, `crates/amaru-stores/src/rocksdb/`,
  `crates/amaru-node/src/stages/config.rs`, `crates/amaru/src/bin/amaru/cmd/`;
  the preview bootstrap index
  `https://pub-b844360df4774bb092a2bb2043b888e5.r2.dev/preview/index.json`;
  issues #1390, #1393, PRs #1376, #1391; runs on preview on 2026-09-21,
  2026-09-22 and 2026-09-25.
- Dolos (https://github.com/txpipe/dolos): at 15f92c6e
  `crates/cardano/src/work.rs`, `crates/minibf/src/lib.rs` and its routes,
  `crates/cardano/src/model/`; PRs #1121, #1222, #1228; issues #1364, #1373;
  release `v2.0.0-alpha.0` (`a08c9d13`), run on preview 2026-09-17 to
  2026-09-23.
- Dingo (https://github.com/blinklabs-io/dingo) at d9080904:
  `ledger/queries.go`, `ledger/governance/epoch.go`; issues #3885, #1903.
- Yaci Store (https://github.com/bloxbean/yaci-store):
  `ledger-state-mismatches/2-0-0`, `getting-started/requirements`.
- Blockfrost `openapi.yaml` 0.1.93, issue blockfrost/openapi#471.
- Mithril: live artifact lists of the three aggregators; ancillary
  documentation at https://mithril.network/doc;
  `mithril-aggregator/src/services/snapshotter/compressed_archive_snapshotter.rs`
  at 621a9bd; issue #3269.
- db-sync schema (`epoch_stake`, `drep_distr`):
  https://github.com/IntersectMBO/cardano-db-sync/blob/master/doc/schema.md.
