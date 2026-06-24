/**
 * The tlock seam: drand timelock encryption, isolated behind a lazy import.
 *
 * Wraps `@mattpiz/tlock-js` (our fork's state-free `createTlock` API). The
 * dynamic import code-splits the library — and its noble/buffer deps — into its
 * own chunk, fetched only when a sealed survey is actually encrypted or
 * revealed, never on first paint.
 *
 * We hold a single `createTlock()` instance, bound to drand **quicknet** by
 * default. It keeps no global state and never fetches the chain `/info`
 * endpoint (the parameters are baked in), so `encryptToRound` and
 * `decryptWithBeacon` are pure local crypto over bytes; `fetchBeacon` is the
 * only networked call.
 *
 * `fetchBeacon` cryptographically verifies the beacon's BLS signature against
 * the requested round before returning, so a wrong-round/forged response (a
 * caching proxy, an off-by-one, a hostile endpoint) is rejected. Confidentiality
 * doesn't rest on that check: timelock decryption uses the signature as the
 * round's IBE key, so a forged signature only yields undecodable garbage
 * (counted as a decrypt failure), never a chosen plaintext.
 */

import type { RandomnessBeacon, Tlock } from "@mattpiz/tlock-js";

export type { RandomnessBeacon };

let instance: Promise<Tlock> | null = null;

function tlock(): Promise<Tlock> {
  if (!instance) {
    instance = import("@mattpiz/tlock-js").then((m) => m.createTlock());
  }
  return instance;
}

/** Timelock-encrypt plaintext bytes to a drand round → ciphertext bytes. Offline. */
export async function encryptToRound(
  plaintext: Uint8Array,
  round: number,
): Promise<Uint8Array> {
  return (await tlock()).encryptToRound(plaintext, round);
}

/**
 * Fetch + cryptographically verify the drand beacon for a round (the only
 * networked call here). Throws if the round hasn't published yet or the beacon
 * fails verification. The returned beacon is reused to decrypt every response,
 * so this runs once per reveal.
 */
export async function fetchBeacon(round: number): Promise<RandomnessBeacon> {
  return (await tlock()).fetchBeacon(round);
}

/** Decrypt ciphertext bytes with a previously fetched beacon → plaintext bytes. Offline. */
export async function decryptWithBeacon(
  ciphertext: Uint8Array,
  beacon: RandomnessBeacon,
): Promise<Uint8Array> {
  return (await tlock()).decryptWithBeacon(ciphertext, beacon);
}
