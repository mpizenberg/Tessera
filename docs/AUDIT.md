# Auditing a survey result

A Tessera backend tallies each closed survey into a result artifact and serves
it under its content hash, `artifactHash`. The artifact exists once the end of
the survey's `end_epoch` can no longer roll back, about 12 hours after that
epoch ends on mainnet and preprod and 3.5 on preview. An audit rebuilds the artifact from
the chain and compares the two hashes. `packages/verifier` does the rebuild.
This guide says what it needs, where it can get it, and whom each source asks
you to trust. The evidence behind it (measurements, candidate tools, source
readings) is `backend/RESEARCH-AUDIT.md`.

## The problem

The verifier takes one thing from the backend: the artifact under test. It
reads everything the tally is built from out of a chain source you choose (the
survey's definition, every response and its answers, the credential proofs,
the weights) and runs the counting rules pinned in this repository
(`backend/TALLY-SPEC.md`). An artifact counted under other rules still matches
if those rules give the same result. When the rules differ, the verifier
prints the artifact's `rulesetHash`, and the table in `packages/cip179`'s
README gives the release that counts under it: rerunning a mismatch with that
release tells a rule change from a fault. A backend that dropped, added or
altered a response, or used a wrong weight, cannot reproduce the hash.
Besides the artifact, the verifier asks the backend only which network it
serves, and reads its response list only to report where it differs from the
chain's.

| Exit | Verdict       | Meaning                                                                          |
| ---- | ------------- | -------------------------------------------------------------------------------- |
| 0    | MATCH         | The artifact reproduces from chain data.                                         |
| 1    | MISMATCH      | It does not; the differences are printed.                                        |
| 2    |               | A usage error, a survey not found or not yet finalized, or a failed fetch.       |
| 3    | INDETERMINATE | An input could not be resolved yet, such as an anchor document; retry later.     |
| 4    | UNTALLIABLE   | The survey's on-chain definition is invalid, so no artifact should exist at all. |

## The data

Two kinds of input, trusted differently.

**Chain facts**, fixed by the blocks: the label-17 records of the survey's
window (its definition, responses and cancellations); each transaction's
bytes, whose signers, witnesses and votes prove credentials; its block epoch
and position in the block, which order duplicate responses; the governance
actions that can link the survey, with their anchor documents; and native
scripts by hash. Any source that serves the blocks faithfully gives the same
answers.

**Ledger facts at the survey's `end_epoch` `E`**, which a ledger computes from
the blocks and no block states: each Stakeholder responder's active stake for
`E`, each DRep responder's voting power for `E`, and whether each was
registered at the end of `E`. Keyholder surveys need none. This is where an
audit's trust sits, and what sets the approaches below apart.

Two more inputs need no choice of source. A sealed survey's reveal takes the
drand beacon of its round, which the verifier fetches and checks against
drand's public key. The electorate totals, which scale turnout, sit outside
the hash: the verifier re-reads them where its source serves them and only
notes a difference.

## Running the verifier

It needs Node 22.5 or later and pnpm 10 or later, in a clone of this
repository:

```sh
git clone https://github.com/mpizenberg/Tessera.git
cd Tessera
pnpm install
```

Every approach takes the backend's URL, such as
`https://tessera-backend-preview.matthieu-pizenberg.workers.dev` on preview,
and the survey's key, `<txHash>:<index>`: its defining transaction and its
index there. The app's survey page address ends with the key, its colon
written `%3A`.

Every approach also takes `--out <dir>`, which keeps the two tallies a MATCH
or MISMATCH compared: `rebuilt.json`, the rebuilt tally in exactly the bytes
its hash is computed over, and `served.json`, the artifact exactly as the
backend served it. The saved tally can be checked later with no clone and no
network: its blake2b-256 is the rebuilt hash, which on a MATCH is the
survey's `artifactHash`.

```sh
python3 -c 'import hashlib, sys; print(hashlib.blake2b(open(sys.argv[1], "rb").read(), digest_size=32).hexdigest())' rebuilt.json
```

GNU coreutils' `b2sum -l 256 rebuilt.json` prints the same hash.

## Koios

**Trust:** the Koios instance you query, and the db-sync behind it. db-sync
runs the Haskell node's own ledger, so its numbers are the reference; what you
trust is the operator serving them faithfully. The backend reads its weights
from Koios as well, so this audit catches a backend that miscounted or altered
data, not an error in Koios. Pointing `--koios` at an instance you run, or at
another operator's, changes whom you trust.

**Cost:** seconds, nothing stored.

```sh
pnpm --filter cardano-tessera-verifier verify -- \
  --backend <backend URL> --survey <txHash>:<index>
```

- `--koios <url>`: another Koios instance. The default is the public one for
  the backend's network.
