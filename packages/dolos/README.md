# cardano-tessera-dolos

The verifier's inputs read from the queries of two Dolos nodes instead of
Koios: a survey's label-17 records, their proofs and block positions, its
governance links, and its responders' weights and registration. Private to the
workspace; the verifier takes it with `--dolos-end`, `--dolos-after` and
`--minikupo`.

Dolos answers most ledger questions for its tip only, so each fact is read
from the node that can answer it: DRep power and registration and stake
registration from a node standing at the last block of the survey's
`end_epoch`, and active stake and every chain fact from one at least a block
into `end_epoch + 2`. Both positions are checked before a weight is read. The
electorate totals sit outside the artifact's hash and no Dolos route serves
the DRep total, so this source reads neither.

How to build the two nodes, what an audit through them trusts, and its
limits: `docs/AUDIT.md`. The research it came from: `backend/RESEARCH-AUDIT.md`.
