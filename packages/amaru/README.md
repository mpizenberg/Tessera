# cardano-tessera-amaru

The verifier's inputs read from what `amaru-store-reader` printed out of an
Amaru node's stores instead of Koios: a survey's label-17 records, their
proofs and block positions and its governance links from the block walk and
the epoch snapshot, its responders' weights and registration from the
same snapshot. Private to the workspace; the verifier's `--amaru` flag names
a directory holding `blocks.json` for a walk from the survey's defining
transaction through the last slot of `end_epoch`, and
`snapshot-<end_epoch>.json`. The snapshot holds only the credentials it was
asked about, every one the survey's responses name as a Stakeholder or a
DRep, and the tally refuses a snapshot missing one it needs.

The `build-stores` command produces that directory for one survey, from
nothing: it bootstraps an Amaru node from PRAGMA's states no later than the
survey's creation epoch, syncs it from Mithril until the ledger writes
snapshot `end_epoch`, and runs `amaru-store-reader` over the stores, printing
each command before running it. A rerun takes up after the last step that
finished.

```
pnpm --filter cardano-tessera-amaru build-stores -- \
  --backend <url> --survey <txHash>:<index> --dir <dir> [--amaru <amaru binary>]
```

It needs `cargo` for the reader, and an `amaru` able to sync from Mithril
after a bootstrap; `docs/AUDIT.md` says which.

Every weight question is read from snapshot `end_epoch`, the ledger at that
epoch's end: registration, of a stake credential or a DRep; a stakeholder's
stake behind a pool still standing, the snapshot the ledger takes then; a
DRep's voting power, the distribution taken then. The electorate totals sit
outside the artifact's hash and are not read.

Native scripts are the approach's gap. Amaru keeps no index from a script
hash to a script, and its ledger rejects a witnessed script the transaction
does not need, or takes from a reference input. A record in a metadata-only
transaction needs no script, so a native-script credential's script is
almost never in the record's own transaction. `AmaruChain` therefore takes
a script lookup from its caller; the verifier's `--koios-scripts` passes
Koios's, which checks each script against its hash and that it was on chain
by the end of the survey's `end_epoch`. Without a lookup, such a script is resolved
nowhere, and the ruleset then counts the record as unproven: a response is
excluded, a cancellation does not cancel, a definition makes its survey
untalliable. Other records in the same transaction stand. A lookup that
fails, rather than finds nothing, leaves the proof unknown, and the rebuild
is indeterminate.

What an audit through these stores trusts and its limits:
`backend/RESEARCH-AUDIT.md`.
