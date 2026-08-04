import { parseNetwork, type Network } from "cardano-tessera-core";

/** Read the required network identity from a backend health payload. */
export function networkFromHealth(health: unknown): Network {
  if (typeof health !== "object" || health === null || !("network" in health)) {
    throw new Error("Backend health response has no network identity");
  }
  return parseNetwork((health as { readonly network: unknown }).network);
}
