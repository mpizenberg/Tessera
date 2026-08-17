/** Cardano network selection and per-network endpoints. */

import {
  KOIOS_URL,
  NETWORKS,
  SECONDS_PER_EPOCH,
  type AppConfig,
  type Network,
} from "cardano-tessera-core";

// The config *shape* + endpoint tables are shared with the serving tier and
// live in `cardano-tessera-core`; this module owns only how the browser *resolves*
// them (localStorage overrides + the `__DEPLOYMENT__` baked in from
// deployments.ts). Re-export the types so the many `~/config` consumers keep
// their import path.
export type { AppConfig, Network } from "cardano-tessera-core";

/** CIP-179 went live around here — ignore older label-17 history. */
const SURVEYS_SINCE_ISO = "2026-06-01T00:00:00Z";

/** localStorage key for the last connected CIP-30 wallet (for auto-reconnect). */
const LAST_WALLET_STORAGE_KEY = "tessera.lastWallet";

/**
 * The network this deployment serves. **One deployment, one network**: there
 * is no runtime switch — the paired backend (Worker + D1) is single-network
 * too, so switching in place could only mix networks. The network deployments
 * are builds of the same code, cross-linked through the per-network
 * `TESSERA_APP_URL_*` values.
 */
export function envNetwork(): Network {
  return __DEPLOYMENT__.network;
}

/**
 * Which repo state this artifact was built from, as the Worker reports its own
 * through `/api/health` — the two are the same derivation, so a skew between
 * app and backend is a string comparison.
 */
export function buildCommit(): string {
  return __DEPLOYMENT__.commit;
}

/**
 * The CIP-30 `networkId` a configured {@link Network} expects: `1` for mainnet,
 * `0` for every testnet (preview/preprod). The single source of truth for the
 * wallet-vs-app network comparison, on both the display and the submit side.
 */
export function expectedNetworkId(network: Network): number {
  return network === "mainnet" ? 1 : 0;
}

export interface NetworkLink {
  readonly network: Network;
  readonly url: string;
}

/** Configured deployments other than the network this build serves. */
export function networkLinks(): readonly NetworkLink[] {
  const active = envNetwork();
  return NETWORKS.flatMap((network) => {
    const url = __DEPLOYMENT__.appUrls[network];
    return network !== active && url ? [{ network, url }] : [];
  });
}

/**
 * localStorage keys for user overrides are **per network**. Deployed apps get
 * isolation from being on separate origins already; these keys cover the one
 * place origins collide — local dev, where `localhost` serves whichever
 * network the dev server was started for — so a preview override never leaks
 * into a mainnet session on the same origin.
 */
const koiosTokenKey = (): string => `tessera.koiosToken.${envNetwork()}`;
const indexerUrlKey = (): string => `tessera.indexerUrl.${envNetwork()}`;
const directSinceKey = (): string => `tessera.directSince.${envNetwork()}`;

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

/** The Koios token for this network, if the user set one in Settings. */
export function storedKoiosToken(): string | undefined {
  try {
    return localStorage.getItem(koiosTokenKey()) || undefined;
  } catch {
    return undefined;
  }
}

/** Persist (or clear, when empty) the Koios token for this network. */
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
 * The build-time Tier-1 backend base URL (from `.env.deploy`), ignoring any
 * user override. When set, the app reads its snapshot from this serving tier
 * (`IndexerDataSource`) instead of scanning Koios from the browser; absent ⇒
 * the direct-Koios path. Must serve the deployment's network — the app
 * verifies this against the backend's `/health` and refuses mixed-network
 * data. See `backend/ARCHITECTURE.md` §2/§7.
 */
export function envIndexerUrl(): string | undefined {
  return __DEPLOYMENT__.indexerUrl;
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
 * How long an emergency direct-mode activation lasts. The stamp *is* the
 * toggle: while fresh the app bypasses the backend entirely; once stale it is
 * inert and the serving tier resumes at the next load. Nobody lives in
 * degraded mode by accident.
 */
export const DIRECT_MODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * When the emergency direct-mode activation expires (epoch ms), if one is
 * currently in force. Undefined ⇒ no stamp, a stale stamp, or an unreadable
 * one — all meaning the serving tier applies.
 */
export function directModeUntil(): number | undefined {
  try {
    const since = Number(localStorage.getItem(directSinceKey()));
    const until = since + DIRECT_MODE_TTL_MS;
    return since > 0 && Date.now() < until ? until : undefined;
  } catch {
    return undefined;
  }
}

/** Enter emergency direct mode: stamp now; expires after the TTL. */
export function activateDirectMode(): void {
  try {
    localStorage.setItem(directSinceKey(), String(Date.now()));
  } catch {
    // storage unavailable — activation can't outlive the session anyway
  }
}

/**
 * Leave emergency direct mode. Removes only the stamp — the stored Koios
 * token survives, so re-activating is one click, not a re-paste.
 */
export function deactivateDirectMode(): void {
  try {
    localStorage.removeItem(directSinceKey());
  } catch {
    // storage unavailable — nothing stamped
  }
}

/**
 * The active Tier-1 backend URL: localStorage override → the deployment's
 * `indexerUrl`.
 * When defined, reads flow through the serving tier (`IndexerDataSource`); when
 * undefined, the app talks to Koios directly (`KoiosDataSource`) — the
 * emergency-participation path for a down backend, and the only mode of a
 * build with no backend configured. A fresh emergency stamp overrides any
 * configured URL. A trailing slash is trimmed so route joins stay clean.
 */
export function resolveIndexerUrl(): string | undefined {
  if (directModeUntil() !== undefined) return undefined;
  const url = storedIndexerUrl() ?? envIndexerUrl();
  return url ? url.replace(/\/+$/, "") : undefined;
}

/**
 * The network is fixed at build time (the build mode) — see
 * {@link envNetwork} for why there is no runtime override.
 *
 * The Koios token comes only from Settings — never from the build, which would
 * ship one shared credential to every browser. The free (anonymous) tier does
 * not send CORS headers, so an authenticated token is required for browser
 * requests; without one, Koios calls will be CORS-blocked.
 */
export function loadConfig(): AppConfig {
  const network = envNetwork();
  return {
    network,
    koiosUrl: KOIOS_URL[network],
    koiosToken: storedKoiosToken(),
    sinceUnix: Math.floor(Date.parse(SURVEYS_SINCE_ISO) / 1000),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
}
