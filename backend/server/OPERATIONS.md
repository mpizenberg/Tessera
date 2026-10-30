# Operator runbook

This runbook checks and maintains one Tessera backend per Cardano network. The
preprod deployment is the interoperability target.

## Set up a network

Each network is one Turso database and one Vercel project, named after it
(`<net>` is `preview`, `preprod` or `mainnet`).

1. **Turso:** create the database `tessera-cache-<net>` in `aws-eu-west-1`,
   next to the functions' `dub1` region, and turn on its delete protection.
   Create a read-write token for it. It starts empty: the first refreshes
   rebuild it from the chain.
2. **Vercel:** create the project `tessera-backend-<net>` without a Git
   repository, with Deployment Protection off. Set these Production variables:
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET` (a long random
   string), `KOIOS_TOKEN`, and optionally `KOIOS_PASSTHROUGH_TOKEN`,
   `KOIOS_DAILY_LIMIT` and `SINCE`. Leave `NETWORK` and `GIT_COMMIT` out: the
   build bakes both in.
3. **GitHub:** in the `production` environment, set the variable
   `TURSO_DATABASE_URL_<NET>` and the secret `TURSO_AUTH_TOKEN_<NET>` (upper
   case), which the deploy workflow migrates with, and add `<net>` to the
   backend job's matrix in `.github/workflows/deploy.yml`.

A merge to `main` that touches the backend then builds, migrates and deploys
it; a manual run of the workflow deploys every project. By hand, from
`backend/server`:

```sh
vercel link --project tessera-backend-<net>
NETWORK=<net> pnpm build:vercel
TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… pnpm migrate
vercel deploy --prebuilt --prod
```

After the first deploy, the project's Cron Jobs settings must list
`/cron/refresh` every three minutes, and the refresh route must refuse a caller
without the secret:

```sh
curl -s -o /dev/null -w "%{http_code}\n" "$BACKEND_URL/cron/refresh"   # 401
```

## Verify the deployment

Set the backend's origin, without a trailing path:

```sh
BACKEND_URL=https://<backend-origin>
curl --fail --silent --show-error "$BACKEND_URL/health"
curl --fail --silent --show-error "$BACKEND_URL/api/health"
```

`/api/health` must name the network you expect and report the commit you just
deployed in `commit`.

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
lines in the deployment's logs to see which. Each run logs one `segment scanned:` line with its record counts. `(catching up)`
alone is a healthy walk with more history to cover; `(incomplete)` is the marker
that matters — it means a listed transaction never yielded its record, so the run
banks no cursor and the next one re-walks the same segment. That is the state
that never finishes on its own.

### Between an epoch's end and its artifacts

A survey that closed at the last epoch boundary has no artifact for hours, and
that is the healthy state: finalization waits until the end of the survey's
`end_epoch` is `k` blocks deep (2160 on mainnet and preprod, 432 on preview) and
can no longer roll back. That takes about 12 hours on mainnet and preprod and
3.5 on preview, and at most 36 and 7.2. Meanwhile:

- `GET /api/surveys` carries `settling`, `{ epoch, blocksLeft }`, and
  `blocksLeft` falls from one refresh to the next;
- each run logs `finalize: N survey(s) postponed — end epoch not final yet`;
- the survey has no `finalState`, and the app shows its live results under a
  notice.

`finality read failed (will retry)` in the run lines means Koios did not
answer the depth read; the run treats the epoch as not final and the payload
omits `settling` for that snapshot. It matters only if it persists past the
upper bound above, after which the refresh stops asking and finalizes anyway.

## Redeploy a running deployment

A redeploy is the same two steps in one of two orders, and the release's
migrations decide which. Additive ones go first: the new code needs what they
create and the running one never sees them. A migration that drops or narrows
anything the running code still reads goes after the deploy that stops reading
it — applied first, it breaks every serving read for as long as the deploy
takes. The deploy workflow always migrates first, so a narrowing migration
ships in a release of its own, after the one that stops reading what it
removes.

A release carrying both has no safe order, so pick the cheaper casualty.
Deploying first costs `/api/health` and the cron refresh until the migrations
land, while `/health` is answered without touching the database and the serving
reads work off the rows already materialized — usually the side to give up.

Then repeat the checks above. Expect a catch-up rather than a steady state
whenever the release rewound the walker — a generation bump, or a migration that
left no banked scan state: until `scan.caughtUp`, every run reports
`incomplete: true` and nothing finalizes.

The app is a second deployable reading these payloads, and it is always allowed
to be older than the backend — a browser holding it does not reload because a
deploy happened. A release that renames or drops a field the app reads therefore
needs the app deployed in the same window; tabs already open pick it up at
their next load.

Which app build is live answers the same question `/api/health`'s `commit` does,
from the HTML rather than from JSON:

```sh
curl -s https://<app-url>/ | grep tessera-build
```

Both stamps are `git rev-parse HEAD`, so app-versus-backend skew is a string
comparison. A tab already open still holds whatever it loaded — its own
`<head>` names it, and the Settings screen shows it beside the data source.

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
through the API. It is a plain variable rather than a secret, and nothing in
the backend enforces it: it is the denominator `/api/health` reports under
`quotas` and the health footer divides `koiosCalls` by, so a wrong value
misleads a reader instead of throttling a request. Koios enforces the real
quota with 429s, which surface as a failed refresh. What the backend does
enforce on itself is fixed per-pass work ceilings — transactions enriched by
validation, credentials weighted by finalization, ciphertexts decrypted by
reveal — each resumable from what the pass persisted, so a burst postpones
work instead of running a refresh into its time limit, which `/api/health`
reports as `quotas.refreshSecondsPerRun` beside the slowest run of the day. The
Koios quota belongs to the identity, not the deployment, so deployments sharing
one token share one budget while each footer shows only its own share.
Budget before assuming a tier fits: the three-minute cron alone spends roughly
2,000 Koios calls a day per network before any user traffic — four per run (tip,
segment page, drift-rescan page, proposal scan) plus whatever new records cost.
That floor is flat: it is set by the settlement window, not by how much history
the deployment has accumulated.

## Roll back

Vercel rolls a project back by promoting an earlier deployment (`vercel
rollback`, or Instant Rollback in the dashboard). That does not reverse
migrations, and not every migration can be
rolled back around: one that dropped or narrowed something the older code reads
makes every version below it unservable. Check what the release migrated before
choosing a target version. Where such a migration has landed, the ways back are
forward to a fixed version, or a point-in-time restore of the database — which
rewinds the migration ledger along with every write since that point. Turso
restores into a new database (`turso db create <new> --from-db <db> --timestamp
<time>`); point the project's `TURSO_DATABASE_URL` and the GitHub variable at
it, mint a token for it, and redeploy.

After either rollback, repeat both health checks and wait for one successful
refresh before restoring client traffic.

A restore rewinds the materialized rows to their state at that point, and the
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
