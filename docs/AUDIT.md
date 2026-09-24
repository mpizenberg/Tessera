# Auditing a survey result

A Tessera backend tallies each closed survey into a result artifact and serves
it under its content hash, `artifactHash`. The artifact exists once the end of
the survey's `end_epoch` can no longer roll back and the ledger at that
instant has been written whole, about 12 hours after that epoch ends. An
audit rebuilds the artifact from
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
the blocks and no block states, all read at the end of `E`: each
Stakeholder responder's stake in the snapshot the ledger takes then, each
DRep responder's power in the distribution it takes then, and whether each
was registered. Keyholder surveys need none. This is where an
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

Every approach takes the backend's URL and the survey's key. The backend is
the Tessera deployment whose result you are auditing, the one behind the app
you read it in. Each deployment serves one network, which its `/health` route
names. The Tessera deployments are:

| Network | App                                                      | Backend                                                          |
| ------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| mainnet | `https://tessera-mainnet.matthieu-pizenberg.workers.dev` | `https://tessera-backend-mainnet.matthieu-pizenberg.workers.dev` |
| preprod | `https://tessera-preprod.matthieu-pizenberg.workers.dev` | `https://tessera-backend-preprod.matthieu-pizenberg.workers.dev` |
| preview | `https://tessera-preview.matthieu-pizenberg.workers.dev` | `https://tessera-backend-preview.matthieu-pizenberg.workers.dev` |

The survey's key is `<txHash>:<index>`: its defining transaction and its index
there. The app's survey page address ends with the key, its colon written
`%3A`.

While it runs, the verifier names each step on stderr: reading the survey's
records, their evidence, the weights and the totals. On a terminal each step
also counts what it has done so far: Koios requests, or the responders read
from a Dolos node out of the total. The verdict goes to stdout.

Every approach also takes `--out <dir>`, which keeps the two artifacts a
MATCH or MISMATCH compared: `served.json`, exactly as the backend served it,
and `rebuilt.json`, the verifier's own. Only their `tally` sections are
compared. Their `info` and `provenance` sections always differ, since they
describe two different runs: the source read, when, and the electorate
totals, governance links and drand beacon each run found. On a mismatch they
are the first clues. Both files are canonical JSON (keys sorted, no
whitespace), so on a MATCH their `tally` sections are the same bytes.

A saved file can be checked later with no clone and no network: the
blake2b-256 of its `tally` section, in canonical form, is the hash, which on
a MATCH is the survey's `artifactHash`.

```sh
python3 -c 'import hashlib, json, sys; t = json.dumps(json.load(open(sys.argv[1]))["tally"], sort_keys=True, separators=(",", ":"), ensure_ascii=False); print(hashlib.blake2b(t.encode(), digest_size=32).hexdigest())' rebuilt.json
```

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
with 7 GB of memory, 14 GB downloaded and a 14 GB store (to epoch 1429: about
50 minutes and 16 GB); the rebuild takes seconds, plus 0.4 seconds per
responder read from the store. Preprod and mainnet have not been tried. Dolos's developers
report 94 minutes for preprod, download included, and under 20 hours for
mainnet, whose archive they put at 250 to 300 GB.