- `--token <token>`, or `KOIOS_TOKEN` in the environment: a Koios token, for
  higher rate limits.

The scan of label-17 transactions covers the survey's window only, from the
block of its defining transaction through the last slot of `end_epoch`: a
record outside it does not count.

## Dolos from Mithril

**Trust:** Mithril's stake-based multi-signature over the chain's immutable
files, and Dolos's implementation of the ledger rules, which computes the
ledger facts from those files on your machine. No service is asked anything.
Dolos is not the Haskell ledger, though: where the two differ on a responder,
the hash differs (see the limits below).

**Cost:** on preview, a replay from genesis took 53 minutes on a 12-core Mac,
with 7 GB of memory, 14 GB downloaded and a 14 GB store; the rebuild takes
about 2 seconds. Preprod and mainnet have not been tried. Dolos's developers
report 94 minutes for preprod, download included, and under 20 hours for
mainnet, whose archive they put at 250 to 300 GB.

Dolos answers most ledger questions for its tip only, so a survey with
`end_epoch = E` takes two nodes, served at the same time:

- the **end** node, standing at the last block of `E`: DRep voting power and
  registration, and stake registration;
- the **after** node, at least one block into `E + 2`: each account's active
  stake for `E`, which Dolos logs when it closes `E + 1`, and every chain
  fact.

The verifier can read from the first block of `E + 2`. Before reading a
weight, it checks that the end node's tip is the block just before `E + 1`'s
first on the after node, and that the after node is in `E + 2` or later.

### Building the two nodes

This needs Dolos 2.0.0-alpha.0 on the `PATH` (1.6 serves a DRep's deposit as
its power, and later releases are untried) and a reachable Mithril
aggregator. The latest Mithril snapshot certifies every immutable file from
genesis, so a survey of any age can be audited. One command builds both
nodes, from the repository root:

```sh
pnpm --filter cardano-tessera-dolos nodes -- \
  --backend <backend URL> --survey <txHash>:<index> --dir <empty directory>
```

It reads the network and `E` from the backend, which adds no trust: the
verifier checks both nodes against the `end_epoch` it reads from the chain.
It then works one step at a time, printing each command before running it,
and a rerun skips the steps already done:

1. It prints the `dolos init` command that writes the end node's config,
   and stops. `init` asks every question itself. Take each default it
   offers except the history to keep: the label-17 and transaction queries
   need "keep everything". Its last question, the bootstrap method, comes
   after the config is saved: press Ctrl-C there, then run the command
   again. The command refuses a config that prunes history, lacks
   mini-Blockfrost or serves another API on a port, since the after node, a
   copy, would bind that port a second time.
2. It bootstraps the end node from Mithril to the last block of `E`,
   checking the certificate chain and a Merkle proof over the files. This
   is the long step. Never run `dolos daemon` or `dolos sync` in either
   node's directory: both sync past the node's stopping point.
3. It copies the end node into `after` and continues the copy a block into
   `E + 2`, where `stop_epoch` halts it with `forced stop epoch reached`, as
   expected. It then reseeds the write-ahead log, which this release skips
   on that stop. The after node's own settings sit in `after/after.toml`,
   which Dolos merges over the copied `dolos.toml`: the stop epoch,
   mini-Blockfrost on port 3001, and minikupo, the one API that serves a
   native script's bytes by hash, on port 1442. On preview this step took
   25 seconds, and a replay from genesis to the same block gave the same
   `dolos snapshot digest`, so continuing a copy loses nothing.
4. It prints the commands that serve both nodes, each in its own terminal,
   and the verify command with every URL filled in. `serve` never syncs,
   and restarting it leaves the tip where it was. Stop both before running
   the command again: Dolos locks a store it serves.

For the preview survey whose `end_epoch` is 1395, the rebuild's
`artifactHash` equals the rebuild from Koios.

What the command computes, so it can be checked rather than trusted: an
immutable file spans `10k` slots, `k` the security parameter (2160 on
mainnet and preprod, 432 on preview). That is a Byron epoch's length, so a
Byron epoch is one file and a Shelley epoch twenty. Shelley starts at epoch
208 on mainnet, 4 on preprod and 0 on preview, so with `s` that epoch,
epoch `E`'s files start at `s + 20(E - s)`: `20E` on preview. A replay reads
every downloaded file but the highest. So the end node downloads through
the first file of `E + 1`. The after node downloads from the file holding
the end node's last block through one past the first file of `E + 2`.
Before each bootstrap, the command checks that the aggregator certifies
the highest file it will download. Mithril's latest snapshot trails the
chain by about four files, so the after node can be built from about six
files into `E + 2`: some seven hours on preview, a day and a half on
mainnet.

### Limits

