/**
 * The sealed-reveal seam for finalization: decrypt a survey's in-window sealed
 * responses with the drand round pinned by its definition.
 *
 * Isolated behind a small function type so {@link finalizeClosedSurveys} can take
 * it as an injected dependency (R7): the default {@link tlockSealedReveal} does
 * the real thing — one BLS-verified `fetchBeacon` per survey per pass, then the
 * offline `revealWithBeacon` loop — while tests inject a stub that returns
 * decrypted answers with no network or crypto.
 *
 * `@tessera/tlock` is **lazy-imported** inside the default so a finalize pass with
 * no revealable sealed survey never pulls in the tlock/evolution bundle, and the
 * tlock-js crypto chunk loads only when a reveal actually runs.
 */

import type { ResponseRecord } from "@tessera/core";
import type { SurveyResponse } from "cip-179";

/** The drand beacon a reveal used — committed to the artifact's provenance. */
export interface RevealBeacon {
  readonly round: number;
  readonly randomness: string;
  readonly signature: string;
}

/** What a reveal produces: per-record decrypted responses (aligned by index) + the beacon. */
export interface SealedRevealResult {
  /** `revealed[i]` is the decrypted public response for `records[i]`, or null on failure. */
  readonly revealed: (SurveyResponse | null)[];
  /** The beacon used to decrypt — re-verifiable against `round`. */
  readonly beacon: RevealBeacon;
}

/**
 * Reveal a survey's in-window sealed responses. Given the records (each carrying
 * a sealed ciphertext) and the definition-pinned drand round, return the
 * per-record decrypted responses plus the beacon used. May throw (round not yet
 * published, transient fetch failure) — the finalizer catches and retries next
 * pass.
 */
export type SealedRevealFn = (
  records: readonly ResponseRecord[],
  params: { readonly round: number },
) => Promise<SealedRevealResult>;

/**
 * Default reveal: fetch (and BLS-verify) the round's beacon once, then decrypt
 * every record offline. Lazy-imports `@tessera/tlock` so the crypto stack is
 * pulled only when a sealed survey is actually revealed.
 */
export const tlockSealedReveal: SealedRevealFn = async (records, { round }) => {
  const { fetchBeacon, revealWithBeacon } = await import("@tessera/tlock");
  const beacon = await fetchBeacon(round);
  const revealed = await revealWithBeacon(
    records.map((r) => r.response),
    beacon,
  );
  return {
    revealed,
    beacon: {
      round: beacon.round,
      randomness: beacon.randomness,
      signature: beacon.signature,
    },
  };
};
