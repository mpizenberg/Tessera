import assert from "node:assert/strict";
import test from "node:test";

import { parseOptions, validateHealth } from "./collect-cloudflare-metrics.mjs";

const required = [
  "--network",
  "preprod",
  "--database-id",
  "12345678-1234-4234-9234-123456789abc",
  "--backend-url",
  "https://tessera-backend-preprod.example.workers.dev",
  "--start",
  "2026-08-01T00:00:00Z",
  "--end",
  "2026-08-02T00:00:00Z",
  "--cron-cadence",
  "*/3 * * * *",
  "--workload",
  "steady refresh",
];

test("derives strict resource names and canonicalizes the window", () => {
  assert.deepEqual(parseOptions(required), {
    network: "preprod",
    workerName: "tessera-backend-preprod",
    databaseName: "tessera-cache-preprod",
    databaseId: "12345678-1234-4234-9234-123456789abc",
    accountId: undefined,
    backendUrl: "https://tessera-backend-preprod.example.workers.dev",
    startIso: "2026-08-01T00:00:00.000Z",
    endIso: "2026-08-02T00:00:00.000Z",
    cronCadence: "*/3 * * * *",
    workload: "steady refresh",
    output: undefined,
  });
});

test("rejects placeholder and cross-network resources before authentication", () => {
  const placeholder = [...required];
  placeholder[placeholder.indexOf("--database-id") + 1] =
    "00000000-0000-0000-0000-000000000000";
  assert.throws(() => parseOptions(placeholder), /non-placeholder UUID/);

  assert.throws(
    () => parseOptions([...required, "--worker", "tessera-backend-preview"]),
    /does not match network preprod/,
  );
});

test("rejects ambiguous windows and backend URLs", () => {
  const backwards = [...required];
  backwards[backwards.indexOf("--start") + 1] = "2026-08-03T00:00:00Z";
  assert.throws(() => parseOptions(backwards), /must be before/);

  const path = [...required];
  path[path.indexOf("--backend-url") + 1] = "https://example.com/preprod";
  assert.throws(() => parseOptions(path), /must not contain a path/);
});

test("requires both health routes to identify the requested network", () => {
  assert.doesNotThrow(() =>
    validateHealth(
      { ok: true, network: "preprod" },
      { network: "preprod" },
      "preprod",
    ),
  );
  assert.throws(
    () =>
      validateHealth(
        { ok: true, network: "preview" },
        { network: "preprod" },
        "preprod",
      ),
    /network mismatch/,
  );
});
