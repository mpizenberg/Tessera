/** Cardano network selection and per-network endpoints. */

export type Network = "mainnet" | "preview";

export interface AppConfig {
  readonly network: Network;
  /** Koios REST base URL for the active network. */
  readonly koiosUrl: string;
  /** Optional Koios bearer token (free tier works without one). */
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

/**
 * Default to Preview testnet; overridable via Vite env (VITE_NETWORK).
 *
 * The Koios token comes from VITE_KOIOS_TOKEN (see `.env`). The free
 * (anonymous) tier does not send CORS headers, so an authenticated token is
 * required for browser requests; without one, Koios calls will be CORS-blocked.
 */
export function loadConfig(): AppConfig {
  const network: Network =
    import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "preview";
  return {
    network,
    koiosUrl: KOIOS_URL[network],
    koiosToken: import.meta.env.VITE_KOIOS_TOKEN || undefined,
    sinceUnix: Math.floor(Date.parse(SURVEYS_SINCE_ISO) / 1000),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
}
