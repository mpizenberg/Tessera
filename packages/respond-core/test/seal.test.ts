/**
 * The lazy sealed wrapper produces a ciphertext of the analytically-expected
 * size. Timelock encryption needs no network (pure local crypto), so this runs
 * fully offline.
 *
 * Oracle: `sealedCiphertextSize(plaintextLen, round)` from `cip-179/tlock` — the
 * same size math the app's on-chain preview uses, already pinned against the
 * real encryptor by cip-179's `size.test.ts`. The sealed plaintext is the CBOR
 * of the encoded answers, zero-padded to at least `paddingSize`, so we predict
 * the size from that and assert `sealResponse` produced exactly it. A wrong
 * codec, round, or padding would fail here; full round-trip correctness of
 * `sealAnswers` itself is cip-179's `seal.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { encodeAnswerItem, type AnswerItem } from "cip-179";
import { evolutionCodec } from "cip-179/evolution";
import { sealedCiphertextSize } from "cip-179/tlock";

import { sealResponse } from "../src/index.js";

const ROUND = 1_000_000;

const ANSWERS: AnswerItem[] = [
  { type: "singleChoice", questionIndex: 0, optionIndex: 2 },
  { type: "multiSelect", questionIndex: 1, optionIndices: [0, 3] },
  { type: "numeric", questionIndex: 2, value: 42n },
];

/** The unpadded CBOR length of the answers — the plaintext before padding. */
const cborLen = evolutionCodec.metadatumToCbor(
  ANSWERS.map(encodeAnswerItem),
).length;

describe("sealResponse", () => {
  it("produces a ciphertext of the size the oracle predicts (no padding)", async () => {
    const ciphertext = await sealResponse(ANSWERS, ROUND, 0);
    expect(ciphertext.length).toBe(sealedCiphertextSize(cborLen, ROUND));
  });

  it("pads the plaintext to paddingSize when it dominates", async () => {
    const paddingSize = cborLen + 256;
    const ciphertext = await sealResponse(ANSWERS, ROUND, paddingSize);
    expect(ciphertext.length).toBe(sealedCiphertextSize(paddingSize, ROUND));
    // Padding really grew the ciphertext beyond the unpadded seal.
    expect(ciphertext.length).toBeGreaterThan(
      sealedCiphertextSize(cborLen, ROUND),
    );
  });

  it("ignores a paddingSize smaller than the CBOR (no truncation)", async () => {
    const ciphertext = await sealResponse(ANSWERS, ROUND, 1);
    expect(ciphertext.length).toBe(sealedCiphertextSize(cborLen, ROUND));
  });

  it("is size-deterministic but ciphertext-randomized across seals", async () => {
    const a = await sealResponse(ANSWERS, ROUND, 0);
    const b = await sealResponse(ANSWERS, ROUND, 0);
    // Same predicted length…
    expect(a.length).toBe(b.length);
    // …but a fresh ephemeral key each time, so the bytes differ.
    expect([...a]).not.toEqual([...b]);
  });
});
