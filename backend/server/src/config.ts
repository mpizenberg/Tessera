/**
 * Server config: resolve the portable {@link AppConfig} (shared with the app)
 * from environment variables, plus the server-only knobs (port, refresh cadence,
 * db path). Everything has a default, so the backend runs with an empty env.
 */

import { readFileSync } from "node:fs";

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

/**
 * Minimal `.env` loader (no dependency): `KEY=VALUE` lines, `#` comments, and
 * optional surrounding quotes. Real environment variables win over the file.
 * Absent file is fine — defaults + real env cover everything.
 */
function loadDotenv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function loadConfig(): ServerConfig {
  loadDotenv();
  const env = process.env;
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
