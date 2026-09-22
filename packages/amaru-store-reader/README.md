# amaru-store-reader

The verifier's inputs read from an Amaru node's own stores instead of Koios:
a survey's responders (stake, registration, DRep voting stake) and the
governance actions from the ledger's epoch snapshots, its records from the
blocks the node validated. Private to the workspace, not part of the pnpm
workspace: it is a Rust crate over Amaru's `amaru-ledger`, `amaru-stores`
and `amaru-ouroboros-traits`, pinned to the release that produced the stores
(`Cargo.toml`, git tag) and built with the nightly that release requires
(`rust-toolchain.toml`, so build from this directory). Nothing here validates
anything: Amaru validated the blocks when it synced, this only reads what it
kept.

```
cargo run --release -- snapshot <network> <ledger-dir> <epoch>
cargo run --release -- blocks <network> <chain-dir> <from-slot> <to-slot>
```

`snapshot` prints one JSON object for the snapshot the ledger took at the end
of `<epoch>` (Amaru keeps the last three, unless the node ran with
`--max-extra-ledger-snapshots`). Under `accounts`, keyed `key:<hex>` or
`script:<hex>`, each registered stake credential with its stored pool and DRep
delegation, the slot of the certificate that set each, its deposit and
rewards balance; under `active`, the node's own end-of-epoch view of the same
account: its stake and the delegations still standing once retired pools and
lapsed DReps are dropped. Under `dreps`, each registered DRep with the slot
of its registration, its stored expiry epoch and deposit, the expiry the node
applies (extended by dormant epochs) and its voting stake. Under `proposals`,
keyed `<tx hash>#<index>`, each governance action still in the state with the
slot it was proposed in, the last epoch it can be voted in (`valid_until`) and
its anchor; an action stays one epoch past `valid_until`, until the boundary
that ratifies or drops it. Lovelace are decimal strings. The electorate
totals are not printed: they sit outside the artifact's hash.

`blocks` walks the best chain from its tip back through parent links to
`<from-slot>` and prints every transaction between the two slots, inclusive,
that carries label-17 metadata: its hash, block slot, epoch, height and hash,
index in the block, whether the block marks it valid, its standalone CBOR
reassembled from the block's own bytes (byte for byte what an indexer serves)
and the raw CBOR of its label-17 datum.

Known limits. Amaru keeps no index from a script hash to a script, so a
responder's native script is only available when the transaction carrying
the record witnesses it; a script credential witnessed elsewhere (an earlier
transaction, a reference script in the UTxO set) cannot be checked from these
stores and its record stays unknown, where an indexer resolves the script by
hash. A certificate from before the node's bootstrap point has no slot of its
own, because PRAGMA's start states do not keep the pointer; a DRep
registration or delegation then carries the bootstrap point's slot, a pool
delegation slot 0.

How this fits Tessera's audit, what it trusts and what it measured:
`backend/RESEARCH-AUDIT.md`.
