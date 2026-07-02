# @tessera/backend

Tier-1 serving backend for Tessera: runs the CIP-179 Koios read path once per
interval, caches it in SQLite, and serves it over HTTP. One Hono app, two
runtimes: a local Node process (`src/main.ts`, node:sqlite + setInterval) and a
Cloudflare Worker (`src/worker.ts`, D1 + Cron trigger). See
`backend/ARCHITECTURE.md`.

## Run locally

```sh
pnpm install                        # from the repo root, once
pnpm --filter @tessera/backend dev
```

Serves on http://localhost:8787 against **preview** Koios, **tokenless** —
server-side `fetch` isn't CORS-bound, so the anonymous tier works and there is no
shared secret to leak. Copy `.env.example` to `.env` to override network, token,
port, refresh interval, or db path.

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

Snapshot-derived routes answer `503` until the first refresh completes, and
carry an `ETag` versioned by `fetchedAt`, so revalidation between refreshes is
a bodiless `304`. Payloads use the `@tessera/core` JSON-safe wire form (bytes →
hex under `$bytes`, big integers → decimal strings under `$bigint`) so they
round-trip losslessly to the browser. The `/api/*` routes send permissive CORS
headers (the
data is public and cookieless), so the browser app can read them cross-origin.
Bodies are compressed when the client accepts it (hex-heavy JSON shrinks ~4×).

## Use from the app

Point the frontend at this backend with `VITE_INDEXER_URL`, and it reads the
snapshot from here (via `IndexerDataSource`) instead of scanning Koios itself —
no Koios token needed for reads:

```sh
pnpm --filter @tessera/backend dev                              # terminal 1
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
pnpm --filter @tessera/backend exec wrangler d1 migrations apply DB --local
pnpm --filter @tessera/backend dev:cf        # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"     # trigger one refresh by hand
```

To deploy: `wrangler d1 create tessera-cache-preview`, paste the database id
into `wrangler.toml`, apply migrations with `--remote`, then
`pnpm --filter @tessera/backend deploy:cf`. Mainnet is a wrangler environment —
same steps with `--env mainnet` and its own database. A refresh currently costs
~6 Koios subrequests (logged on every cron run in `wrangler tail`), comfortably
inside the free plan's 50-per-invocation cap; revisit if the survey volume
grows the label pages / cbor batches.

## Requirements

Node ≥ 22.5 (uses the built-in `node:sqlite`, no native dependency).