One node serves a survey with `end_epoch = E`: a replay stopped at the first
block of `E + 1`. Dolos runs the boundary out of `E` when that block
arrives, applies the block and stops, so its store holds the ledger at the
end of `E`: the DRep distribution taken then, and each account's stake and
pool in the snapshot taken then (its `mark`). No route serves the second
(txpipe/dolos#1373 asks for history routes), so
the ledger is read with `dolos data dump-entity`, which prints one stored
account, DRep or pool. The one block of `E + 1` writes neither snapshot;
registration is judged by slot against `E + 1`'s first, and a responder
whose registration changed in that block stops the read (see the limits).

The verifier serves the node itself (`dolos -c audit.toml serve`, which
never syncs) while it reads the chain through mini-Blockfrost and minikupo,
then stops it, since Dolos locks a store it serves, and dumps each
responder, about 0.4 seconds apiece. Before reading a weight, it checks
that the store stands in `E + 1`.

### Building the node

This needs Dolos 2.0.0-alpha.0 on the `PATH` (1.6 serves a DRep's deposit as
its power, and later releases are untried) and a reachable Mithril
aggregator. The latest Mithril snapshot certifies every immutable file from
genesis, so a survey of any age can be audited. One command builds the node,
from the repository root:

```sh
pnpm --filter cardano-tessera-dolos build-node -- \
  --backend <backend URL> --survey <txHash>:<index> --dir <empty directory>
```

It reads the network and `E` from the backend, which adds no trust: the
verifier checks the node against the `end_epoch` it reads from the chain.
It then works one step at a time, printing each command before running it,
and a rerun skips the steps already done:

1. It prints the `dolos init` command that writes the node's config, and
   stops. `init` asks every question itself. Take each default it offers
   except the history to keep: the label-17 and transaction queries need
   "keep everything". Its last question, the bootstrap method, comes after
   the config is saved: press Ctrl-C there, then run the command again. The
   command refuses a config that prunes history.
2. It writes `audit.toml`, which Dolos merges over `dolos.toml`: the stop
   epoch `E + 1`, mini-Blockfrost on port 3000 and minikupo, the one API
   that serves a native script's bytes by hash, on port 1442.
3. It bootstraps the node from Mithril to the first block of `E + 1`,
   checking the certificate chain and a Merkle proof over the files, where
   `stop_epoch` halts it with `forced stop epoch reached`, as expected. This
   is the long step. Never run `dolos daemon` or `dolos sync` in the node's
   directory: both sync past its stopping point.
4. It prints the verify command:

```sh
pnpm --filter cardano-tessera-verifier verify -- \
  --backend <backend URL> --survey <txHash>:<index> --dolos <directory>
```

On preview, for `E` = 1428, the node's 3023 DRep powers equal Koios's
distribution taken at the end of 1428, and the stake of 372 accounts (the
delegators of the 25 largest pools, and every account with a certificate in 1428) equals Koios's mark.

What the command computes, so it can be checked rather than trusted: an
immutable file spans `10k` slots, `k` the security parameter (2160 on
mainnet and preprod, 432 on preview). That is a Byron epoch's length, so a
Byron epoch is one file and a Shelley epoch twenty. Shelley starts at epoch
208 on mainnet, 4 on preprod and 0 on preview, so with `s` that epoch,
epoch `E`'s files start at `s + 20(E - s)`: `20E` on preview. A replay reads
every downloaded file but the highest, so the node downloads through one
past the first file of `E + 1`. Before the bootstrap, the command checks
that the aggregator certifies that file. Mithril's latest snapshot trails
the chain by about four files, so the node can be built from about six
files into `E + 1`: some seven hours on preview, a day and a half on
mainnet.

### Limits

- A responder whose registration changed in the first block of `E + 1`
  stops the read: a DRep's unregistration there zeroes the power the end of
  `E` counted, and an account's deregistration there hides whether it was
  registered before. Nothing of the kind has been seen.
- Dolos keeps some vote delegations the ledger cleared under protocol 9
  (txpipe/dolos#1364), which overstates those DReps' power. If such a DRep
  responded, the hash differs.
- Two native scripts that a record's transaction does not carry are judged
  unlike the Koios source, and the hash differs if a survey holds one. A
  script first on chain after the survey's `end_epoch` counts here, since
  minikupo does not say when a script appeared. A script only ever
  published in auxiliary data is not found, since minikupo indexes witness
  sets and outputs only.
- The electorate totals are not read: no Dolos route serves the DRep total.
- The ledger is read from `dump-entity`'s debug print, which is no stable
  interface: a Dolos release that changes a field's name or shape makes the
  read fail, not guess.
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
verifier needs: a walk of the survey's window, kept to the transactions that
name the survey, and snapshot `E`, the ledger at the end of the survey's
`end_epoch`, kept to the credentials that respond. The verifier reads those
printed files and nothing else. Every ledger fact comes from snapshot `E`:
registration, a stakeholder's stake behind its pool (the mark taken at the end
of `E`), and a DRep's power (the distribution taken then).

### Building the stores

This needs `cargo`, through `rustup`, which fetches the nightly the reader
pins. It also needs an Amaru binary that can sync from Mithril after a
bootstrap, which the releases cannot yet: until PRAGMA ships the fixes, build
the maintainer's fork, branch `fix/fast-sync-unavailable-stake-dist` of
`https://github.com/mpizenberg/amaru`, with `cargo build --release`. One
command builds the stores and reads them, from the repository root:

```sh
pnpm --filter cardano-tessera-amaru build-stores -- \
  --backend <backend URL> --survey <txHash>:<index> --dir <directory> \
  --amaru <path to the amaru binary>
```

`--amaru` can be left out when `amaru` is on the `PATH`. The command reads
the network, the survey's creation slot and epoch `C`, and `E` from the
backend, which adds no trust: a walk started too late misses the survey's
definition, and the verifier checks the walk against the `end_epoch` it
reads from the chain. It then works one step at a time, printing each
command before running it, and a rerun skips the steps already done:

1. `amaru node bootstrap --epoch X`, which loads PRAGMA's states at the end
   of `X - 3`, `X - 2` and `X - 1`. `X` is the latest start PRAGMA's index
   offers that is no later than `C`, so the chain store holds the survey's
   whole window.
2. `amaru mithril sync --ingest-until-slot <slot>`, which validates every
   Mithril-certified block from there to the slot `3k/f` into `E + 1`
   (25920 on preview, 129600 elsewhere), the window within which the chain
   grows by `k` blocks, where Amaru writes snapshot `E`. This is the long
   step. A sync that stops short, because Mithril does not certify that far
   yet, leaves snapshot `E` unwritten, and the command says to run again
   later. The node keeps snapshot `E` until its transition into `E + 3`.
3. `amaru-store-reader blocks`, from the survey's slot through the last slot
   of `E`, into `blocks.json`.
4. `credentials.json`: every credential the walk's responses name as a
   Stakeholder or a DRep.
5. `amaru-store-reader snapshot` of `E` for those credentials, into
   `snapshot-<E>.json`.
6. It prints the verify command:

```sh
pnpm --filter cardano-tessera-verifier verify -- \
  --backend <backend URL> --survey <txHash>:<index> --amaru <directory>
```

On preview, a survey created in 1365 with `E` = 1395 starts from 1119, and
its rebuild from these stores gave the same `artifactHash` as the Koios
source.

### Limits

- Amaru keeps no index from a script hash to a script, and its ledger
  rejects a witnessed script the transaction does not need, so a record in
  a metadata-only transaction never carries its native script. Add
  `--koios-scripts` (with `--koios`, `--token` if needed) to have Koios
  resolve such scripts by hash; the rest of the inputs still come from the
  stores. Without it, every record whose credential is a native script is
  unproven, so the hash differs wherever the emitter resolved one.
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
- **The Haskell ledger through Amaru's tooling.** db-sync's own ledger,
  replayed from Mithril-certified files: exact by construction, and the
  arbiter when Koios and Dolos disagree.
- **Yaci Store from genesis.** A reproduction of db-sync's tables; a
  multi-day job on mainnet.
