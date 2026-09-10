# cardano-tessera-mithril

Tally inputs from a Mithril ledger snapshot instead of Koios. Private to the
workspace; the audit it serves is `backend/RESEARCH-AUDIT.md`.

## Getting a verified ledger state

Every hour a Mithril aggregator publishes an "ancillary" archive holding the
node's ledger state at the tip of its newest immutable file. It is signed by
the aggregator operator's ancillary key, not by the Mithril stake multisig
(Rung 1 in `RESEARCH-AUDIT.md`). Needs `curl`, `zstd`, `tar` and Node 22.15 or
later; run the commands from this directory.

1. Find the archive. The aggregator lists its twenty newest snapshots:

   ```sh
   AGG=https://aggregator.pre-release-preview.api.mithril.network/aggregator
   curl -s $AGG/artifact/cardano-database | jq '.[0].beacon'
   ```

   Preprod and mainnet use `aggregator.release-preprod` and
   `aggregator.release-mainnet`. Archives sit on the CDN at
   `https://storage.googleapis.com/cdn.<aggregator host>/cardano-database/ancillary/<network>-e<epoch>-i<immutable>.ancillary.tar.zst`
   and stay 28 days. An archive is named by the epoch the aggregator was in
   when it made it and by the newest completed immutable; its ledger state
   is the state after that immutable's last block. Every Cardano network
   completes twenty immutables per epoch, and on preview epoch `E` owns
   immutables `20E` to `20E+19`, so the state after the last block of `E` is
   in `preview-e<E+1>-i<20E+19>`, the label having already rolled over. For
   an epoch older than the listing, probe the name with `curl -I`; a missing
   object answers 403.

2. Download, and extract everything but the UTxO tables (preview: 259 MB
   down, 50 MB kept):

   ```sh
   NAME=preview-e1414-i28296
   curl -O https://storage.googleapis.com/cdn.aggregator.pre-release-preview.api.mithril.network/cardano-database/ancillary/$NAME.ancillary.tar.zst
   mkdir -p snapshots/$NAME
   tar --zstd -xf $NAME.ancillary.tar.zst -C snapshots/$NAME --exclude 'ledger/*/tables'
   ```

3. Verify. `ancillary_manifest.json` lists a sha256 per archived file and an
   Ed25519 signature over the list. The script checks the signature against
   the network's key pinned in `src/verify.ts` (copied from the Mithril
   repository, `mithril-infra/configuration/<aggregator>/ancillary.vkey`),
   then the hash of every listed file present in the directory:

   ```sh
   pnpm verify preview snapshots/$NAME
   ```

The ledger state is `snapshots/<name>/ledger/<slot>/state`, the CBOR of the
node's `ExtLedgerState` without the UTxO; `meta` names the UTxO backend.
`snapshots/` is gitignored.

## Reading the ledger facts

```sh
pnpm facts snapshots/$NAME/ledger/*/state --stake key:<hex> script:<hex> --drep key:<hex>
```

prints, as JSON with lovelace as decimal strings, the snapshot's epoch and
slot; the totals and sizes of the `mark`, `set` and `go` stake snapshots; the
DRep voting-power distribution with and without the `abstain` and
`noConfidence` buckets; and, for each named credential, its registration,
deposit, reward, pool and DRep delegation and its stake and pool in each
snapshot, or
for a DRep its registration, expiry and voting power. `src/ledger.ts` lists
the positional layout it reads.

## Comparing with Koios

```sh
pnpm compare preview snapshots/$NAME/ledger/*/state 1412
```

draws ten credentials of every kind a tally can meet from the state itself
(delegated with rewards, registered without a pool, stake in a pool that has
since retired, registered but in no stake snapshot, deregistered since a
snapshot, script credentials; DReps active, expired, retired or registered
since the distribution was taken, script, zero power), asks Koios the four
`TallyInputSource` questions for the named epoch about them, and prints per
kind how many agree with each candidate reading of the state, then every
disagreement with both sides. A kind the state has none of is listed with
zero. `KOIOS_TOKEN` in the environment is used when set; the anonymous tier
is enough for one run.
