# cardano-tessera-backend

Tier-1 serving backend for Tessera: runs the CIP-179 Koios read path once per
interval, caches it in SQLite, and serves it over HTTP. One Hono app, two
runtimes: a local Node process (`src/main.ts`, node:sqlite + setInterval) and a
Cloudflare Worker (`src/worker.ts`, D1 + Cron trigger). See
`backend/ARCHITECTURE.md`.

Each refresh cycle does three things, in order:

1. **Snapshot** — integrate one slot segment of the label-17 index into the
   stored rows (the settlement margin below the banked scan cursor, plus a
   rotating page of settled history that heals silent drift), and resolve the
   governance links for the epochs whose links can still move (dereferencing
   each candidate action's anchor and verifying it against the hash committed
   on-chain — fetched once ever, then banked). The rows are what the read
   endpoints serve; `backend/ARCHITECTURE.md` covers the windowed refresh.
2. **Validate** — for responses not seen before, fetch their tx block index
   and proof evidence and persist the verdicts (well-formedness, deadline,
   credential proof via required signers / native scripts / vote bindings —
   the rules are `backend/TALLY-SPEC.md`). Incremental: already-validated
   responses cost zero further Koios calls.
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
share `PORT`, so run one at a time or override it. A store also banks the
network it was walked for and refuses a run configured for another, so a
mismatch fails at the head of the first refresh instead of overwriting rows.

**`wrangler dev` reads `.env` too**, and its values override the `[vars]` of the
`--env` you pass — `wrangler dev --env preprod` with `NETWORK=preview` in `.env`
runs preview code against the preprod database. With `--remote`, that database
is the live one. Leave `NETWORK` out of `.env` when using `wrangler dev`, or
expect the store's guard to refuse the run.

## Endpoints

- `GET /health` — liveness + active network. The app checks this before
  trusting a backend.
- `GET /api/health` — operational metrics behind the app's health footer: the
  snapshot's age, the last refresh, 24 h upstream-request and run totals, the
  validation backlog, the scan cursor, and the declared quotas the counts are
  read against.
- `GET /api/surveys` — the Explore-list payload, **keyset-paginated**
  (`filter`/`q`/`cursor`/`limit`): survey records + tip + gov links + raw
  cancellations + server-deduped `responseCounts` per survey, plus
  `fetchedAt` / `ageSeconds`. Filter chip counts are global over the matching
  set, not per page. A cursor records the snapshot it was minted against; one
  from an older snapshot is still answered, with `resync` set so the client
  refreshes page one.
- `GET /api/surveys?refs=<txHash>:<index>,…` — the same payload for the surveys
  named, for a host mirroring a chosen subset instead of paging Tessera's order.
  No `counts` or `nextCursor` (a named set has neither), the paging parameters
  are refused beside it, and a ref matching nothing is absent from the answer.
- `GET /api/surveys/{txHash}/{index}[?cursor=…]` — one survey's self-contained
  bundle: its definition record, one page of its responses (sealed ciphertexts
  included) with `nextCursor` to continue, the cancellations targeting it, its
  gov links, and the tip. The other sections describe the whole survey on every
  page; `verdicts` is scoped to the page. A reader wanting every response follows
  the cursor (`collectSurveyBundle` in `cardano-tessera-core`), restarting if a
  page comes back with `resync` — the snapshot moved under it. `404` for an
  unknown ref, `400` for a malformed cursor.
- `GET /api/responded?credentials=key:<hex>,script:<hex>` — survey keys with at
  least one response from any of the given credentials (a wallet's payment +
  stake in one request); feeds the Explore "answered" flags.
- `GET /api/responses/{txHash}` — the responses that transaction carried:
  `surveyKey`, `responseIndex`, `role`, `credential`, `slot` per row, no
  records. This is how a mirror settles an optimistic row for a submission it
  made — per-credential membership can't tell a replacement from the response
  it superseded. A well-formed hash the snapshot holds nothing for answers
  `200` with an empty list: "not indexed yet" is the state the route exists to
  report, not an error.
- `GET /api/tip` — near-live chain tip (~20 s cache, so request bursts collapse
  into one Koios call).
- `GET /api/tx_status?hashes=<h1>,<h2>` — live confirmation counts.
- `GET /api/pparams` — latest-epoch protocol parameters (evolution-sdk shape,
  wire-encoded, one Koios read per epoch). Lets the browser build a transaction without
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

The app's dev server points here (`http://localhost:8787`) by default and
reads the snapshot from this backend (via `IndexerDataSource`) instead of
scanning Koios itself — no Koios token needed for reads:

```sh
pnpm --filter cardano-tessera-backend dev   # terminal 1
pnpm --filter tessera-app dev               # terminal 2
```

Set `TESSERA_BACKEND_URL` empty and the app reads from Koios directly (the
power-user/offline path), which then needs a Koios token pasted in the app's
Settings. Pair the two on the same network — the app checks `/health` and
refuses a backend serving a different one.

## Run on Cloudflare

The Worker entry reuses the same app with a D1 store; the cron trigger
(`*/3 * * * *`, wrangler.toml.example) replaces the refresh loop. Locally, against
Miniflare's bundled D1 (no Cloudflare account needed):

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 migrations apply DB --env preview --local
pnpm --filter cardano-tessera-backend dev:cf        # wrangler dev --env preview --test-scheduled
curl "http://localhost:8787/__scheduled"     # trigger one refresh by hand
```

Preview, preprod, and mainnet are separate named Wrangler environments with
separate Worker names, D1 databases, and `NETWORK` vars, migrated with
`pnpm --filter cardano-tessera-backend migrate:<network>` and deployed with
`deploy:<network>`. Every Wrangler command
here needs a `wrangler.toml`, which is git-ignored because it carries the D1
database ids of one Cloudflare account: copy `wrangler.toml.example` and fill in
the ids of the networks you deploy. See [OPERATIONS.md](OPERATIONS.md) for the
reproducible preprod creation, migration, secrets, deployment, measurement,
health gate, and rollback commands.

Subrequests are logged on every cron run (`wrangler tail`) and counted in the
health footer — every upstream request, not just the Koios ones, since a
governance-anchor fetch costs a subrequest too. **The per-run floor is flat:
it is set by the settlement window, not by how much history the deployment has
accumulated**, and validation, weight snapshotting and artifact emission add
batched calls only when there is new work — and each of those caps the work it
takes on per pass (transactions enriched, credentials weighted, ciphertexts
decrypted), postponing the rest to the next cron, so a burst of activity slows
the pipeline down instead of failing a run on the platform's subrequest cap.
Validation and finalization are resumable: what a pass persisted (verdict rows,
weight rows, reveal outcomes) is not redone, and the next cron picks up where
it left off. `OPERATIONS.md` carries the measured breakdown and the daily-quota
arithmetic.

CPU is the tighter limit once sealed surveys are in play: a cron under an hour
apart gets 30 s on the paid plan and 10 ms on the free one, while a single
timelock decrypt costs ~20 ms on workerd. Sealed reveal therefore needs the paid
plan; `finalize.ts` derives its per-pass decrypt budget from that 30 s, and
`wrangler.toml.example` pins the same ceiling with `limits.cpu_ms`. That budget paces
reveal rather than capping survey size: each ciphertext's outcome is persisted as
it is decrypted, so a survey with more sealed responses than one pass affords
finishes across several crons.

## Requirements

Node ≥ 22.5 (uses the built-in `node:sqlite`, no native dependency).
