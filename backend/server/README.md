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
- `GET /api/tip` — live chain tip (bypasses the cache, for immediacy).
- `GET /api/tx_status?hashes=<h1>,<h2>` — live confirmation counts.

The snapshot payload uses the `@tessera/core` JSON-safe wire form (bytes → hex
under `$bytes`, big integers → decimal strings under `$bigint`) so it round-trips
losslessly to the browser.

## Requirements

Node ≥ 22.5 (uses the built-in `node:sqlite`, no native dependency).
