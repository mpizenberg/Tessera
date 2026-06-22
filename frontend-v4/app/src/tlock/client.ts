/**
 * The tlock seam: drand timelock encryption, isolated behind a lazy import.
 *
 * Wraps the vendored `vendor/tlock.js` bundle (a self-contained ESM build of a
 * tlock-js fork, ~240 KB, with its own buffer/noble polyfills) — the same code
 * the Elm reference app shipped, so ciphertexts interoperate. The dynamic
 * import code-splits it into its own chunk, fetched only when a sealed survey is
 * actually encrypted or revealed, never on first paint. The bundle works in hex
 * strings and targets drand **quicknet** (no chain parameter); we convert at the
 * byte boundary.
 *
 * `fetchBeacon` is the only networked call (drand HTTP API); `encrypt` and
 * `decrypt` are local crypto.
 */

import { bytesToHex, hexToBytes } from "~/util/hex";

type TlockBundle = typeof import("./vendor/tlock.js");

let bundle: Promise<TlockBundle> | null = null;

function load(): Promise<TlockBundle> {
  if (!bundle) bundle = import("./vendor/tlock.js");
  return bundle;
}

/** Timelock-encrypt plaintext bytes to a drand round → ciphertext bytes. */
export async function encryptToRound(
  plaintext: Uint8Array,
  round: number,
): Promise<Uint8Array> {
  const tlock = await load();
  const { ciphertextHex } = await tlock.encrypt({
    plaintextHex: bytesToHex(plaintext),
    round,
  });
  return hexToBytes(ciphertextHex);
}

/**
 * Fetch (and verify) the drand beacon for a round. Throws if the round has not
 * published yet. The returned JSON is reused to decrypt every response, so this
 * networked call runs once per reveal.
 */
export async function fetchBeacon(round: number): Promise<string> {
  const tlock = await load();
  const { beaconJson } = await tlock.fetchRound({ round });
  return beaconJson;
}

/** Decrypt ciphertext bytes with a previously fetched beacon → plaintext bytes. */
export async function decryptWithBeacon(
  ciphertext: Uint8Array,
  beaconJson: string,
): Promise<Uint8Array> {
  const tlock = await load();
  const { plaintextHex } = await tlock.decrypt({
    ciphertextHex: bytesToHex(ciphertext),
    beaconJson,
  });
  return hexToBytes(plaintextHex);
}
