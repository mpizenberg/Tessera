/** Cardano network selection and per-network endpoints. */

export type Network = "mainnet" | "preview";

export interface AppConfig {
  readonly network: Network;
  /** Koios REST base URL for the active network. */
  readonly koiosUrl: string;
  /**
   * Koios bearer token resolved at startup: a user override from Settings
   * (localStorage) takes precedence over the build-time `VITE_KOIOS_TOKEN`.
   * Runtime changes flow through `state.tsx` (reactive), this is just the seed.
   */
  readonly koiosToken: string | undefined;
  /**
   * Only index CIP-179 transactions at or after this unix time. Anchored on a
   * wall-clock date (not an epoch number) so it works across networks, since
   * the epoch active on a given date differs per network.
   */
  readonly sinceUnix: number;
  /**
   * Epoch length in seconds for the active network (mainnet 5 days, preview
   * 1 day). Used only to estimate the wall-clock reveal time of a future end
   * epoch when auto-deriving a sealed survey's drand round — a coarse estimate,
   * not consensus-critical.
   */
  readonly secondsPerEpoch: number;
}

const KOIOS_URL: Record<Network, string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1",
};

/** Epoch length per network, in seconds (mainnet 432000 = 5d, preview 86400 = 1d). */
const SECONDS_PER_EPOCH: Record<Network, number> = {
  mainnet: 432000,
  preview: 86400,
};

/** CIP-179 went live around here — ignore older label-17 history. */
const SURVEYS_SINCE_ISO = "2026-06-01T00:00:00Z";

/** localStorage key for a user-supplied Koios token (overrides the build env). */
export const KOIOS_TOKEN_STORAGE_KEY = "tessera.koiosToken";

/** localStorage key for a user-selected network (overrides the build env). */
export const NETWORK_STORAGE_KEY = "tessera.network";

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
