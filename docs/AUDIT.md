# Auditing a survey result

A Tessera backend tallies each closed survey into a result artifact and serves
it under its content hash, `artifactHash`. An audit rebuilds the artifact from
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
- `--since <ISO date>`: where the scan of label-17 transactions starts; a
  survey defined earlier is not found. The default, 2026-06-01, is the
  backend's default floor.

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

An audit is therefore possible from the first block of `E + 2`. Before
reading a weight, the verifier checks that the end node's tip is the block
just before `E + 1`'s first on the after node, and that the after node is in
`E + 2` or later.

### Building the two nodes

This needs Dolos 2.0.0-alpha.0 or later (1.6 serves a DRep's deposit as its
power) and a reachable Mithril aggregator. The latest Mithril snapshot
certifies every immutable file from genesis, so a survey of any age can be
audited. The commands below are the ones tried on preview for a survey whose
`end_epoch` is 1395. On preview, epoch `E` owns immutable files `20E` to
`20E+19`, and the replay reads every downloaded file but the highest, so
standing at the end of `E` takes a download ending at `20E+20`.

1. Write a config in an empty directory:

   ```sh
   mkdir end && cd end
   dolos init --known-network preview
   ```

   Every answer is prompted: provide the genesis files, keep the whole history
   (the label-17 and transaction queries read the block archive), serve UTxO
   RPC and mini-Blockfrost, no relay. At the last prompt, the bootstrap
   method, press Ctrl-C: the config is saved by then.

2. Replay to the end of `E`:

   ```sh
   dolos bootstrap mithril --download-end 27920
   ```

   This downloads files 0 to 27920, checks the Mithril certificate chain and
   a Merkle proof over them, and replays them from genesis. Never run
   `dolos daemon` or `dolos sync` in this directory: either syncs past the end
   of `E`.

3. Copy the store and continue the copy to one block into `E + 2`:

   ```sh
   cd ..
   cp -c -R end after   # an APFS clone; cp -R elsewhere
   cd after
   ```

   Add `stop_epoch = 1397` to the `[chain]` section of `after/dolos.toml`,
   then:

   ```sh
   dolos bootstrap --continue mithril --download-start 27919 --download-end 27941 --download-dir snapshot
   dolos doctor reset-wal
   ```

   `--continue` imports from the store's last block, so the download starts
   at the file holding it, `20E+19`, and ends one past `20(E+2)`, the file
   holding `E + 2`'s first block. The bootstrap exits with
   `forced stop epoch reached`, as expected. This release skips seeding the
   write-ahead log on that exit, and `reset-wal` seeds it. On preview this
   took 19 seconds. A replay from genesis to the same point gave the same
   `dolos snapshot digest`, so resuming loses nothing.

4. Serve both at once. In `after/dolos.toml`, give `[serve.minibf]` and
   `[serve.grpc]` their own `listen_address` (`[::]:3001` and `[::]:50052`),
   and add minikupo, the one API that serves a native script's bytes by hash:

   ```toml
   [serve.minikupo]
   listen_address = "[::]:1442"
   ```

   Then run `dolos serve` in each directory. `serve` never syncs, and
   restarting it leaves the tip where it was.

5. Verify, from the repository root:

   ```sh
   pnpm --filter cardano-tessera-verifier verify -- \
     --backend <backend URL> --survey <txHash>:<index> \
     --dolos-end http://localhost:3000 --dolos-after http://localhost:3001 \
     --minikupo http://localhost:1442
   ```

   For the preview survey above, the rebuild's `artifactHash` equals the
   rebuild from Koios.

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
- The recipe is measured on one survey, on preview, with one alpha release.
  Storage formats and flags may change before Dolos 2.0.

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
