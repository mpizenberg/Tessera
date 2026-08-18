# Cloudflare operator runbook

This runbook deploys one Tessera backend per Cardano network. The preprod path
is the interoperability target; its fixed resource names are
`tessera-backend-preprod` and `tessera-cache-preprod`. Run commands from a clean
repository checkout after `pnpm install --frozen-lockfile` and
`pnpm --filter cardano-tessera-backend exec wrangler login`.

## Create and configure preprod

Every Wrangler command reads `backend/server/wrangler.toml`, which is git-ignored
because the D1 database ids in it identify resources in one Cloudflare account.
Create it once per checkout from the committed template:

```sh
cp backend/server/wrangler.toml.example backend/server/wrangler.toml
```

Create the database once per account:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 create tessera-cache-preprod
```

Put the UUID Wrangler prints into the `[[env.preprod.d1_databases]]` block of
your `wrangler.toml`, replacing the all-zero placeholder. Fill in the networks
you deploy and leave the others at the placeholder. An existing database's UUID
is available from:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 info tessera-cache-preprod --json
```

Everything except the ids is project configuration: change it in
`wrangler.toml.example`, then re-copy and re-fill, so the template a fresh
checkout deploys never drifts from what you run.

Apply every committed migration before deploying the Worker. Nothing serves this
database yet, so the order is free here; on a redeploy it is not:

```sh
pnpm --filter cardano-tessera-backend migrate:preprod
```

Deploy the exact checked-out commit — the working tree must be clean, because
the deploy script stamps `HEAD` into the Worker (`--var GIT_COMMIT`), and
`/api/health` reports it as `commit`:

```sh
git status --short
pnpm --filter cardano-tessera-backend deploy:preprod
```

Record the `workers.dev` URL from Wrangler's output. Do not point a client at
the service yet.

Both Koios tokens are optional; without them the backend uses Koios's
unauthenticated per-IP quota. Secrets attach to an existing Worker, so they come
after the first deploy — each `put` publishes a new version by itself, with no
redeploy. Use a preprod Koios token, not the Preview one, and enter it
interactively so it never appears in shell history or source:

```sh
pnpm --filter cardano-tessera-backend exec wrangler secret put KOIOS_TOKEN --env preprod
pnpm --filter cardano-tessera-backend exec wrangler secret put KOIOS_PASSTHROUGH_TOKEN --env preprod
```

## Verify the deployment

Set the origin printed by Wrangler, without a trailing path:

```sh
BACKEND_URL=https://tessera-backend-preprod.<account-subdomain>.workers.dev
curl --fail --silent --show-error "$BACKEND_URL/health"
curl --fail --silent --show-error "$BACKEND_URL/api/health"
```

`/api/health` must name the network you expect and report the commit you just
deployed in `commit`.

A hostname deployed under a `workers.dev` name for the first time can answer
`error code: 1042` — sometimes with HTTP 404, and inconsistently between edges —
for a minute or two while the route propagates. That is not a failed deploy;
retry until it answers rather than redeploying or recreating the Worker. The
same applies to the app's `tessera-<network>` hostname.

`/health` must return `{"ok":true,"network":"preprod"}`. Then wait for the
walker to reach the tip: a database with no banked cursor starts at the `SINCE`
floor and integrates a bounded number of listing pages per run, so the first
corpus is assembled over as many three-minute crons as the history needs — one
per ~800 label-17 transactions. Until it arrives, every run records
`incomplete: true` and nothing finalizes. `/api/health` must report
`network: "preprod"`, a non-null `snapshot`, a latest refresh that is `ok` and
no longer `incomplete`, and `validationBacklog: 0`. `scan` reports where the
walker stands while you wait. The following check enforces those gates:

```sh
BACKEND_URL="$BACKEND_URL" node --input-type=module <<'NODE'
const origin = process.env.BACKEND_URL;
const identity = await fetch(`${origin}/health`).then((r) => r.json());
const health = await fetch(`${origin}/api/health`).then((r) => r.json());
if (identity.ok !== true || identity.network !== "preprod")
  throw new Error(`wrong backend identity: ${JSON.stringify(identity)}`);
if (
  health.network !== "preprod" ||
  health.snapshot === null ||
  health.lastRefresh?.ok !== true ||
  health.lastRefresh?.incomplete === true ||
  health.validationBacklog !== 0
)
  throw new Error(`preprod is not ready: ${JSON.stringify(health)}`);
console.log(JSON.stringify({ identity, health }, null, 2));
NODE
```

**A check that does not pass has two very different meanings**, and the
`incomplete` gate cannot tell them apart on its own: the walker is still working
through history, or it is stuck and will never finish. `scan` in the same
response separates them — run the check twice, a cron or more apart, and compare:

| `scan`                               | reading                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `caughtUp: false`, `cursorSlot` up   | catching up normally — wait                                                     |
| `caughtUp: false`, `cursorSlot` same | stuck: the run banks no cursor, so it is repeating a segment                    |
| `scan: null` after several crons     | no run has ever completed a segment                                             |
| `caughtUp: true`, still `incomplete` | reaching the tip but losing records — a listing or metadata fetch keeps failing |

