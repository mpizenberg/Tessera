/**
 * Hermetic (offline) seal → reveal round-trip for sealed responses.
 *
 * `sealAnswers` needs no network (timelock encryption is pure local crypto), and
 * `revealWithBeacon` takes an already-fetched beacon — so with a committed real
 * quicknet beacon (`quicknet-beacon-1000000.json`, immutable + BLS-verifiable)
 * the whole encrypt→decrypt→decode path runs with zero I/O. We seal to the same
 * round the fixture beacon is for, then reveal with it and assert the answers
 * come back byte-identical; we also check that the zero padding is dropped
 * (CBOR is self-delimiting) and that a corrupted ciphertext reveals as `null`
 * rather than sinking the batch.
 */

import { describe, expect, it } from "vitest";
import { Role, type AnswerItem, type SurveyResponse } from "../index.js";

import type { RandomnessBeacon } from "./client.js";
import { sealAnswers, revealWithBeacon } from "./seal.js";
import beaconFixture from "./quicknet-beacon-1000000.json" with { type: "json" };

const ROUND = beaconFixture.round;
const BEACON: RandomnessBeacon = {
  round: beaconFixture.round,
  randomness: beaconFixture.randomness,
  signature: beaconFixture.signature,
};

const ANSWERS: AnswerItem[] = [
  { type: "singleChoice", questionIndex: 0, optionIndex: 2 },
  { type: "multiSelect", questionIndex: 1, optionIndices: [0, 3] },
  { type: "numeric", questionIndex: 2, value: 42n },
];

function sealedResponse(ciphertext: Uint8Array): SurveyResponse {
  return {
    specVersion: 4,
    surveyRef: { txId: Uint8Array.of(9), index: 0 },
    role: Role.Stakeholder,
    credential: { type: "key", keyHash: Uint8Array.of(1, 2, 3) },
    answers: { type: "sealed", ciphertext },
  };
}

describe("sealAnswers → revealWithBeacon", () => {
  it("round-trips answers through timelock encrypt/decrypt (offline)", async () => {
    const ciphertext = await sealAnswers(ANSWERS, ROUND, 0);
    const [revealed] = await revealWithBeacon(
      [sealedResponse(ciphertext)],
      BEACON,
    );
    expect(revealed).not.toBeNull();
    expect(revealed!.answers).toEqual({ type: "public", answers: ANSWERS });
    // Credential / role / ref are preserved onto the revealed public response.
    expect(revealed!.role).toBe(Role.Stakeholder);
    expect(revealed!.credential).toEqual({
      type: "key",
      keyHash: Uint8Array.of(1, 2, 3),
    });
  });

  it("strips the zero padding when decoding (self-delimiting CBOR)", async () => {
    // A padding far larger than the answers' CBOR: the trailing zeros must be
    // ignored, not decoded as extra items.
    const ciphertext = await sealAnswers(ANSWERS, ROUND, 512);
    expect(ciphertext.length).toBeGreaterThan(0);
    const [revealed] = await revealWithBeacon(
      [sealedResponse(ciphertext)],
      BEACON,
    );
    expect(revealed!.answers).toEqual({ type: "public", answers: ANSWERS });
  });

  it("reveals a corrupted ciphertext as null (never sinks the batch)", async () => {
    const good = await sealAnswers(ANSWERS, ROUND, 0);
    const corrupted = new Uint8Array(good);
    corrupted[corrupted.length - 1] ^= 0xff; // flip a payload byte
    const [a, b] = await revealWithBeacon(
      [sealedResponse(corrupted), sealedResponse(good)],
      BEACON,
    );
    expect(a).toBeNull();
    expect(b!.answers).toEqual({ type: "public", answers: ANSWERS });
  });

  it("passes a non-sealed response through unchanged", async () => {
    const pub: SurveyResponse = {
      ...sealedResponse(new Uint8Array()),
      answers: { type: "public", answers: ANSWERS },
    };
    const [revealed] = await revealWithBeacon([pub], BEACON);
    expect(revealed).toBe(pub);
  });
});
