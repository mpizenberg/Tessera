# Cloudflare operator runbook

This runbook deploys one Tessera backend per Cardano network. The preprod path
is the interoperability target; its fixed resource names are
`tessera-backend-preprod` and `tessera-cache-preprod`. Run commands from a clean
repository checkout after `pnpm install --frozen-lockfile` and
`pnpm --filter cardano-tessera-backend exec wrangler login`.

## Create and configure preprod

Create the database once:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 create tessera-cache-preprod
```

Copy the UUID printed by Wrangler into this command:

```sh
pnpm --filter cardano-tessera-backend configure:preprod -- <database-uuid>
```

This generates `backend/server/wrangler.preprod.toml` with mode `0600`. The file
is git-ignored because the generated resource id belongs to the operator
account, not portable source. Re-run the command after replacing the checkout
or whenever the committed `wrangler.toml` changes. An existing database's UUID
is available from:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 info tessera-cache-preprod --json
```

Apply every committed migration before deploying the Worker:

```sh
pnpm --filter cardano-tessera-backend migrate:preprod
```

Both Koios tokens are optional. If the critical path needs keyed quota, enter
the token interactively so it never appears in shell history or source:

```sh
pnpm --filter cardano-tessera-backend exec wrangler secret put KOIOS_TOKEN --config wrangler.preprod.toml --env preprod
pnpm --filter cardano-tessera-backend exec wrangler secret put KOIOS_PASSTHROUGH_TOKEN --config wrangler.preprod.toml --env preprod
```

Deploy the exact checked-out commit:

```sh
git status --short
GIT_COMMIT=$(git rev-parse HEAD)
pnpm --filter cardano-tessera-backend deploy:preprod
```

Record `GIT_COMMIT`, the deployment/version id, and the `workers.dev` URL from
Wrangler's output. Do not point a client at the service yet.

## Verify the deployment

Set the origin printed by Wrangler, without a trailing path:

```sh
BACKEND_URL=https://tessera-backend-preprod.<account-subdomain>.workers.dev
curl --fail --silent --show-error "$BACKEND_URL/health"
curl --fail --silent --show-error "$BACKEND_URL/api/health"
```

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
pnpm --filter cardano-tessera-backend exec wrangler tail --config wrangler.preprod.toml --env preprod
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

## Roll back

List Worker versions, then roll back to the recorded known-good version:

```sh
pnpm --filter cardano-tessera-backend exec wrangler versions list --config wrangler.preprod.toml --env preprod
pnpm --filter cardano-tessera-backend exec wrangler rollback <version-id> --config wrangler.preprod.toml --env preprod --message 'rollback to known-good Tessera commit'
```

Migrations are additive and are not reversed by a Worker rollback. If a D1
migration or write damaged data, first obtain the point-in-time bookmark and
then perform the destructive restore explicitly:

```sh
pnpm --filter cardano-tessera-backend exec wrangler d1 time-travel info DB --config wrangler.preprod.toml --env preprod --timestamp <rfc3339-before-change> --json
pnpm --filter cardano-tessera-backend exec wrangler d1 time-travel restore DB --config wrangler.preprod.toml --env preprod --bookmark <bookmark>
```

After either rollback, repeat both health checks and wait for one successful
refresh before restoring client traffic.
