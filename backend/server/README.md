# cardano-tessera-backend

Tier-1 serving backend for Tessera: runs the CIP-179 Koios read path once per
interval, caches it in SQLite, and serves it over HTTP. One Hono app over one
store, with two SQLite drivers: node:sqlite for the local Node process
(`src/main.ts`, with a `setInterval` refresh), and libSQL for a Turso database.
See `backend/ARCHITECTURE.md`.

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
3. **Finalize** — for surveys whose `end_epoch` has ended and can no longer
   roll back, snapshot stake/voting-power weights at that epoch, run the stake-weighted tally, and
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
path; a variable set in the environment wins over the file. Unknown network
names fail startup rather than falling back to Preview.

`dev:preview`, `dev:preprod`, and `dev:mainnet` pin `NETWORK` for the run,
ignoring whatever `.env` selects; every other `.env` value still applies. Each
network caches into its own `./tessera-cache-$NETWORK.sqlite` by default, so
switching between them never mixes two chains' records into one file — but they
share `PORT`, so run one at a time or override it. A store also banks the
network it was walked for and refuses a run configured for another, so a
mismatch fails at the head of the first refresh instead of overwriting rows.

## Endpoints

This section is the normative description of the HTTP contract. The contract
carries a version, `apiVersion` on `/health` and `/api/health` as
`major.minor`: a minor adds (a field, a selection, a route), a major replaces
(a field renamed, removed or re-typed, a selection whose semantics changed),
and after a major the backend serves the new shape only. A consumer compares
majors and refuses a mismatch; it may warn on a minor it does not know.
[CHANGELOG.md](CHANGELOG.md) records every change; the payload types are in
`cardano-tessera-client` (`payloads.ts`), with the version constant and the
request limits beside them, and that package's client is the reference
consumer.

A survey key is `<txHash>:<index>` matching `^[0-9a-f]{64}:(0|[1-9][0-9]*)$`
— lowercase hex, index without leading zeros — wherever the contract carries
one: `refs=`, the keys of `responseCounts` / `countedByRole` / `finalState`,
and the answers of `/api/responded` and `/api/responses`.

- `GET /health` — liveness, active network and `apiVersion`. The app checks
  both before trusting a backend: another network is a configuration error,
  another major is a contract it does not speak.
- `GET /api/health` — operational metrics behind the app's health footer: the
  snapshot's age, the last refresh, 24 h upstream-request and run totals, the
  validation backlog, the scan cursor, and the declared quotas the counts are
  read against; `apiVersion` beside the deployed `commit`.
- `GET /api/surveys` — the Explore-list payload, **keyset-paginated**
  (`filter`/`q`/`cursor`/`limit`, with `limit` 1–200 and 50 by default): survey
  records + tip + gov links + raw cancellations + server-deduped
  `responseCounts` per survey, plus
  `fetchedAt`. `countedByRole` is the _audited_ figure beside
  that total: per survey key and CIP-179 role, the responses that are in
  window, valid against the definition and not refuted by a credential-proof
  verdict, one per responder. Every survey in the payload has an entry, `{}`
  where nothing counts. `finalState` maps each decided survey key to the
  finalizer's verdict — `finalized` or `cancelled` with the artifact's hash, or
  `untalliable` (no artifact will ever exist) — so a mirror can stop
  re-refreshing a decided survey. A survey admitted as talliable can still
  finalize `untalliable`: the owner proof is fetched only at finalization, and
  a sealed survey on an unsupported drand chain is decided there too, so a
  host holding a survey must handle the late verdict. No survey is decided
  before the end of its `end_epoch` can no longer roll back, hours after the
  epoch boundary: while the epoch before the tip's is short of that depth the
  payload carries `settling`, `{ epoch, blocksLeft }`, the blocks still
  missing, and a survey that ended in that epoch has no `finalState` yet.
  Filter chip counts are
  global over the
  matching set, not per page. A cursor records the snapshot it was minted
  against; one from an older snapshot is still answered, with `resync` set so
  the client refreshes page one.
  Every paged answer also carries `changesCursor`, where a mirror that walked
  the whole list at this snapshot continues with the change selection below.
- `GET /api/surveys?sections` — the same selection paged by Explore section
  (linked open, linked closed, open, closed), each on its own, with `limit`
  rows per section, 10 by default. Without `cursor`: every section's first
  page in one answer, its keys, total and `nextCursor` under `sections`, with
  the counts. With a section's cursor: that section's next page and
  `nextCursor`, without counts. Open sections list the newest first, closed
  ones the most recently closed first: by the end of `end_epoch` for an ended
  survey, by its creation for a withdrawn or invalid one.
- `GET /api/surveys?refs=<txHash>:<index>,…` — the same payload for the surveys
  named, for a host mirroring a chosen subset instead of paging Tessera's order.
  No `counts` or `nextCursor` (a named set has neither), the paging parameters
  are refused beside it, and a ref matching nothing is absent from the answer.