A stuck walk is upstream, not local: `lastRefresh.error` names the failure when
the run died outright, and when runs report `ok` while standing still the cause
is a listing page or metadata batch that keeps coming back short. Read the run
lines to see which:

```sh
pnpm --filter cardano-tessera-backend exec wrangler tail --env preprod
```

Each run logs one `segment scanned:` line with its record counts. `(catching up)`
alone is a healthy walk with more history to cover; `(incomplete)` is the marker
that matters — it means a listed transaction never yielded its record, so the run
banks no cursor and the next one re-walks the same segment. That is the state
that never finishes on its own.

The static Tessera app is optional and is not an integration dependency. If it
is useful for fixture authoring, set its preprod backend URL and run
`pnpm --filter tessera-app deploy:preprod` separately.

## Redeploy a running deployment

A redeploy is the same two steps in one of two orders, and the release's
migrations decide which. Additive ones go first: the new Worker needs what they
create and the running one never sees them. A migration that drops or narrows
anything the running Worker still reads goes after the deploy that stops reading
it — applied first, it breaks every serving read for as long as the upload
takes.

A release carrying both has no safe order, so pick the cheaper casualty.
Deploying first costs `/api/health` and the cron refresh until the migrations
land, while `/health` is answered without touching the database and the serving
reads work off the rows already materialized — usually the side to give up:

```sh
git status --short
pnpm --filter cardano-tessera-backend deploy:preprod
pnpm --filter cardano-tessera-backend migrate:preprod
```

Then repeat the checks above. Expect a catch-up rather than a steady state
whenever the release rewound the walker — a generation bump, or a migration that
left no banked scan state: until `scan.caughtUp`, every run reports
`incomplete: true` and nothing finalizes.

The app is a second deployable reading these payloads, and it is always allowed
to be older than the Worker — a browser holding it does not reload because a
deploy happened. A release that renames or drops a field the app reads therefore
needs `pnpm --filter tessera-app deploy:<network>` in the same window; tabs
already open pick it up at their next load.

Which app build is live answers the same question `/api/health`'s `commit` does,
from the HTML rather than from JSON:

```sh
curl -s https://<app-url>/ | grep tessera-build
```

Both stamps are `git rev-parse HEAD`, so app-versus-Worker skew is a string
comparison. A tab already open still holds whatever it loaded — its own
`<head>` names it, and the Settings screen shows it beside the data source.

## Collect a comparable report

The dependency-free collector reuses Wrangler's current credential. It checks
that both health routes identify the requested network and that the D1 name,
id, and account agree before writing anything. Supply an explicit provider
window of at most 31 days; allow roughly ten minutes after its end for Analytics
aggregation. Describe the workload rather than relying on a filename:

```sh
pnpm metrics:collect -- \
  --network preprod \
  --database-id <database-uuid> \
  --backend-url "$BACKEND_URL" \
  --start 2026-08-05T00:00:00Z \
  --end 2026-08-06T00:00:00Z \
  --cron-cadence '*/3 * * * *' \
  --workload 'steady refresh; no label-17 ingestion' \
  --output /tmp/tessera-preprod-steady.json
```

Use `--account-id <32-hex-id>` when Wrangler can access more than one account
and the database lookup is ambiguous. The report contains:

- Worker outcomes, subrequests, and CPU/wall-time p50, p90, and p99;
- D1 rows and query totals, batch-latency average/quantiles, maximum storage,
  current `wrangler d1 info --json`, and top write queries;
- current Tessera identity and `/api/health` freshness, refresh totals,
  upstream calls, corpus size, payload bytes, and validation backlog;
- account/resource identity, network, source commit, cron cadence, workload,
  and the exact provider window.

Reports are created with mode `0600` because they contain the Cloudflare account
id. Keep raw files local; commit only normalized benchmark figures and their
collection command.

### Deciding whether a footprint is acceptable

One report is a number. The question it exists to answer — can whoever wants this
deployment run it themselves, on a plan they are willing to pay for — needs the
same schema across the workloads that actually differ. Collect one window per
scenario, naming each in `--workload`:

1. steady refresh, with no new label-17 records;
2. ingestion and proof validation of new public responses;
3. repeated reads of the list, an exact-reference bundle, an artifact, tip,
   protocol parameters, and transaction status;
4. public finalization with DRep weights;
5. sealed reveal, which is paced by Worker CPU rather than by subrequests and so
   may span several crons for one survey;
6. a synthetic retained corpus at roughly 100, 1,000, and 10,000 response rows —
   the only practical way to price the serving curves, search above all, without
   manufacturing chain spam;
7. a transient Koios or anchor failure, to price soft failure and recovery.

