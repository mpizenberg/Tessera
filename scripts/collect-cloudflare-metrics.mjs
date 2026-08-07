#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BACKEND_PACKAGE = "cardano-tessera-backend";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const NETWORKS = new Set(["preview", "preprod", "mainnet"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const MAX_WINDOW_MS = 31 * 24 * 60 * 60_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseOptions(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    if (values.has(key)) throw new Error(`duplicate option: --${key}`);
    values.set(key, value);
    i += 1;
  }

  const required = [
    "network",
    "database-id",
    "backend-url",
    "start",
    "end",
    "cron-cadence",
    "workload",
  ];
  for (const key of required) {
    if (!values.get(key)) throw new Error(`missing required option: --${key}`);
  }

  const known = new Set([
    ...required,
    "worker",
    "database",
    "account-id",
    "output",
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`unknown option: --${key}`);
  }

  const network = values.get("network");
  if (!NETWORKS.has(network)) {
    throw new Error(`unknown network: ${network}`);
  }
  const workerName = values.get("worker") ?? `tessera-backend-${network}`;
  const databaseName = values.get("database") ?? `tessera-cache-${network}`;
  if (workerName !== `tessera-backend-${network}`) {
    throw new Error(`worker ${workerName} does not match network ${network}`);
  }
  if (databaseName !== `tessera-cache-${network}`) {
    throw new Error(
      `database ${databaseName} does not match network ${network}`,
    );
  }

  const databaseIdInput = values.get("database-id");
  if (!UUID.test(databaseIdInput) || databaseIdInput === PLACEHOLDER) {
    throw new Error("--database-id must be a non-placeholder UUID");
  }
  const databaseId = databaseIdInput.toLowerCase();
  const accountIdInput = values.get("account-id");
  if (accountIdInput && !/^[0-9a-f]{32}$/i.test(accountIdInput)) {
    throw new Error("--account-id must be a 32-character hexadecimal id");
  }

  const accountId = accountIdInput?.toLowerCase();
  const start = parseDate(values.get("start"), "--start");
  const end = parseDate(values.get("end"), "--end");
  if (start >= end) throw new Error("--start must be before --end");
  if (end - start > MAX_WINDOW_MS) {
    throw new Error("measurement window cannot exceed D1's 31-day retention");
  }

  let backendUrl;
  try {
    backendUrl = new URL(values.get("backend-url"));
  } catch {
    throw new Error("--backend-url must be an absolute URL");
  }
  if (
    backendUrl.protocol !== "https:" ||
    backendUrl.search ||
    backendUrl.hash
  ) {
    throw new Error("--backend-url must be an HTTPS origin without query/hash");
  }
  if (backendUrl.pathname !== "/" && backendUrl.pathname !== "") {
    throw new Error("--backend-url must not contain a path");
  }

  return {
    network,
    workerName,
    databaseName,
    databaseId,
    accountId,
    backendUrl: backendUrl.origin,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    cronCadence: values.get("cron-cadence"),
    workload: values.get("workload"),
    output: values.get("output"),
  };
}