- `GET /api/surveys?changes=<cursor>[&limit=…]` — what changed since a position
  the server minted: the list payload for the surveys whose stored projection
  moved (a new survey, a count, a link, a cancellation, a final state), the
  survey keys `removed` since, and the `nextCursor` to ask from next tick. The
  cursor is opaque; a mirror starts from the `changesCursor` of a full walk
  that finished without `resync`, stores each answer's `nextCursor`, and asks
  again next tick. A change is delivered once and never missed; within one
  answer apply `removed` before the rows. A removal is advisory and can be
  transient (a reorg re-lands the transaction at a new slot), so state that
  cannot be rebuilt is confirmed by `refs` before it is destroyed; removing a
  key never held is a no-op. `limit` bounds the rows and the removals each; no
  `counts`, and `filter`, `q`, `cursor` and `credentials` are refused beside it
  (a row leaving a filter is neither returned nor tombstoned, so a filtered
  delta could not be complete — filter locally). Every position is answerable:
  tombstones live as long as the corpus, so this selection never answers
  `resync` and its `nextCursor` is never null.
- `GET /api/surveys?since=<unix seconds>[&limit=…]` — the same delta from an
  instant the caller names instead of a position the server minted:
  everything stamped strictly after `since`, rows and removals alike. What a
  consumer bootstraps with when it knows when it last ran but holds no cursor;
  the answer's `nextCursor` is an ordinary one, so it follows `changes` after.
  Refused beside `changes` and beside everything `changes` refuses. A `since`
  above the published generation answers an empty delta, not an error.
  Removals reach back to the first deploy of the change selection (2026-09-04);
  rows written before it are stamped with chain time — the survey's own
  transaction, its newest response or cancellation, or the finalizer's
  decision — so an earlier `since` is answered at that resolution.
- `GET /api/surveys/{txHash}/{index}[?cursor=…]` — one survey's self-contained
  bundle: its definition record, one page of its responses (sealed ciphertexts
  included) with `nextCursor` to continue, the cancellations targeting it, its
  gov links, and the tip. The other sections describe the whole survey on every
  page; `verdicts` is scoped to the page. A reader wanting every response follows
  the cursor (`collectSurveyBundle` in `cardano-tessera-client`), restarting if a
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
  `ETag` (the artifact hash) and `Cache-Control: no-cache`: a survey's
  artifact is re-emitted under a new hash when a ruleset changes its shape.
- `GET /api/artifacts/{hash}` — the same artifact addressed by its content
  hash directly, the hash a survey's final state names. The same `ETag`, and
  `Cache-Control: immutable`.

Snapshot-derived routes answer `503` with `{"error":"snapshot not ready"}`
until the first refresh completes, and carry an `ETag` versioned by
`fetchedAt`, so revalidation between refreshes is a bodiless `304`. The ETag is
the refresh generation, not a change signal: it moves on every refresh whether
or not a row changed, so a conditional GET tells a poller nothing about the
rows. `fetchedAt` is when the producing scan _started_ reading — the instant
its `tip` was taken — so a staleness derived from it counts from when the data
was true, not from when the refresh finished writing it.

Payloads use the `cip-179/tally` JSON-safe wire form (bytes → hex under
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

## Deploy on Vercel

The hosted backend is two Vercel functions over a Turso database:
`src/vercel-serve.ts` answers every route, and `src/vercel-refresh.ts` runs one
refresh per call on `/cron/refresh`, which a Vercel Cron calls every three
minutes with `Bearer $CRON_SECRET`. Both read the same variables as the local
process, plus `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `CRON_SECRET`.

```sh
NETWORK=preview pnpm --filter cardano-tessera-backend build:vercel
```

bundles both into `.vercel/output` (Vercel's Build Output API), with the
network and the git commit baked into their environment, ready for
`vercel deploy --prebuilt`. The deploy workflow does that on each merge to
`main`; `OPERATIONS.md` has the setup and the manual steps.

A Turso database is migrated by the deploy, never by the code that serves it:

```sh
pnpm --filter cardano-tessera-backend migrate
```

reads `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from the environment or
`.env`, applies the same `migrations/*.sql` files the local process applies at
open, and prints the ones it applied.

## Per-run work

Every upstream request of a refresh is counted in the health footer, not just
the Koios ones, since a governance-anchor fetch costs a request too. **The
per-run floor is flat: it is set by the settlement window, not by how much
history the deployment has accumulated**, and validation, weight snapshotting
and artifact emission add batched calls only when there is new work — and each
of those caps the work it takes on per pass (transactions enriched,
credentials weighted, ciphertexts decrypted), postponing the rest to the next
run, so a burst of activity slows the pipeline down instead of failing a run.
Validation and finalization are resumable: what a pass persisted (verdict
rows, weight rows, reveal outcomes) is not redone, and the next run picks up
where it left off. `OPERATIONS.md` carries the daily-quota arithmetic.

A timelock decrypt costs ~20 ms of CPU, which makes sealed reveal the heaviest
pass. Its per-pass decrypt cap (`finalize.ts`) paces reveal rather than capping
survey size: each ciphertext's outcome is persisted as it is decrypted, so a
survey with more sealed responses than one pass affords finishes across
several runs.

## Requirements

Node ≥ 22.9. The local process uses the built-in `node:sqlite` and no native
code. The functions and `pnpm migrate` reach Turso through `@libsql/client/web`,
which has none either; only the libSQL driver's test loads the default entry,
which ships a prebuilt native binary per platform.
