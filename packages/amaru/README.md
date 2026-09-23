# cardano-tessera-amaru

The verifier's inputs read from what `amaru-store-reader` printed out of an
Amaru node's stores instead of Koios: a survey's label-17 records, their
proofs and block positions and its governance links from the block walk and
the epoch snapshot, its responders' weights and registration from the
snapshots. Private to the workspace; the verifier's `--amaru` flag names a
directory holding `blocks.json` for a walk from the survey's defining
transaction through the last slot of `end_epoch`, and
`snapshot-<epoch>.json` for `end_epoch - 2` to `end_epoch`. The snapshots
hold only the credentials they were asked about; the `credentials` command
prints those from the walk, every credential the survey's responses name as
a Stakeholder or a DRep, and the tally refuses a snapshot missing one it
needs. How to produce those files: `packages/amaru-store-reader/README.md`.

Each question is read from the snapshot that answers it: registration at
`end_epoch`, of a stake credential or a DRep, from that epoch's snapshot; a
stakeholder's active stake from the snapshot two epochs earlier, behind a
pool still standing there; a DRep's voting power from the snapshot one epoch
earlier. The electorate totals sit outside the artifact's hash and are not
read.

Native scripts are the approach's gap. Amaru keeps no index from a script
hash to a script, and its ledger rejects a witnessed script the transaction
does not need, or takes from a reference input. A record in a metadata-only
transaction needs no script, so a native-script credential's script is
almost never in the record's own transaction. `AmaruChain` therefore takes
a script lookup from its caller; the verifier's `--koios-scripts` passes
Koios's, which checks each script against its hash and that it was on chain
by the transaction needing it. Without a lookup, a transaction missing a
script it needs has its whole proof unknown: every response in it is
excluded with a note, a cancellation in it does not cancel, and a
definition in it makes the rebuild indeterminate; the first two change the
hash.

What an audit through these stores trusts and its limits:
`backend/RESEARCH-AUDIT.md`.
