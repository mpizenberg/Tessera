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
cargo run --release -- blocks <network> <chain-dir> <from-slot> <to-slot> <survey-tx-hash>
cargo run --release -- snapshot <network> <ledger-dir> <epoch> < credentials.json
```

`blocks` walks the best chain from its tip back through parent links to
`<from-slot>` and prints the transactions between the two slots, inclusive,
that can concern the survey: its defining transaction, and every one whose
label-17 datum holds the survey's transaction hash as a byte string, as any
response or cancellation naming it must. The search knows nothing of
CIP-179's layout, so a datum holding those bytes for another reason lets a
transaction through, and the verifier decodes and drops it; none naming the
survey is left out. For each: its hash, block slot, epoch, height and hash,
index in the block, whether the block marks it valid, its standalone CBOR
reassembled from the block's own bytes (byte for byte what an indexer
serves) and the raw CBOR of its label-17 datum; with the tip the walk
started from.

`snapshot` prints one JSON object for the snapshot the ledger took at the end
of `<epoch>` (Amaru keeps the last three, unless the node ran with
`--max-extra-ledger-snapshots`), for the credentials named on stdin as
`{"accounts": [...], "dreps": [...]}`, each `key:<hex>` or `script:<hex>`.
Under `accounts`, each asked stake credential with the node's own
end-of-epoch view of it, its stake and its pool (`null` once that pool has
retired), or `null` when it is not registered. Under `dreps`, each asked DRep
with its voting stake, or `null`. Under `proposals`, keyed
`<tx hash>#<index>`, every governance action still in the state with the last
epoch it can be voted in (`valid_until`) and its anchor; an action stays one
epoch past `valid_until`, until the boundary that ratifies or drops it.
Lovelace are
decimal strings. The electorate totals are not printed: they sit outside the
artifact's hash.

## Verifying a survey

For a survey created at slot `S` with `end_epoch = E`, a node whose stores
hold the blocks from `S` and snapshot `E`, that is one synced past the
first `k` blocks of `E+1` and short of the transition into `E+3`, which
prunes `E`. The walk comes first: the credentials the snapshot is asked
about are the ones its responses name, printed by `packages/amaru`.

```
mkdir <dir>
cargo run --release -- blocks <network> <chain-dir> S <last slot of E> <survey tx hash> > <dir>/blocks.json
pnpm --silent --filter cardano-tessera-amaru credentials -- --dir <dir> --survey <key> > <dir>/credentials.json
cargo run --release -- snapshot <network> <ledger-dir> E < <dir>/credentials.json > <dir>/snapshot-E.json
pnpm --filter cardano-tessera-verifier verify -- --backend <url> --survey <key> --amaru <dir>
```

The walk may start earlier than `S` and stop later than `E`'s last slot;
the verifier keeps the survey's window. The verifier refuses a snapshot that
was not asked about a credential it needs. On preview, a snapshot takes
2 s, most of it Amaru computing the epoch's stake summary, and prints 4 KB
for two responders; a 30-epoch walk takes 2 s.

Known limit: these stores cannot resolve a native script by hash. Amaru
keeps no index from a script hash to a script, and its ledger rejects a
witnessed script the transaction does not need, or takes from a reference
input, so a record in a metadata-only transaction never carries the script
of the native-script credential it names. The verifier looks such scripts
up elsewhere (`packages/amaru/README.md`).

How this fits Tessera's audit, what it trusts and what it measured:
`backend/RESEARCH-AUDIT.md`.
