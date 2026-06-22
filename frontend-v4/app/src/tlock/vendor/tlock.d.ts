/**
 * Types for the vendored `tlock.js` bundle (a pre-built ESM build of a tlock-js
 * fork). The bundle ships no types; this declares the three functions we use so
 * the rest of the app stays type-safe. The `.js` itself is never type-checked —
 * `allowJs` is off, so TypeScript reads these declarations and treats the bundle
 * as an opaque runtime module.
 */

export function encrypt(args: {
  plaintextHex: string;
  round: number;
}): Promise<{ ciphertextHex: string }>;

export function fetchRound(args: {
  round: number;
}): Promise<{ beaconJson: string }>;

export function decrypt(args: {
  ciphertextHex: string;
  beaconJson: string;
}): Promise<{ plaintextHex: string }>;