Record the corpus size beside every figure, and say for each scenario whether its
cost is constant, proportional to new records, proportional to one survey's
participation, or proportional to retained history. The last is the only one that
is a defect rather than a number: §0 of `backend/ARCHITECTURE.md` is the standard
it fails, and §9 lists the one term known to fail it today. Name the first limit
each scenario would reach and the headroom before it.

Do not settle the question against a threshold invented here. Put the evidence in
front of whoever would operate the deployment and record which of three answers
it produced: they are comfortable running one instance per network; a named
optimization is required first, together with the trigger that forces it; or the
deployment stays externally operated for now.

**Wall time is not a footprint.** The refresh's wall clock — the run's own
`duration_ms`, `wrangler tail`'s `wall`, the analytics `wallTime` quantiles — is
its D1 round trips times the distance between the cron isolate and the database.
Cron Triggers carry no placement promise: the same code against the same
database has measured 1.3–2 s from an isolate near the D1 region and 7–15 s from
one on another continent, the level holds for hours or days and moves when a
deploy or the platform re-places the isolate, without a code change. Nothing is
billed by wall and nothing user-facing waits on the refresh, so a step in it is
not evidence about the code. The signals that are: CPU time, the per-run round
trips the scaling bench prints, and the D1 rows and query totals. If wall ever
approaches the cron's own limit, count round trips first.

## Koios quota separation

`KOIOS_TOKEN` is used by operator-critical snapshot scans, proof validation,
finalization, and the cached `/api/tip` and `/api/pparams` routes. Their
calls are reported as `koiosCalls` in `/api/health`.

`KOIOS_PASSTHROUGH_TOKEN` is used only by the uncached, frontend-driven
`/api/tx_status` confirmation route. It never falls back to `KOIOS_TOKEN`; when
unset, those calls use Koios's unauthenticated per-IP quota. They are reported
separately as `passthroughCalls`. Governance-anchor HTTP fetches count as
upstream requests but are not Koios calls. A browser using Tessera's direct
Koios mode supplies its own token and consumes neither backend identity.

`KOIOS_DAILY_LIMIT` states the tier's daily quota, which Koios does not expose
through the API, and `WORKER_SUBREQUEST_CAP` the platform's outbound-request
cap per invocation (1,000 on Workers Paid). Both are `[vars]` values rather
than secrets, and nothing in the backend enforces either: they are the
denominators `/api/health` reports under `quotas` and the health footer
divides `koiosCalls` and the last run's `upstreamRequests` by, so a wrong value
misleads a reader instead of throttling a request. Koios enforces the real
quota with 429s and Cloudflare fails the invocation past its cap; both surface
as a failed refresh. What the backend does enforce on itself is fixed per-pass
work ceilings — transactions enriched by validation, credentials weighted by
finalization, ciphertexts decrypted by reveal — each resumable from what the
pass persisted, so a burst never reaches the platform cap: it postpones. The
Koios quota belongs to the identity, not the deployment, so Workers sharing one
token share one budget while each footer shows only its own share.
Budget before assuming a tier fits: the three-minute cron alone spends roughly
2,000 Koios calls a day per network before any user traffic — four per run (tip,
segment page, drift-rescan page, proposal scan) plus whatever new records cost.
That floor is flat: it is set by the settlement window, not by how much history
the deployment has accumulated.

## Roll back

List Worker versions, then roll back to the recorded known-good version:

```sh
pnpm --filter cardano-tessera-backend exec wrangler versions list --env preprod
pnpm --filter cardano-tessera-backend exec wrangler rollback <version-id> --env preprod --message 'rollback to known-good Tessera commit'
```

A Worker rollback does not reverse migrations, and not every migration can be
rolled back around: one that dropped or narrowed something the older code reads
makes every version below it unservable. Check what the release migrated before
choosing a target version. Where such a migration has landed, the ways back are
forward to a fixed version, or the restore below — which rewinds the migration
ledger along with every write since the bookmark.

If a D1 migration or write damaged data, first obtain the point-in-time bookmark
and then perform the destructive restore explicitly:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 time-travel info DB --env preprod --timestamp <rfc3339-before-change> --json
pnpm --filter cardano-tessera-backend exec wrangler d1 time-travel restore DB --env preprod --bookmark <bookmark>
```

After either rollback, repeat both health checks and wait for one successful
refresh before restoring client traffic.

A restore rewinds the materialized rows to their state at the bookmark, and the
refresh no longer rebuilds them from scratch: the next run re-derives only the
settlement window, so anything older stays as the restore left it until the
drift-healing rescan rotates past it (hours, at one page per run). To force the
whole corpus to be re-derived immediately instead — after a restore, or after a
deploy that changed how records project into rows — bump `SCAN_GENERATION` in
`src/refresh.ts` and deploy. The banked generation then mismatches, the cursor
rewinds to the `SINCE` floor, and the walker re-derives forward over as many
crons as the history needs, exactly as on a fresh database. The bump acts on a
banked generation and needs one to act on: a database whose `scan_state` row is
absent re-derives from the floor on its next run whatever the constant says.
