# cardano-tessera-dolos

The verifier's inputs read from the queries of two Dolos nodes instead of
Koios: a survey's label-17 records, their proofs and block positions, its
governance links, and its responders' weights and registration. Private to
the workspace; the verifier takes it with `--dolos-end`, `--dolos-after` and
`--minikupo`. The audit research it came from is `backend/RESEARCH-AUDIT.md`.

Each node replays Mithril-certified immutable files from genesis through
Dolos's own ledger, so an audit trusts the Mithril multi-signature and Dolos's
ledger, not a service (Rung 2 in `RESEARCH-AUDIT.md`). The electorate totals
sit outside the artifact's hash and no Dolos route serves the DRep total, so
this source reads neither.

## Two stopping points

Dolos answers most ledger questions for its tip only, so a survey with
`end_epoch = E` takes two nodes:

- the **end** node, standing at the last block of `E`: DRep voting power and
  registration, and stake registration;
- the **after** node, at least one block into `E + 2`: each account's active
  stake for `E`, which Dolos logs when it closes `E + 1`, and every chain
  fact (records, transactions, blocks, proposals, native scripts).

The verifier checks both before reading a weight: the end node's tip must be
the block just before `E + 1`'s first on the after node, and the after node
must be in `E + 2` or later.

## Building the two nodes

Tried on preview with Dolos 2.0.0-alpha.0, for a survey whose `end_epoch` is
1395; the commands use those numbers. Needs a reachable Mithril aggregator.
The latest Mithril snapshot certifies every immutable file from genesis, so a
survey of any age can be audited. On preview, epoch `E` owns immutable files
`20E` to `20E+19`, and the replay reads every downloaded file but the highest,
so standing at the end of `E` takes a download ending at `20E+20`. Other
networks have not been tried.

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
   a Merkle proof over them, and replays them from genesis. Preview through
   1395 took 53 minutes on a 12-core Mac, with 14 GB downloaded and a 14 GB
   store. Never run `dolos daemon` or `dolos sync` in this directory: either
   syncs past the end of `E`.

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

   The exit codes are the same as with Koios. For the preview survey above,
   the rebuild takes about 2 seconds, and its `artifactHash` equals the
   rebuild from Koios.

## Limits

- A DRep that registered during `E` stops the read. For such a DRep, Dolos's
  `amount` is its deposit, not its power for `E`, and how to read that power
  has not been measured.
- Dolos keeps some vote delegations the ledger cleared under protocol 9
  (txpipe/dolos#1364), which overstates those DReps' power. If such a DRep
  responded, the hash differs.
- Without `--minikupo`, the proof of a native-script credential that its
  transaction does not carry stays unknown. With it, such a script counts
  even if it first appeared after that transaction: minikupo does not say
  when a script appeared, so the check the Koios source makes is skipped here.
- The recipe is measured on one survey, on preview, with one alpha release.
  Storage formats and flags may change before Dolos 2.0.
