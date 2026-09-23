# cardano-tessera-dolos

The verifier's inputs read from a Dolos node instead of Koios: a survey's
label-17 records, their proofs and block positions, its governance links, and
its responders' weights and registration. Private to the workspace; the
verifier takes the node's directory with `--dolos`.

The node is a replay from Mithril stopped at the first block after the
survey's `end_epoch`, so its store holds the ledger at that epoch's end, the
instant the tally weighs. The verifier serves it to read the chain, then
stops it and reads each responder's weight and registration with `dolos data
dump-entity`, since no route serves an account's stake in the snapshot taken
at the end of an epoch. The node's position is checked before a weight is
read. The electorate totals sit outside the artifact's hash and no Dolos
route serves the DRep total, so this source reads neither.

`pnpm --filter cardano-tessera-dolos build-node -- --backend <url> --survey
<key> --dir <dir>` builds the node for a survey from Mithril, skipping on a
rerun the steps already done, and prints the command that runs the verifier.
How that works, what an audit through it trusts, and its limits:
`docs/AUDIT.md`. The research it came from: `backend/RESEARCH-AUDIT.md`.
