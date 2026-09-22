# amaru-store-reader

The verifier's inputs read from an Amaru node's own stores instead of Koios:
a survey's responders and the governance actions from the ledger's epoch
snapshots, its records from the blocks the node validated. Private to the
workspace, not part of the pnpm workspace: it is a Rust crate over Amaru's
`amaru-ledger`, `amaru-stores` and `amaru-ouroboros-traits`, pinned to the
release that produced the stores (`Cargo.toml`, git tag) and built with the
nightly that release requires (`rust-toolchain.toml`, so build from this
directory). Nothing here validates anything: Amaru validated the blocks when
it synced, this only reads what it kept. The verifier reads what it prints
through `packages/amaru`.

```
cargo run --release -- snapshot <network> <ledger-dir> <epoch>
cargo run --release -- blocks <network> <chain-dir> <from-slot> <to-slot>
```

`snapshot` prints one JSON object for the snapshot the ledger took at the end
of `<epoch>` (Amaru keeps the last three, unless the node ran with
`--max-extra-ledger-snapshots`). Under `accounts`, keyed `key:<hex>` or
`script:<hex>`, each registered stake credential with the node's own
end-of-epoch view of it: its stake and its pool, `null` once that pool has
retired. Under `dreps`, each registered DRep with its voting stake. Under
`proposals`, keyed `<tx hash>#<index>`, each governance action still in the
state with the last epoch it can be voted in (`valid_until`) and its anchor;
an action stays one epoch past `valid_until`, until the boundary that
ratifies or drops it. `gov_action_lifetime` is the protocol parameter at that
end. Lovelace are decimal strings. The electorate totals are not printed:
they sit outside the artifact's hash.

`blocks` walks the best chain from its tip back through parent links to
`<from-slot>` and prints every transaction between the two slots, inclusive,
that carries label-17 metadata: its hash, block slot, epoch, height and hash,
index in the block, whether the block marks it valid, its standalone CBOR
reassembled from the block's own bytes (byte for byte what an indexer serves)
and the raw CBOR of its label-17 datum; with the tip the walk started from.

## Verifying a survey

For a survey created at slot `S` with `end_epoch = E`, a node whose stores
hold the blocks from `S` and the snapshots of `E-2` to `E`, that is one
synced past the first `k` blocks of `E+1` and not past `E+3`:

```
mkdir <dir>
for e in E-2 E-1 E; do
  cargo run --release -- snapshot <network> <ledger-dir> $e > <dir>/snapshot-$e.json
done
cargo run --release -- blocks <network> <chain-dir> S <last slot of E> > <dir>/blocks.json
pnpm --filter cardano-tessera-verifier verify -- --backend <url> --survey <key> --amaru <dir>
```

The walk may start earlier than `S` and stop later than `E`'s last slot;
the verifier keeps the survey's window. On preview, each snapshot takes 2 s
and prints 16 MB; a 30-epoch walk takes 2 s.

Known limit: Amaru keeps no index from a script hash to a script, so a
responder's native script is only available when the transaction carrying
the record witnesses it; a script credential witnessed elsewhere (an earlier
transaction, a reference script in the UTxO set) cannot be checked from these
stores and its record stays unknown, where an indexer resolves the script by
hash.

How this fits Tessera's audit, what it trusts and what it measured:
`backend/RESEARCH-AUDIT.md`.
