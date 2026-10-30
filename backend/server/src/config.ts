/**
 * Server config: resolve the portable {@link AppConfig} (shared with the app)
 * from an environment record, plus the server-only knobs (port, refresh
 * cadence, db path). Everything has a default, so the backend runs with an
 * empty env.
 *
 * The env is a parameter rather than `process.env`, so tests can pass their
 * own record. `port`/`dbPath`/`refreshSeconds` configure the long-lived Node
 * process only.
 */

import { SECONDS_PER_EPOCH, parseNetwork } from "cardano-tessera-client";
import { KOIOS_URL, type AppConfig } from "cardano-tessera-core";

/** CIP-179 went live around here — ignore older label-17 history. */
const SURVEYS_SINCE_ISO_DEFAULT = "2026-06-01T00:00:00Z";

export interface ServerConfig {
  readonly app: AppConfig;
  readonly port: number;
  /** Snapshot refresh interval, seconds. */
  readonly refreshSeconds: number;
  /**
   * SQLite file path, or ":memory:". Defaults per network: a store banks the
   * network it was walked for and refuses another, so one shared default
   * path would only ever serve the first network to open it.
   */
  readonly dbPath: string;
  /**
   * The refresh function's time limit, seconds, baked into the functions by
   * `vercel-output.ts` from the `maxDuration` it sets. `undefined` for local
   * runs, which have no limit.
   */
  readonly refreshMaxSeconds: number | undefined;
  /**
   * Koios daily request quota for the configured token tier, if the operator
   * knows it (Koios tiers are account-side, not discoverable via the API).
   * `undefined` = unknown: the health payload then reports the 24 h total
   * without a limit to compare against, which is also what it does for every
   * other upstream service — none of them tell us their number either.
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
  /**
   * Git commit of the running code, baked into the functions by
   * `vercel-output.ts` and reported by `/api/health`, so a deployment names the
   * code that produced its responses. `undefined` for local runs.
   */
  readonly commit: string | undefined;
}

export function loadConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const network = parseNetwork(env["NETWORK"] || "preview");
  const sinceIso = env["SINCE"] ?? SURVEYS_SINCE_ISO_DEFAULT;
  const app: AppConfig = {
    network,
    koiosUrl: env["KOIOS_URL"] || KOIOS_URL[network],
    koiosToken: env["KOIOS_TOKEN"] || undefined,
    sinceUnix: Math.floor(Date.parse(sinceIso) / 1000),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
  const declared = (name: string): number | undefined => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return {
    app,
    port: Number(env["PORT"] ?? 8787),
    refreshSeconds: Number(env["REFRESH_SECONDS"] ?? 180),
    dbPath: env["DB_PATH"] ?? `./tessera-cache-${network}.sqlite`,
    refreshMaxSeconds: declared("REFRESH_MAX_SECONDS"),
    koiosDailyLimit: declared("KOIOS_DAILY_LIMIT"),
    passthroughKoiosToken: env["KOIOS_PASSTHROUGH_TOKEN"] || undefined,
    commit: env["GIT_COMMIT"] || undefined,
  };
}
