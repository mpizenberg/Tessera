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
  /**
   * Upstream requests one refresh may reasonably make — Koios reads and
   * governance-anchor fetches alike — the health endpoint's per-refresh
   * headroom denominator. Defaults to the Cloudflare Worker free-plan
   * subrequest cap; on the paid plan (or self-hosted Node, where no platform
   * cap exists) raise it to keep the footer's ratio meaningful.
   */
  readonly koiosCallsPerRefreshLimit: number;
  /**
   * Koios daily request quota for the configured token tier, if the operator
   * knows it (Koios tiers are account-side, not discoverable via the API).
   * `undefined` = unknown: the health payload then reports the 24 h total
   * without a limit to compare against.
   */
  readonly koiosDailyLimit: number | undefined;
  /**
   * A SEPARATE Koios identity for the comfort passthrough (`/api/tx_status`) —
   * uncached, frontend-driven confirmation polling. Kept distinct from
   * `app.koiosToken` so a flood of that public endpoint can only burn *this*
   * quota, never the identity refresh/validate/finalize depend on for artifact
   * correctness (review finding 15). Defaults to `undefined` = unauthenticated:
   * a genuinely separate, per-IP-limited Koios bucket with zero config. Set
   * `KOIOS_PASSTHROUGH_TOKEN` to give comfort traffic its own keyed tier.
   */
  readonly passthroughKoiosToken: string | undefined;
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
  const dailyLimit = Number(env["KOIOS_DAILY_LIMIT"]);
  return {
    app,
    port: Number(env["PORT"] ?? 8787),
    refreshSeconds: Number(env["REFRESH_SECONDS"] ?? 180),
    dbPath: env["DB_PATH"] ?? "./tessera-cache.sqlite",
    koiosCallsPerRefreshLimit: Number(env["SUBREQUEST_LIMIT"] ?? 50),
    koiosDailyLimit:
      Number.isFinite(dailyLimit) && dailyLimit > 0 ? dailyLimit : undefined,
    passthroughKoiosToken: env["KOIOS_PASSTHROUGH_TOKEN"] || undefined,
  };
}
