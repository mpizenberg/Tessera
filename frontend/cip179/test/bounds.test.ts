import { describe, expect, it } from "vitest";

import {
  Cip179DecodeError,
  Cip179EncodeError,
  decodeAnswerItem,
  decodeCredential,
  decodeSubmissionMode,
  decodeSurveyRef,
  decodeSurveyResponse,
  encodePayload,
  Role,
  validateDefinition,
  type Cip179Payload,
  type Metadatum,
  type SurveyDefinition,
} from "../src/index.js";

const bytes = (n: number, fill = 0): Uint8Array => new Uint8Array(n).fill(fill);

// Finding 6 — byte-length checks on hashes/tx ids, and the survey_ref index bound.
describe("byte-length and index bounds (finding 6)", () => {
  it("rejects a credential hash that is not 28 bytes", () => {
    expect(() => decodeCredential([0n, bytes(20)])).toThrow(Cip179DecodeError);
    expect(() => decodeCredential([1n, bytes(32)])).toThrow(Cip179DecodeError);
    expect(decodeCredential([0n, bytes(28)])).toEqual({
      type: "key",
      keyHash: bytes(28),
    });
  });

  it("rejects a tx_id that is not 32 bytes", () => {
    expect(() => decodeSurveyRef([bytes(31), 0n])).toThrow(Cip179DecodeError);
    expect(decodeSurveyRef([bytes(32), 5n])).toEqual({
      txId: bytes(32),
      index: 5,
    });
  });

  it("bounds survey_ref index to uint .size 2 (0..65535)", () => {
    expect(() => decodeSurveyRef([bytes(32), 65_536n])).toThrow(
      Cip179DecodeError,
    );
    expect(() => decodeSurveyRef([bytes(32), -1n])).toThrow(Cip179DecodeError);
  });
});

// Finding 24 — [0] public submission mode must not accept trailing elements.
describe("public submission mode arity (finding 24)", () => {
  it("rejects trailing elements after tag 0", () => {
    expect(() => decodeSubmissionMode([0n, 99n])).toThrow(Cip179DecodeError);
    expect(decodeSubmissionMode([0n])).toEqual({ type: "public" });
  });
});

// Finding 13 — CDDL [+ …] lists must be non-empty.
describe("non-empty answer lists (finding 13)", () => {
  it("rejects a response with an empty public answer array", () => {
    const resp = new Map<Metadatum, Metadatum>([
      [0n, 4n], // specVersion
      [1n, [bytes(32), 0n]], // surveyRef
      [2n, BigInt(Role.DRep)], // role
      [3n, [0n, bytes(28)]], // credential
      [4n, []], // answers — empty public array (CDDL [+ answer_item])
    ]);
    expect(() => decodeSurveyResponse(resp)).toThrow(Cip179DecodeError);
  });

  it("rejects empty points/rating pair lists", () => {
    expect(() => decodeAnswerItem([5n, 0n, []])).toThrow(Cip179DecodeError);
    expect(() => decodeAnswerItem([6n, 0n, []])).toThrow(Cip179DecodeError);
  });
});

// Finding 7 — points decode through the safe-integer-checked path.
describe("points allocation safe-integer decode (finding 7)", () => {
  it("rejects points above the safe integer range instead of rounding", () => {
    expect(() => decodeAnswerItem([5n, 0n, [[0n, 2n ** 60n]]])).toThrow(
      Cip179DecodeError,
    );
    expect(decodeAnswerItem([5n, 0n, [[0n, 100n]]])).toEqual({
      type: "pointsAllocation",
      questionIndex: 0,
      allocations: [{ optionIndex: 0, points: 100 }],
    });
  });
});

// Finding 8 — option / scale labels are bounded_text (≤64 UTF-8 bytes).
describe("bounded_text label limit (finding 8)", () => {
  const withLabel = (label: string): SurveyDefinition => ({
    specVersion: 4,
    owner: { type: "key", keyHash: bytes(28, 1) },
    title: "",
    description: "",
    eligibleRoles: [Role.DRep],
    endEpoch: 1,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "singleChoice",
        prompt: "",
        options: { type: "options", labels: ["ok", label] },
      },
    ],
  });

  it("encode throws on an over-long option label", () => {
    const payload: Cip179Payload = {
      type: "definitions",
      definitions: [withLabel("x".repeat(65))],
    };
    expect(() => encodePayload(payload)).toThrow(Cip179EncodeError);
  });

  it("validateDefinition flags an over-long label; a 64-byte one is fine", () => {
    expect(
      validateDefinition(withLabel("x".repeat(65))).length,
    ).toBeGreaterThan(0);
    expect(validateDefinition(withLabel("x".repeat(64)))).toEqual([]);
  });

  it("counts UTF-8 bytes, not code points (multi-byte label)", () => {
    // 33 × "é" (2 bytes each) = 66 UTF-8 bytes > 64, though only 33 chars.
    expect(
      validateDefinition(withLabel("é".repeat(33))).length,
    ).toBeGreaterThan(0);
  });
});
