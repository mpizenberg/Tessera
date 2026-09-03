/**
 * Portable endpoints and the read configuration, shared by the browser app and
 * the serving tier. Only the *values* live here; how each runtime *resolves*
 * them (localStorage + Vite env in the app, `process.env` in the backend) stays
 * in that runtime. The networks themselves, and their epoch calendars, are
 * `cardano-tessera-client`'s.
 */

import type { Network } from "cardano-tessera-client";

export interface AppConfig {
  readonly network: Network;
  /** Koios REST base URL for the active network. */
  readonly koiosUrl: string;
  /**
   * Koios bearer token, or undefined. In the browser an authenticated token is
   * required (the anonymous tier sends no CORS headers); server-side `fetch` is
   * not CORS-bound, so the serving tier may run tokenless on the anonymous tier.
   */
  readonly koiosToken: string | undefined;
  /**
   * Only index CIP-179 transactions at or after this unix time. Anchored on a
   * wall-clock date (not an epoch number) so it works across networks.
   */
  readonly sinceUnix: number;
  /**
   * Epoch length in seconds for the active network (mainnet/preprod 5 days,
   * preview 1 day). Used to estimate the wall-clock reveal time of a future end
   * epoch.
   */
  readonly secondsPerEpoch: number;
}

/** Koios REST base URL per network. */
export const KOIOS_URL: Record<Network, string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1",
};