export function validateHealth(simple, operational, network) {
  if (simple?.ok !== true || simple?.network !== network) {
    throw new Error(
      `/health network mismatch: expected ${network}, received ${JSON.stringify(simple)}`,
    );
  }
  if (operational?.network !== network) {
    throw new Error(
      `/api/health network mismatch: expected ${network}, received ${JSON.stringify(operational?.network)}`,
    );
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Usage: pnpm metrics:collect -- \\
  --network <preview|preprod|mainnet> --database-id <uuid> \\
  --backend-url <https-origin> --start <ISO> --end <ISO> \\
  --cron-cadence <description> --workload <description> [options]

Options:
  --worker <name>       Defaults to tessera-backend-<network>.
  --database <name>     Defaults to tessera-cache-<network>.
  --account-id <id>     Required only to disambiguate accounts.
  --output <path>       Defaults to a timestamped file under /tmp.

Wrangler must be authenticated. The report contains the Cloudflare account id
and should remain local unless normalized for publication.`);
    return;
  }

  const options = parseOptions(process.argv.slice(2));
  const identity = wranglerJson(["whoami", "--json"]);
  const credential = wranglerJson(["auth", "token", "--json"]);
  const authHeaders = cloudflareAuthHeaders(credential);
  const resource = await findDatabaseAccount(
    identity.accounts,
    options.databaseId,
    options.accountId,
    authHeaders,
  );

  const [simpleHealth, operationalHealth] = await Promise.all([
    fetchJson(`${options.backendUrl}/health`, "health"),
    fetchJson(`${options.backendUrl}/api/health`, "operational health"),
  ]);
  validateHealth(simpleHealth, operationalHealth, options.network);

  const query = analyticsQuery(options, resource.account.id);
  const [analytics, d1Info] = await Promise.all([
    graphql(query, authHeaders),
    Promise.resolve(
      wranglerJson(
        ["d1", "info", options.databaseName, "--json"],
        resource.account.id,
      ),
    ),
  ]);
  validateD1Info(d1Info, options);
  const accountAnalytics = analytics.viewer?.accounts;
  if (!Array.isArray(accountAnalytics) || accountAnalytics.length !== 1) {
    throw new Error("Cloudflare Analytics did not return exactly one account");
  }

  const timestamp = options.endIso.replaceAll(":", "-");
  const outputPath = resolve(
    options.output ??
      `/tmp/tessera-${options.network}-metrics-${timestamp}.json`,
  );
  const report = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    window: { start: options.startIso, end: options.endIso },
    workload: {
      description: options.workload,
      cronCadence: options.cronCadence,
    },
    identity: {
      account: {
        id: resource.account.id,
        name: resource.account.name,
      },
      workerName: options.workerName,
      databaseName: options.databaseName,
      databaseId: options.databaseId,
      network: options.network,
      backendUrl: options.backendUrl,
      // Reported by the deployment itself, so it names the code that produced
      // the figures even when the local checkout has moved on.
      gitCommit: operationalHealth.commit ?? null,
    },
    worker: {
      overall: accountAnalytics[0].workerOverall,
      outcomes: accountAnalytics[0].workerStatuses,
    },
    d1: {
      analytics: accountAnalytics[0].d1Analytics,
      storage: accountAnalytics[0].d1Storage,
      topQueriesByRowsWritten: accountAnalytics[0].d1Queries,
      current: d1Info,
    },
    tessera: {
      identity: simpleHealth,
      health: operationalHealth,
    },
  };

  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(outputPath);
}

function analyticsQuery(options, accountId) {
  const literal = (value) => JSON.stringify(value);
  const common = `
          databaseId: ${literal(options.databaseId)}
          datetime_geq: ${literal(options.startIso)}
          datetime_leq: ${literal(options.endIso)}`;
  return `
query {
  viewer {
    accounts(filter: { accountTag: ${literal(accountId)} }) {
      workerOverall: workersInvocationsAdaptive(
        limit: 10
        filter: {
          scriptName: ${literal(options.workerName)}
          datetime_geq: ${literal(options.startIso)}
          datetime_leq: ${literal(options.endIso)}
        }
      ) {
        sum { requests errors subrequests }
        quantiles {
          cpuTimeP50 cpuTimeP90 cpuTimeP99
          wallTimeP50 wallTimeP90 wallTimeP99
        }
        dimensions { scriptName }
      }
      workerStatuses: workersInvocationsAdaptive(
        limit: 20
        filter: {
          scriptName: ${literal(options.workerName)}
          datetime_geq: ${literal(options.startIso)}
          datetime_leq: ${literal(options.endIso)}
        }
      ) {
        sum { requests errors }
        dimensions { status }
      }
      d1Analytics: d1AnalyticsAdaptiveGroups(
        limit: 10
        filter: {${common}
        }
      ) {
        count
        sum {
          readQueries writeQueries rowsRead rowsWritten
          queryBatchResponseBytes
        }
        avg { queryBatchTimeMs }
        quantiles {
          queryBatchTimeMsP50 queryBatchTimeMsP90 queryBatchTimeMsP99
        }
        dimensions { databaseId }
      }
      d1Storage: d1StorageAdaptiveGroups(
        limit: 10
        filter: {${common}
        }
      ) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }
      d1Queries: d1QueriesAdaptiveGroups(
        limit: 50
        orderBy: [sum_rowsWritten_DESC]
        filter: {
          databaseId: ${literal(options.databaseId)}
          datetimeHour_geq: ${literal(options.startIso)}
          datetimeHour_leq: ${literal(options.endIso)}
        }
      ) {
        count
        sum { queryDurationMs rowsRead rowsWritten rowsReturned }
        avg { queryDurationMs rowsRead rowsWritten rowsReturned }
        dimensions { query }
      }
    }
  }
}`;
}

function parseDate(value, option) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${option} is invalid`);
  return date;
}

function cloudflareAuthHeaders(credential) {
  if (credential.type === "oauth" || credential.type === "api_token") {
    return { Authorization: `Bearer ${credential.token}` };
  }
  if (credential.type === "api_key") {
    return {
      "X-Auth-Key": credential.key,
      "X-Auth-Email": credential.email,
    };
  }
  throw new Error(
    `Wrangler returned unsupported auth type: ${credential.type ?? "unknown"}`,
  );
}

async function findDatabaseAccount(
  accounts,
  databaseId,
  requestedAccountId,
  headers,
) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("Wrangler login has no accessible Cloudflare accounts");
  }
  const candidates = requestedAccountId
    ? accounts.filter((account) => account.id === requestedAccountId)
    : accounts;
  if (candidates.length === 0) {
    throw new Error(
      `Wrangler login cannot access account ${requestedAccountId}`,
    );
  }

  const matches = [];
  for (const account of candidates) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account.id}/d1/database/${databaseId}`,
      { headers },
    );
    if (!response.ok) continue;
    const body = await response.json();
    if (body?.success && body.result?.uuid === databaseId) {
      matches.push({ account, database: body.result });
    }
  }
  if (matches.length === 1) return matches[0];

  const names = candidates.map((account) => account.name).join(", ");
  throw new Error(
    `Could not identify one account containing D1 ${databaseId}; checked: ${names}`,
  );
}

function validateD1Info(info, options) {
  if (
    info?.uuid !== options.databaseId ||
    info?.name !== options.databaseName
  ) {
    throw new Error(
      `D1 resource mismatch: expected ${options.databaseName} (${options.databaseId}), received ${JSON.stringify({ name: info?.name, uuid: info?.uuid })}`,
    );
  }
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`${label} request failed: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} response was not JSON`);
  }
}

async function graphql(graphqlQuery, authHeaders) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      ...authHeaders,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: graphqlQuery }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(
      `Cloudflare GraphQL failed: ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  return body.data;
}

function wranglerJson(args, accountId) {
  const command = ["--filter", BACKEND_PACKAGE, "exec", "wrangler", ...args];
  const result = spawnSync("pnpm", command, {
    cwd: repoRoot,
    encoding: "utf8",
    env: accountId
      ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId }
      : process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `Wrangler command failed (${args.join(" ")}). Run \`pnpm --filter ${BACKEND_PACKAGE} exec wrangler login\` and confirm Analytics Read plus D1 Read access.\n${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Wrangler returned non-JSON output for ${args.join(" ")}:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`metrics collection failed: ${error.message}`);
    process.exitCode = 1;
  });
}
