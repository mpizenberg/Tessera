import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The template, not the operator's git-ignored wrangler.toml: it is the only
// deployment configuration this repository ships, and the copy on any one
// machine says nothing about what a fresh checkout would deploy.
const wrangler = readFileSync(
  resolve(packageRoot, "wrangler.toml.example"),
  "utf8",
);
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const networks = ["preview", "preprod", "mainnet"] as const;

function environmentValue(
  network: (typeof networks)[number],
  section: string,
  key: string,
): string {
  const header = section
    ? section === "d1_databases"
      ? `[[env.${network}.${section}]]`
      : `[env.${network}.${section}]`
    : `[env.${network}]`;
  const start = wrangler.indexOf(header);
  const end = wrangler.indexOf("\n[", start + header.length);
  const block = wrangler.slice(start, end < 0 ? undefined : end);
  const match = block.match(new RegExp(`^${key} = "([^"]+)"`, "m"));
  if (start < 0 || !match) {
    throw new Error(`missing ${network}.${section}.${key}`);
  }
  return match[1];
}

describe("named Worker deployments", () => {
  it("keeps every network's Worker, D1 resource, and runtime identity distinct", () => {
    const configurations = networks.map((network) => ({
      network,
      worker: environmentValue(network, "", "name"),
      runtimeNetwork: environmentValue(network, "vars", "NETWORK"),
      binding: environmentValue(network, "d1_databases", "binding"),
      database: environmentValue(network, "d1_databases", "database_name"),
      databaseId: environmentValue(network, "d1_databases", "database_id"),
      migrations: environmentValue(network, "d1_databases", "migrations_dir"),
    }));

    for (const config of configurations) {
      expect(config).toMatchObject({
        worker: `tessera-backend-${config.network}`,
        runtimeNetwork: config.network,
        binding: "DB",
        database: `tessera-cache-${config.network}`,
        migrations: "migrations",
      });
    }
    expect(new Set(configurations.map(({ worker }) => worker)).size).toBe(3);
    expect(new Set(configurations.map(({ database }) => database)).size).toBe(
      3,
    );
  });

  it("ships no account's database ids", () => {
    const ids = [...wrangler.matchAll(/^database_id = "([^"]+)"/gm)].map(
      (match) => match[1],
    );
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toBe(PLACEHOLDER_DATABASE_ID);
  });

  it("pins preprod's CPU budget and selects environments by name alone", () => {
    expect(wrangler).toMatch(/\[env\.preprod\.limits\]\s+cpu_ms = 30000/);
    for (const network of networks) {
      expect(packageJson.scripts[`migrate:${network}`]).toBe(
        `wrangler d1 migrations apply DB --env ${network} --remote`,
      );
      // Deploys stamp the checked-out commit so /api/health can report it.
      expect(packageJson.scripts[`deploy:${network}`]).toBe(
        `wrangler deploy --env ${network} --var GIT_COMMIT:$(git rev-parse HEAD)`,
      );
    }
  });
});
