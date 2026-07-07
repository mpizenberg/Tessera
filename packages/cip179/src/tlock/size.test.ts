/**
 * The analytic {@link sealedCiphertextSize} must equal the real
 * {@link encryptToRound} output length exactly — otherwise the on-chain preview
 * would show a wrong sealed-response byte size and fee. `encryptToRound` is pure
 * local crypto (no network), so we can seal real plaintexts here and compare.
 *
 * Covers several plaintext lengths (including a 64 KiB STREAM-chunk boundary)
 * and round magnitudes (the round is a decimal string in the age header, so its
 * digit count affects the size). Any drift in the envelope math fails here.
 */

import { describe, expect, it } from "vitest";

import { encryptToRound } from "./client.js";
import { sealedCiphertextSize } from "./size.js";

describe("sealedCiphertextSize", () => {
  const cases: readonly [len: number, round: number][] = [
    [1, 1],
    [16, 19_000_000],
    [64, 12_345],
    [100, 1],
    [200, 987_654_321],
    [65_536, 42], // exact STREAM chunk boundary (1 chunk)
    [65_537, 42], // just over the boundary (2 chunks)
  ];

  for (const [len, round] of cases) {
    it(`matches encryptToRound for len=${len}, round=${round}`, async () => {
      const real = await encryptToRound(new Uint8Array(len), round);
      expect(sealedCiphertextSize(len, round)).toBe(real.length);
    });
  }
});
