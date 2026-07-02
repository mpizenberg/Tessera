/**
 * Server config: resolve the portable {@link AppConfig} (shared with the app)
 * from an environment record, plus the server-only knobs (port, refresh
 * cadence, db path). Everything has a default, so the backend runs with an
 * empty env.
 *
 * The env is a parameter rather than `process.env` because Cloudflare Workers
 * receive their env per invocation (there is no process): the Node entry
 * passes `process.env` (after its `.env` overlay), the Worker entry passes its
 * `env` binding. `port`/`dbPath`/`refreshSeconds` are Node-only — the Worker
 * gets its port from the platform, its storage from a D1 binding, and its
 * cadence from the cron trigger.
 */

import {
  KOIOS_URL,
  SECONDS_PER_EPOCH,
  type AppConfig,
  type Network,
} from "@tessera/core";

/** CIP-179 went live around here — ignore older label-17 history. */
const SURVEYS_SINCE_ISO_DEFAULT = "2026-06-01T00:00:00Z";

export interface ServerConfig {
  readonly app: AppConfig;
  readonly port: number;
  /** Snapshot refresh interval, seconds. */
  readonly refreshSeconds: number;
  /** SQLite file path, or ":memory:". */
  readonly dbPath: string;
}

export function loadConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const network: Network = env["NETWORK"] === "mainnet" ? "mainnet" : "preview";
  const sinceIso = env["SINCE"] ?? SURVEYS_SINCE_ISO_DEFAULT;
  const app: AppConfig = {
    network,
    koiosUrl: env["KOIOS_URL"] || KOIOS_URL[network],
    koiosToken: env["KOIOS_TOKEN"] || undefined,
    sinceUnix: Math.floor(Date.parse(sinceIso) / 1000),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
  return {
    app,
    port: Number(env["PORT"] ?? 8787),
    refreshSeconds: Number(env["REFRESH_SECONDS"] ?? 180),
    dbPath: env["DB_PATH"] ?? "./tessera-cache.sqlite",
  };
}
