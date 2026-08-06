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

Apply every committed migration before deploying the Worker:

```sh
pnpm --filter cardano-tessera-backend migrate:preprod
```

Deploy the exact checked-out commit:

```sh
git status --short
GIT_COMMIT=$(git rev-parse HEAD)
pnpm --filter cardano-tessera-backend deploy:preprod
```

Record `GIT_COMMIT`, the deployment/version id, and the `workers.dev` URL from
Wrangler's output. Do not point a client at the service yet.

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

A hostname deployed under a `workers.dev` name for the first time can answer
`error code: 1042` — sometimes with HTTP 404, and inconsistently between edges —
for a minute or two while the route propagates. That is not a failed deploy;
retry until it answers rather than redeploying or recreating the Worker. The
same applies to the app's `tessera-<network>` hostname.

`/health` must return `{"ok":true,"network":"preprod"}`. Wait at least one
three-minute cron interval for the first scan. `/api/health` must then report
`network: "preprod"`, a non-null `snapshot`, an `ok` latest refresh, and
`validationBacklog: 0`. The following check enforces those gates:

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
  health.validationBacklog !== 0
)
  throw new Error(`preprod is not ready: ${JSON.stringify(health)}`);
console.log(JSON.stringify({ identity, health }, null, 2));
NODE
```

Use `wrangler tail` to inspect the first refresh and its upstream count:

```sh
pnpm --filter cardano-tessera-backend exec wrangler tail --env preprod
```

The static Tessera app is optional and is not an integration dependency. If it
is useful for fixture authoring, set its preprod backend URL and run
`pnpm --filter tessera-app deploy:preprod` separately.

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
  --git-commit "$GIT_COMMIT" \
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

## Koios quota separation

`KOIOS_TOKEN` is used by operator-critical snapshot scans, proof validation,
finalization, and the short-cached `/api/tip` and `/api/pparams` routes. Their
calls are reported as `koiosCalls` in `/api/health`.

`KOIOS_PASSTHROUGH_TOKEN` is used only by the uncached, frontend-driven
`/api/tx_status` confirmation route. It never falls back to `KOIOS_TOKEN`; when
unset, those calls use Koios's unauthenticated per-IP quota. They are reported
separately as `passthroughCalls`. Governance-anchor HTTP fetches count as
upstream requests but are not Koios calls. A browser using Tessera's direct
Koios mode supplies its own token and consumes neither backend identity.

`KOIOS_DAILY_LIMIT` states the tier's daily quota, which Koios does not expose
through the API. It is a `[vars]` value rather than a secret, and nothing in the
backend enforces it: it is only the denominator the health footer divides
`koiosCalls` by, so a wrong value misleads a reader instead of throttling a
request. Koios enforces the real quota with 429s, which surface as a failed
refresh. The quota belongs to the identity, not the deployment, so Workers
sharing one token share one budget while each footer shows only its own share.
Budget before assuming a tier fits: the three-minute cron alone spends roughly
2,400 Koios calls a day per network before any user traffic.

## Roll back

List Worker versions, then roll back to the recorded known-good version:

```sh
pnpm --filter cardano-tessera-backend exec wrangler versions list --env preprod
pnpm --filter cardano-tessera-backend exec wrangler rollback <version-id> --env preprod --message 'rollback to known-good Tessera commit'
```

Migrations are additive and are not reversed by a Worker rollback. If a D1
migration or write damaged data, first obtain the point-in-time bookmark and
then perform the destructive restore explicitly:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 time-travel info DB --env preprod --timestamp <rfc3339-before-change> --json
pnpm --filter cardano-tessera-backend exec wrangler d1 time-travel restore DB --env preprod --bookmark <bookmark>
```

After either rollback, repeat both health checks and wait for one successful
refresh before restoring client traffic.