- A DRep that registered during `E` stops the read. For such a DRep, Dolos's
  `amount` is its deposit, not its power for `E`, and how to read that power
  has not been measured.
- Dolos keeps some vote delegations the ledger cleared under protocol 9
  (txpipe/dolos#1364), which overstates those DReps' power. If such a DRep
  responded, the hash differs.
- Without `--minikupo`, the proof of a native-script credential that its
  transaction does not carry stays unknown. With it, two such scripts are
  judged unlike the Koios source, and the hash differs if a survey holds one.
  A script first on chain after the transaction that needs it counts here,
  since minikupo does not say when a script appeared. A script only ever
  published in auxiliary data is not found, since minikupo indexes witness
  sets and outputs only.
- The electorate totals are not read: no Dolos route serves the DRep total.
- The command is measured on one survey, on preview, with one alpha
  release. Storage formats and flags may change before Dolos 2.0.

## Amaru from PRAGMA's states and Mithril

**Trust:** PRAGMA's published end-of-epoch ledger states, a download signed
by nobody's stake, and Amaru's implementation of the ledger rules, which
validates every Mithril-certified block after them against those states on
your machine. A wrong part of the start state fails the first later block
that depends on it; a part no block depends on, such as the delegation of an
account that never transacts again, stays unchecked. Amaru is not the
Haskell ledger either, and its conformance tests cover preview epochs 1000
to 1315; on epoch 1395 its readings equalled the Haskell node's on every
account and DRep.

**Cost:** on preview, a bootstrap took 3.5 minutes and 722 MB, a sync of 280
epochs about 90 minutes with 1.1 GB of memory, 2.2 GB of immutable files
and 3 GB of stores; reading the stores takes seconds and the rebuild under
a second. The sync is proportional to the epochs between the bootstrap set
and the survey's end. Preprod and mainnet have not been tried.

Amaru has no query surface. It keeps its last three epoch snapshots and
every block it validated in RocksDB stores, and `packages/amaru-store-reader`,
a Rust crate built with Amaru's own toolchain, prints from them what the
verifier needs: the snapshots of `E-2` to `E` and a walk of the survey's
window. Its README has the commands. In outline, for a survey created in
epoch `C` with `end_epoch = E`:

1. `amaru node bootstrap` from the newest PRAGMA set ending before `C`, so
   the stores hold the survey's whole window. The release binary cannot
   then sync from Mithril: until upstream ships the fixes, build the
   maintainer's fork branch named in `backend/RESEARCH-AUDIT.md`.
2. `amaru mithril sync --ingest-until-slot <slot>` with a slot inside
   `E + 1`, past its first `k` blocks (432 on preview, 2160 elsewhere).
   Amaru writes snapshot `E` at that point and keeps three snapshots, so
   a stop inside `E + 1` leaves `E-2` to `E` and the transition into
   `E + 2` would drop `E-2`.
3. Print the three snapshots and the walk into one directory, then:

```sh
pnpm --filter cardano-tessera-verifier verify -- \
  --backend <backend URL> --survey <txHash>:<index> --amaru <dir>
```

The verifier checks that the walk reaches the end of `E` and keeps the
survey's window from it. Each ledger fact is read from the snapshot that
holds it: registration from `E`, a stakeholder's stake from `E-2`, a DRep's
power from `E-1`.

### Limits

- Amaru keeps no index from a script hash to a script. A native-script
  responder is checked only when the transaction carrying its record
  witnesses the script; otherwise the response is excluded with a note and
  the hash differs. Koios resolves such a script by hash, Dolos through
  minikupo.
- Whether PRAGMA keeps old bootstrap sets published is not known; the
  preview bucket lists three. A survey older than the oldest set has no
  starting point.
- The electorate totals are not read.
- Measured on one survey, on preview, with one beta release, whose crates
  are internal APIs: the reader pins that release.

## Other routes

None of these runs in the verifier today; `backend/RESEARCH-AUDIT.md`
covers each.

- **A Mithril ledger snapshot** (`packages/mithril`). The aggregator's hourly
  archive of the node's ledger state, signed by the aggregator operator's key
  rather than by the stake multi-signature, and kept 28 days. The hourly
  schedule will usually not match the exact end of `end_epoch`, so a result
  built from it is an estimate.
- **One Dolos node instead of two.** The after node serves only each
  account's active stake for `E`, which the end node already holds in its
  state. A small Rust program reading it there would drop the after node.
- **The Haskell ledger through Amaru's tooling.** db-sync's own ledger,
  replayed from Mithril-certified files: exact by construction, and the
  arbiter when Koios and Dolos disagree.
- **Yaci Store from genesis.** A reproduction of db-sync's tables; a
  multi-day job on mainnet.
