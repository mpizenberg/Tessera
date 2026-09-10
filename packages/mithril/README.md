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
   and stay 28 days. Every Cardano network completes twenty immutables per
   epoch, so for an epoch older than the listing, subtract twenty per epoch
   from the newest beacon and probe neighbours with `curl -I`; a missing
   object answers 403. The last archive of an epoch is the one before the
   first archive of the next.

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
