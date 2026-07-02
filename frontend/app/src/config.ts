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

/** localStorage key for the last connected CIP-30 wallet (for auto-reconnect). */
export const LAST_WALLET_STORAGE_KEY = "tessera.lastWallet";

/**
 * The network this deployment serves, from the build env. **One deployment,
 * one network**: there is no runtime switch — the paired backend (Worker + D1)
 * is single-network too, so switching in place could only mix networks. The
 * mainnet and preview apps are two builds of the same code, cross-linked via
 * {@link otherNetworkUrl}.
 */
export function envNetwork(): Network {
  return import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "preview";
}

/** The counterpart network — the one this deployment does *not* serve. */
export function otherNetwork(): Network {
  return envNetwork() === "mainnet" ? "preview" : "mainnet";
}

/**
 * Where the counterpart-network deployment lives (`VITE_OTHER_NETWORK_URL`),
 * so the UI can link to it instead of switching in place. Optional — without
 * it the UI simply shows the active network with no link.
 */
export function otherNetworkUrl(): string | undefined {
  return import.meta.env.VITE_OTHER_NETWORK_URL || undefined;
}

/**
 * localStorage keys for user overrides are **per network**. Deployed apps get
 * isolation from being on separate origins already; these keys cover the one
 * place origins collide — local dev, where `localhost` serves whichever
 * network `.env` picks — so a preview override never leaks into a mainnet
 * session on the same origin.
 */
const koiosTokenKey = (): string => `tessera.koiosToken.${envNetwork()}`;
const indexerUrlKey = (): string => `tessera.indexerUrl.${envNetwork()}`;

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

/** A persisted Koios token override for this network, if the user set one. */
export function storedKoiosToken(): string | undefined {
  try {
    return localStorage.getItem(koiosTokenKey()) || undefined;
  } catch {
    return undefined;
  }
}

/** Persist (or clear, when empty) the Koios token override for this network. */
export function storeKoiosToken(token: string): void {
  const trimmed = token.trim();
  try {
    if (trimmed) localStorage.setItem(koiosTokenKey(), trimmed);
    else localStorage.removeItem(koiosTokenKey());
  } catch {
    // storage unavailable — keep the in-memory value only
  }
}

/**
 * The build-time Tier-1 backend base URL (from env), ignoring any user override.
 * When set, the app reads its snapshot from this serving tier
 * (`IndexerDataSource`) instead of scanning Koios from the browser; empty ⇒ the
 * direct-Koios path. Must serve the same network as `VITE_NETWORK` — the app
 * verifies this against the backend's `/health` and refuses mixed-network data.
 * See `backend/ARCHITECTURE.md` §2/§8.
 */
export function envIndexerUrl(): string | undefined {
  return import.meta.env.VITE_INDEXER_URL || undefined;
}

/** A persisted Tier-1 backend URL override for this network, if the user set one. */
export function storedIndexerUrl(): string | undefined {
  try {
    return localStorage.getItem(indexerUrlKey()) || undefined;
  } catch {
    return undefined;
  }
}

/** Persist (or clear, when empty) the Tier-1 backend URL override for this network. */
export function storeIndexerUrl(url: string): void {
  const trimmed = url.trim();
  try {
    if (trimmed) localStorage.setItem(indexerUrlKey(), trimmed);
    else localStorage.removeItem(indexerUrlKey());
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
 * The network is fixed at build time (`VITE_NETWORK`, default Preview) — see
 * {@link envNetwork} for why there is no runtime override.
 *
 * The Koios token resolves localStorage override → `VITE_KOIOS_TOKEN`. The free
 * (anonymous) tier does not send CORS headers, so an authenticated token is
 * required for browser requests; without one, Koios calls will be CORS-blocked.
 */
export function loadConfig(): AppConfig {
  const network = envNetwork();
  return {
    network,
    koiosUrl: KOIOS_URL[network],
    koiosToken: storedKoiosToken() || envKoiosToken(),
    sinceUnix: Math.floor(Date.parse(SURVEYS_SINCE_ISO) / 1000),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
}
