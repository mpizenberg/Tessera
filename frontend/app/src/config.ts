/** Cardano network selection and per-network endpoints. */

import {
  KOIOS_URL,
  SECONDS_PER_EPOCH,
  type AppConfig,
  type Network,
} from "@tessera/core";

// The config *shape* + endpoint tables are shared with the serving tier and
// live in `@tessera/core`; this module owns only how the browser *resolves*
// them (localStorage overrides + Vite build env). Re-export the types so the
// many `~/config` consumers keep their import path.
export type { AppConfig, Network } from "@tessera/core";

/** CIP-179 went live around here — ignore older label-17 history. */
const SURVEYS_SINCE_ISO = "2026-06-01T00:00:00Z";

/** localStorage key for a user-supplied Koios token (overrides the build env). */
export const KOIOS_TOKEN_STORAGE_KEY = "tessera.koiosToken";

/** localStorage key for a Tier-1 backend URL (overrides the build env). */
export const INDEXER_URL_STORAGE_KEY = "tessera.indexerUrl";

/** localStorage key for a user-selected network (overrides the build env). */
export const NETWORK_STORAGE_KEY = "tessera.network";

/** localStorage key for the last connected CIP-30 wallet (for auto-reconnect). */
export const LAST_WALLET_STORAGE_KEY = "tessera.lastWallet";

/** The build-time default network (from env), ignoring any user override. */
export function envNetwork(): Network {
  return import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "preview";
}

/** A persisted network override, if the user picked one (validated). */
export function storedNetwork(): Network | undefined {
  try {
    const v = localStorage.getItem(NETWORK_STORAGE_KEY);
    return v === "mainnet" || v === "preview" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the selected network. */
export function storeNetwork(network: Network): void {
  try {
    localStorage.setItem(NETWORK_STORAGE_KEY, network);
  } catch {
    // storage unavailable — the in-memory value won't survive a reload
  }
}

/** The CIP-30 key of the last connected wallet, if one was remembered. */
export function storedLastWallet(): string | undefined {
  try {
    return localStorage.getItem(LAST_WALLET_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** Remember (or, when empty, forget) the last connected wallet key. */
export function storeLastWallet(key: string): void {
  try {
    if (key) localStorage.setItem(LAST_WALLET_STORAGE_KEY, key);
    else localStorage.removeItem(LAST_WALLET_STORAGE_KEY);
  } catch {
    // storage unavailable — auto-reconnect just won't persist
  }
}

/** Forget the remembered wallet (on explicit disconnect). */
export function clearLastWallet(): void {
  try {
    localStorage.removeItem(LAST_WALLET_STORAGE_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

/** The build-time Koios token (from env), ignoring any user override. */
export function envKoiosToken(): string | undefined {
  return import.meta.env.VITE_KOIOS_TOKEN || undefined;
}

/** A persisted Koios token override, if the user set one in Settings. */
export function storedKoiosToken(): string | undefined {
  try {
    return localStorage.getItem(KOIOS_TOKEN_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** Persist (or clear, when empty) the Koios token override. */
export function storeKoiosToken(token: string): void {
  const trimmed = token.trim();
  try {
    if (trimmed) localStorage.setItem(KOIOS_TOKEN_STORAGE_KEY, trimmed);
    else localStorage.removeItem(KOIOS_TOKEN_STORAGE_KEY);
  } catch {
    // storage unavailable — keep the in-memory value only
  }
}

/**
 * The build-time Tier-1 backend base URL (from env), ignoring any user override.
 * When set, the app reads its snapshot from this serving tier
 * (`IndexerDataSource`) instead of scanning Koios from the browser; empty ⇒ the
 * direct-Koios path. See `backend/ARCHITECTURE.md` §2/§8.
 */
export function envIndexerUrl(): string | undefined {
  return import.meta.env.VITE_INDEXER_URL || undefined;
}

/** A persisted Tier-1 backend URL override, if the user set one. */
export function storedIndexerUrl(): string | undefined {
  try {
    return localStorage.getItem(INDEXER_URL_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** Persist (or clear, when empty) the Tier-1 backend URL override. */
export function storeIndexerUrl(url: string): void {
  const trimmed = url.trim();
  try {
    if (trimmed) localStorage.setItem(INDEXER_URL_STORAGE_KEY, trimmed);
    else localStorage.removeItem(INDEXER_URL_STORAGE_KEY);
  } catch {
    // storage unavailable — keep the in-memory value only
  }
}

/**
 * The active Tier-1 backend URL: localStorage override → `VITE_INDEXER_URL`.
 * When defined, reads flow through the serving tier (`IndexerDataSource`); when
 * undefined, the app talks to Koios directly (`KoiosDataSource`) — the
 * power-user/offline path, and the escape hatch for verifying against chain.
 * A trailing slash is trimmed so route joins stay clean.
 */
export function resolveIndexerUrl(): string | undefined {
  const url = storedIndexerUrl() ?? envIndexerUrl();
  return url ? url.replace(/\/+$/, "") : undefined;
}

/**
 * Network resolves localStorage override → `VITE_NETWORK` (default Preview).
 * The switch is applied by persisting the choice and reloading, so this runs
 * fresh with the new value — nothing downstream needs to react to it live.
 *
 * The Koios token resolves localStorage override → `VITE_KOIOS_TOKEN`. The free
 * (anonymous) tier does not send CORS headers, so an authenticated token is
 * required for browser requests; without one, Koios calls will be CORS-blocked.
 */
export function loadConfig(): AppConfig {
  const network: Network = storedNetwork() ?? envNetwork();
  return {
    network,
    koiosUrl: KOIOS_URL[network],
    koiosToken: storedKoiosToken() || envKoiosToken(),
    sinceUnix: Math.floor(Date.parse(SURVEYS_SINCE_ISO) / 1000),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
}
