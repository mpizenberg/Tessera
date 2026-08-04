#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_NAME = "tessera-backend-preview";
const DATABASE_NAME = "tessera-cache-preview";
const DATABASE_ID = "1d86fdaa-b281-4b9d-8f37-9b540eb4b6dd";
const HEALTH_URL =
  "https://tessera-backend-preview.matthieu-pizenberg.workers.dev/api/health";
const BACKEND_PACKAGE = "cardano-tessera-backend";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const WINDOW_HOURS = 24;
const AGGREGATION_LAG_MINUTES = 10;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--help")) {
  console.log(`Usage: pnpm baseline:preview [output.json]

Wrangler must be authenticated. The script reads its current account and
credential through Wrangler, then makes read-only Analytics and D1 calls.
The default output path is under /tmp.`);
  process.exit(0);
}

const identity = wranglerJson(["whoami", "--json"]);
const credential = wranglerJson(["auth", "token", "--json"]);
const authHeaders = cloudflareAuthHeaders(credential);
const accountId = await findDatabaseAccount(identity.accounts, authHeaders);
const end = new Date(Date.now() - AGGREGATION_LAG_MINUTES * 60_000);
const start = new Date(end.getTime() - WINDOW_HOURS * 60 * 60_000);
const startIso = start.toISOString();
const endIso = end.toISOString();
const timestamp = endIso.replaceAll(":", "-");
const outputPath = resolve(
  process.argv[2] ?? `/tmp/tessera-preview-baseline-${timestamp}.json`,
);

const query = `
query {
  viewer {
    accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
      workerOverall: workersInvocationsAdaptive(
        limit: 10
        filter: {
          scriptName: ${JSON.stringify(WORKER_NAME)}
          datetime_geq: ${JSON.stringify(startIso)}
          datetime_leq: ${JSON.stringify(endIso)}
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
          scriptName: ${JSON.stringify(WORKER_NAME)}
          datetime_geq: ${JSON.stringify(startIso)}
          datetime_leq: ${JSON.stringify(endIso)}
        }
      ) {
        sum { requests errors }
        dimensions { status }
      }
      d1Analytics: d1AnalyticsAdaptiveGroups(
        limit: 10
        filter: {
          databaseId: ${JSON.stringify(DATABASE_ID)}
          datetime_geq: ${JSON.stringify(startIso)}
          datetime_leq: ${JSON.stringify(endIso)}
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
        filter: {
          databaseId: ${JSON.stringify(DATABASE_ID)}
          datetime_geq: ${JSON.stringify(startIso)}
          datetime_leq: ${JSON.stringify(endIso)}
        }
      ) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }
    }
  }
}`;

const analytics = await graphql(query, authHeaders);
const d1Info = wranglerJson(["d1", "info", DATABASE_NAME, "--json"], accountId);
const d1Insights = wranglerJson(
  [
    "d1",
    "insights",
    DATABASE_NAME,
    "--time-period",
    "1d",
    "--sort-type",
    "sum",
    "--sort-by",
    "writes",
    "--limit",
    "50",
    "--json",
  ],
  accountId,
);
const healthResponse = await fetch(HEALTH_URL, {
  headers: { Accept: "application/json" },
});
if (!healthResponse.ok) {
  throw new Error(`health request failed: HTTP ${healthResponse.status}`);
}

const report = {
  collectedAt: new Date().toISOString(),
  window: { start: startIso, end: endIso },
  identity: {
    workerName: WORKER_NAME,
    databaseName: DATABASE_NAME,
    databaseId: DATABASE_ID,
    network: "preview",
    healthUrl: HEALTH_URL,
    gitCommit: git(["rev-parse", "HEAD"]),
  },
  analytics,
  d1Info,
  d1Insights,
  health: await healthResponse.json(),
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(outputPath);

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
    `Wrangler returned unsupported auth type: ${credential.type}`,
  );
}

async function findDatabaseAccount(accounts, headers) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("Wrangler login has no accessible Cloudflare accounts");
  }
  if (accounts.length === 1) return accounts[0].id;

  const matches = [];
  for (const account of accounts) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account.id}/d1/database/${DATABASE_ID}`,
      { headers },
    );
    if (response.ok) matches.push(account);
  }
  if (matches.length === 1) return matches[0].id;

  const names = accounts.map((account) => account.name).join(", ");
  throw new Error(
    `Could not identify one account containing ${DATABASE_NAME}; accessible accounts: ${names}`,
  );
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
      `pnpm ${command.join(" ")} failed:\n${result.stderr || result.stdout}`,
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

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}
