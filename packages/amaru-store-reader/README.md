# amaru-store-reader

The verifier's inputs read from an Amaru node's own stores instead of Koios:
a survey's responders (stake, registration, pool and DRep delegation, DRep
voting stake and expiry) from the ledger's epoch snapshots. Private to the
workspace, not part of the pnpm workspace: it is a Rust crate over Amaru's
`amaru-ledger` and `amaru-stores`, pinned to the release that produced the
stores (`Cargo.toml`, git tag) and built with the nightly that release
requires (`rust-toolchain.toml`). Nothing here validates anything: Amaru
validated the blocks when it synced, this only reads what it kept.

```
cargo run --release -- snapshot <network> <ledger-dir> <epoch>
```

prints one JSON object for the snapshot the ledger took at the end of
`<epoch>` (Amaru keeps the last three, unless the node ran with
`--max-extra-ledger-snapshots`). Under `accounts`, keyed `key:<hex>` or
`script:<hex>`, each registered stake credential with its stored pool and DRep
delegation, the slot of the certificate that set each, its deposit and
rewards balance; under `active`, the node's own end-of-epoch view of the same
account: its stake and the delegations still standing once retired pools and
lapsed DReps are dropped. Under `dreps`, each registered DRep with the slot
of its registration, its stored expiry epoch and deposit, the expiry the node
applies (extended by dormant epochs) and its voting stake. Lovelace are
decimal strings. The electorate totals are not printed: they sit outside the
artifact's hash.

Known limit: a credential registered before the node's bootstrap point
carries the bootstrap point as its registration slot, not the certificate's,
because PRAGMA's start states do not keep the pointer.

How this fits Tessera's audit, what it trusts and what it measured:
`backend/RESEARCH-AUDIT.md`.
