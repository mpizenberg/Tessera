# cardano-tessera-backend

Tier-1 serving backend for Tessera: runs the CIP-179 Koios read path once per
interval, caches it in SQLite, and serves it over HTTP. One Hono app, two
runtimes: a local Node process (`src/main.ts`, node:sqlite + setInterval) and a
Cloudflare Worker (`src/worker.ts`, D1 + Cron trigger). See
`backend/ARCHITECTURE.md`.

Each refresh cycle does three things, in order:

1. **Snapshot** — fetch all label-17 records + chain tip from Koios, resolve the
   governance links (dereferencing each candidate action's anchor and verifying
   it against the hash committed on-chain — fetched once ever, then banked), and
   cache the result (what the read endpoints serve).
2. **Validate** — for responses not seen before, fetch their tx block index
   and proof evidence and persist the §6.3 checks (well-formedness, credential
   proof via required signers / native scripts / vote bindings). Incremental:
   already-validated responses cost zero further Koios calls.
3. **Finalize** — for surveys safely past their `end_epoch`, snapshot
   stake/voting-power weights at that epoch, run the stake-weighted tally, and
   emit an immutable, content-addressed **result artifact**
   (blake2b-256 over canonical JSON). Idempotent and resumable: weight rows and
   sealed-reveal outcomes already written are never recomputed, and a temporarily
   unavailable electorate total just postpones the survey to the next cycle.
   `packages/verifier` can re-derive any artifact from chain data alone and
   check the hash.

## Run locally

```sh
pnpm install                        # from the repo root, once
pnpm --filter cardano-tessera-backend dev
```

Serves on http://localhost:8787 against **preview** Koios, **tokenless** —
server-side `fetch` isn't CORS-bound, so the anonymous tier works and there is no
shared secret to leak. Copy `.env.example` to `.env` to select `mainnet`,
`preprod`, or `preview` and override the token, port, refresh interval, or db
path. Unknown network names fail startup rather than falling back to Preview.

`dev:preview`, `dev:preprod`, and `dev:mainnet` pin `NETWORK` for the run,
ignoring whatever `.env` selects; every other `.env` value still applies. Each
network caches into its own `./tessera-cache-$NETWORK.sqlite` by default, so
switching between them never mixes two chains' records into one file — but they
share `PORT`, so run one at a time or override it.

## Endpoints

- `GET /health` — liveness + active network.
- `GET /api/surveys` — the Explore-list payload: survey records + tip + gov
  links + raw cancellations + server-deduped `responseCounts` per survey, plus
  `fetchedAt` / `ageSeconds`. Bounded regardless of participation volume.
- `GET /api/surveys/{txHash}/{index}` — one survey's self-contained bundle:
  its definition record, ALL of its responses (sealed ciphertexts included),
  the cancellations targeting it, and the tip. `404` for an unknown ref.
- `GET /api/responded?credentials=key:<hex>,script:<hex>` — survey keys with at
  least one response from any of the given credentials (a wallet's payment +
  stake in one request); feeds the Explore "answered" flags.
- `GET /api/tip` — near-live chain tip (~20 s cache, so request bursts collapse
  into one Koios call).
- `GET /api/tx_status?hashes=<h1>,<h2>` — live confirmation counts.
- `GET /api/pparams` — latest-epoch protocol parameters (evolution-sdk shape,
  wire-encoded, ~20 s cache). Lets the browser build a transaction without
  querying Koios, so the app needs no Koios token even to create
  surveys/responses/actions.
- `GET /api/surveys/{txHash}/{index}/artifact` — the survey's final tally
  artifact, or `404` while the survey is open / not yet finalized. Served
  byte-for-byte as stored (its content hash stays verifiable), with a strong
  `ETag` (the artifact hash) and `Cache-Control: immutable`.
- `GET /api/artifacts/{hash}` — the same artifact addressed by its content
  hash directly.

Snapshot-derived routes answer `503` until the first refresh completes, and
carry an `ETag` versioned by `fetchedAt`, so revalidation between refreshes is
a bodiless `304`. `fetchedAt` is when the producing scan _started_ reading —
the instant its `tip` was taken — so `ageSeconds` counts from when the data was
true, not from when the refresh finished writing it.

Payloads use the `cardano-tessera-core` JSON-safe wire form (bytes → hex under
`$bytes`, big integers → decimal strings under `$bigint`) so they round-trip
losslessly to the browser. The `/api/*` routes send permissive CORS headers
(the data is public and cookieless), so the browser app can read them
cross-origin. Bodies are compressed when the client accepts it (hex-heavy JSON
shrinks ~4×).

## Use from the app

Point the frontend at this backend with `VITE_INDEXER_URL`, and it reads the
snapshot from here (via `IndexerDataSource`) instead of scanning Koios itself —
no Koios token needed for reads:

```sh
pnpm --filter cardano-tessera-backend dev                              # terminal 1
VITE_INDEXER_URL=http://localhost:8787 pnpm --filter tessera-app dev   # terminal 2
```

Leave `VITE_INDEXER_URL` unset and the app reads from Koios directly (the
power-user/offline path), which then needs a Koios token pasted in the app's
Settings.

Deployments are single-network on both sides: the app is built for one network
(`VITE_NETWORK`) and must point at a backend serving the same one — it checks
this against `/health` (which reports the active network) and refuses a
mismatched backend rather than mixing networks.

## Run on Cloudflare

The Worker entry reuses the same app with a D1 store; the cron trigger
(`*/3 * * * *`, wrangler.toml) replaces the refresh loop. Locally, against
Miniflare's bundled D1 (no Cloudflare account needed):

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 migrations apply DB --env preview --local
pnpm --filter cardano-tessera-backend dev:cf        # wrangler dev --env preview --test-scheduled
curl "http://localhost:8787/__scheduled"     # trigger one refresh by hand
```

Preview, preprod, and mainnet are separate named Wrangler environments with
separate Worker names, D1 databases, and `NETWORK` vars. Preview deploys with
`pnpm --filter cardano-tessera-backend deploy:preview`; preprod has a generated,
git-ignored config and deploys with `deploy:preprod`; mainnet deploys with
`deploy:mainnet`. See [OPERATIONS.md](OPERATIONS.md) for the reproducible
preprod creation, migration, secrets, deployment, measurement, health gate, and
rollback commands.

Subrequests (logged on every cron run in `wrangler tail`): a steady-state
refresh costs ~6 Koios calls; validating new responses and finalizing closing
surveys add batched calls only when there is new work (a full live cycle —
refresh + validation + weight snapshotting + artifact emission — measured 18).
Unresolved governance anchors add up to `ANCHOR_ATTEMPTS_PER_REFRESH` more,
which is why the log line and the health footer count every upstream request,
not just the Koios ones.
That sits comfortably inside the free plan's 50-per-invocation cap, and
finalization is resumable: if a run were ever cut short, already-written weight
rows are not re-fetched and the next cron picks up where it left off.

CPU is the tighter limit once sealed surveys are in play: a cron under an hour
apart gets 30 s on the paid plan and 10 ms on the free one, while a single
timelock decrypt costs ~20 ms on workerd. Sealed reveal therefore needs the paid
plan; `finalize.ts` derives its per-pass decrypt budget from that 30 s, and
`wrangler.toml` pins the same ceiling with `limits.cpu_ms`. That budget paces
reveal rather than capping survey size: each ciphertext's outcome is persisted as
it is decrypted, so a survey with more sealed responses than one pass affords
finishes across several crons.

## Requirements

Node ≥ 22.5 (uses the built-in `node:sqlite`, no native dependency).
