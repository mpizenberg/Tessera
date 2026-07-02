# @tessera/backend

Tier-1 serving backend for Tessera: runs the CIP-179 Koios read path once per
interval, caches it in SQLite, and serves it over HTTP. A local Node process
today; the same Hono app targets Cloudflare Workers (with D1) later. See
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
- `GET /api/snapshot` — cached label-17 records + tip + gov links, plus
  `fetchedAt` / `ageSeconds`. Returns `503` until the first refresh completes.
- `GET /api/tip` — near-live chain tip (~20 s cache, so request bursts collapse
  into one Koios call).
- `GET /api/tx_status?hashes=<h1>,<h2>` — live confirmation counts.
- `GET /api/pparams` — latest-epoch protocol parameters (evolution-sdk shape,
  wire-encoded, ~20 s cache). Lets the browser build a transaction without
  querying Koios, so the app needs no Koios token even to create
  surveys/responses/actions.

The snapshot payload uses the `@tessera/core` JSON-safe wire form (bytes → hex
under `$bytes`, big integers → decimal strings under `$bigint`) so it round-trips
losslessly to the browser. The `/api/*` routes send permissive CORS headers (the
data is public and cookieless), so the browser app can read them cross-origin.

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

## Requirements

Node ≥ 22.5 (uses the built-in `node:sqlite`, no native dependency).
