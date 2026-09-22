# cardano-tessera-amaru

The verifier's inputs read from what `amaru-store-reader` printed out of an
Amaru node's stores instead of Koios: a survey's label-17 records, their
proofs and block positions and its governance links from the block walk and
the epoch snapshot, its responders' weights and registration from the
snapshots. Private to the workspace; the verifier's `--amaru` flag names a
directory holding `snapshot-<epoch>.json` for `end_epoch - 2` to `end_epoch`
and `blocks.json` for a walk from the survey's defining transaction through
the last slot of `end_epoch`. How to produce those files:
`packages/amaru-store-reader/README.md`.

Each question is read from the snapshot that answers it: registration at
`end_epoch`, of a stake credential or a DRep, from that epoch's snapshot; a
stakeholder's active stake from the snapshot two epochs earlier, behind a
pool still standing there; a DRep's voting power from the snapshot one epoch
earlier. The electorate totals sit outside the artifact's hash and are not
read. Amaru keeps no index from a script hash to a script, so a native-script
credential its own transaction does not witness leaves that proof unknown:
the rebuild excludes such a response with a note, and the artifact's hash,
computed with the script resolved, then no longer matches.

What an audit through these stores trusts and its limits:
`backend/RESEARCH-AUDIT.md`.
