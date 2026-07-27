import { describe, expect, it } from "vitest";

import {
  Cip179DecodeError,
  Cip179EncodeError,
  decodeAnswerItem,
  decodeChunkedText,
  decodeCredential,
  decodePayload,
  decodePayloadItems,
  decodeSubmissionMode,
  decodeSurveyDefinition,
  decodeSurveyRef,
  decodeSurveyResponse,
  encodeContentAnchor,
  encodeCredential,
  encodePayload,
  encodeSubmissionMode,
  encodeSurveyRef,
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
      [0n, 5n], // specVersion
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
    specVersion: 5,
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

// Finding 35 — encoders fail early on the same CDDL size/bounds the decoder
// enforces, so a wrong-size hash or negative epoch never reaches a fee-paying
// submission (where every conformant reader, including our own, would reject it).
describe("encoder CDDL bounds (finding 35)", () => {
  it("rejects a credential hash that is not 28 bytes", () => {
    expect(() => encodeCredential({ type: "key", keyHash: bytes(27) })).toThrow(
      Cip179EncodeError,
    );
    expect(() =>
      encodeCredential({ type: "script", scriptHash: bytes(32) }),
    ).toThrow(Cip179EncodeError);
    expect(encodeCredential({ type: "key", keyHash: bytes(28) })).toEqual([
      0n,
      bytes(28),
    ]);
  });

  it("rejects a tx_id ≠ 32 bytes and an index past uint .size 2", () => {
    expect(() => encodeSurveyRef({ txId: bytes(31), index: 0 })).toThrow(
      Cip179EncodeError,
    );
    expect(() => encodeSurveyRef({ txId: bytes(32), index: 65_536 })).toThrow(
      Cip179EncodeError,
    );
    expect(() => encodeSurveyRef({ txId: bytes(32), index: -1 })).toThrow(
      Cip179EncodeError,
    );
    expect(encodeSurveyRef({ txId: bytes(32), index: 5 })).toEqual([
      bytes(32),
      5n,
    ]);
  });

  it("rejects a content_anchor hash that is not 32 bytes", () => {
    expect(() =>
      encodeContentAnchor({ uri: "ipfs://x", hash: bytes(28) }),
    ).toThrow(Cip179EncodeError);
  });

  it("rejects a sealed chain_hash ≠ 32 bytes and a negative round/padding", () => {
    expect(() =>
      encodeSubmissionMode({
        type: "sealed",
        chainHash: bytes(31),
        round: 1,
        paddingSize: 64,
      }),
    ).toThrow(Cip179EncodeError);
    expect(() =>
      encodeSubmissionMode({
        type: "sealed",
        chainHash: bytes(32),
        round: -1,
        paddingSize: 64,
      }),
    ).toThrow(Cip179EncodeError);
    expect(() =>
      encodeSubmissionMode({
        type: "sealed",
        chainHash: bytes(32),
        round: 1,
        paddingSize: -1,
      }),
    ).toThrow(Cip179EncodeError);
    expect(() =>
      encodeSubmissionMode({
        type: "sealed",
        chainHash: bytes(32),
        round: 1,
        paddingSize: 64,
      }),
    ).not.toThrow();
  });

  it("rejects a negative end_epoch through encodePayload", () => {
    const def: SurveyDefinition = {
      specVersion: 5,
      owner: { type: "key", keyHash: bytes(28, 1) },
      title: "",
      description: "",
      eligibleRoles: [Role.DRep],
      endEpoch: -1,
      submissionMode: { type: "public" },
      questions: [],
    };
    expect(() =>
      encodePayload({ type: "definitions", definitions: [def] }),
    ).toThrow(Cip179EncodeError);
  });
});

// Finding 43 — chunked_text (and its chunked_bytes sibling) reject the empty
// array `[]` the CDDL `[+ …]` forbids, instead of silently joining it to "".
describe("empty chunked_text rejected (finding 43)", () => {
  it("decodeChunkedText throws on []", () => {
    expect(() => decodeChunkedText([])).toThrow();
  });

  it("a definition whose title is [] fails to decode with a Cip179DecodeError", () => {
    const def = new Map<Metadatum, Metadatum>([
      [0n, 5n], // specVersion
      [1n, [0n, bytes(28)]], // owner
      [2n, []], // title — empty chunked_text array (CDDL forbids)
      [3n, ""], // description
      [4n, [BigInt(Role.DRep)]], // eligibleRoles
      [5n, 10n], // endEpoch
      [6n, [0n]], // submissionMode: public
      [7n, []], // questions
    ]);
    expect(() => decodeSurveyDefinition(def)).toThrow(Cip179DecodeError);
  });
});

// Finding 44 — a malformed sealed answers array surfaces as the decoder's own
// path-carrying Cip179DecodeError, not a bare TypeError from decodeChunkedBytes.
describe("sealed-answer decode honors the error contract (finding 44)", () => {
  it("throws Cip179DecodeError on a chunked_bytes array with a non-bytes chunk", () => {
    const resp = new Map<Metadatum, Metadatum>([
      [0n, 5n], // specVersion
      [1n, [bytes(32), 0n]], // surveyRef
      [2n, BigInt(Role.DRep)], // role
      [3n, [0n, bytes(28)]], // credential
      [4n, [bytes(64), 5n]], // answers — sealed chunks, but 5 is not bytes
    ]);
    expect(() => decodeSurveyResponse(resp)).toThrow(Cip179DecodeError);
  });
});

describe("an unsupported spec_version explains its own decode failure", () => {
  // A v4 rating question omits the mandatory `require_all` flag v5 put at
  // index 4, so v5 structural decode fails somewhere inside the question.
  const definition = (specVersion: bigint): Metadatum =>
    new Map<Metadatum, Metadatum>([
      [0n, specVersion],
      [1n, [0n, bytes(28)]], // owner
      [2n, "t"], // title
      [3n, ""], // description
      [4n, [BigInt(Role.Stakeholder)]], // eligibleRoles
      [5n, 10n], // endEpoch
      [6n, [0n]], // submissionMode: public
      [7n, [[6n, "rate", 3n, 5n]]], // questions — v4 rating arity
    ]);

  it("blames the version, not whichever field happens to differ", () => {
    expect(() => decodeSurveyDefinition(definition(4n))).toThrow(
      /unsupported spec_version 4 .* \(at definition\.specVersion\)/,
    );
  });

  it("leaves a supported version's structural error untouched", () => {
    expect(() => decodeSurveyDefinition(definition(5n))).toThrow(
      /\(at definition\.questions\[0\]\)/,
    );
  });

  it("still decodes an older version whose shape happens to fit", () => {
    const v4 = definition(4n);
    (v4 as Map<Metadatum, Metadatum>).set(7n, [[1n, "pick", 2n]]);
    const decoded = decodeSurveyDefinition(v4);
    expect(decoded.specVersion).toBe(4);
    // Reporting it as untalliable beats dropping it: a reader can say why.
    expect(validateDefinition(decoded).map((p) => p.code)).toContain(
      "definition.specVersionUnsupported",
    );
  });
});

// Finding 27 — CIP-179 validates batched records independently, so one
// malformed item must not cost its siblings their place on chain.
describe("a batched payload decodes item by item (finding 27)", () => {
  const response = (roleTag: Metadatum): Metadatum =>
    new Map<Metadatum, Metadatum>([
      [0n, 5n],
      [1n, [bytes(32), 0n]],
      [2n, roleTag],
      [3n, [0n, bytes(28)]],
      [4n, [[1n, 0n, 0n]]], // one single-choice answer
    ]);
  // Role 9 is not a CIP-179 role, so item 1 fails where its siblings don't.
  const batch: Metadatum = [
    1n,
    [response(BigInt(Role.DRep)), response(9n), response(BigInt(Role.SPO))],
  ];

  it("keeps the well-formed siblings and reports the rest", () => {
    const { payload, skipped } = decodePayloadItems(batch);
    expect(payload.type).toBe("responses");
    expect(skipped.map((s) => s.index)).toEqual([1]);
    expect(skipped[0]!.error).toBeInstanceOf(Cip179DecodeError);
    if (payload.type !== "responses") throw new Error("wrong payload type");
    expect(payload.responses.map((r) => r.value.role)).toEqual([
      Role.DRep,
      Role.SPO,
    ]);
  });

  it("indexes survivors by array position, not by list position", () => {
    const { payload } = decodePayloadItems(batch);
    if (payload.type !== "responses") throw new Error("wrong payload type");
    // The survivor after the gap keeps index 2 — it is its response_index, part
    // of the dedup chain order and of the artifact's on-chain coordinate.
    expect(payload.responses.map((r) => r.index)).toEqual([0, 2]);
  });

  it("still fails whole for an unreadable envelope", () => {
    expect(() => decodePayloadItems([9n, [response(0n)]])).toThrow(
      Cip179DecodeError,
    );
    expect(() => decodePayloadItems([1n, []])).toThrow(Cip179DecodeError);
    expect(() => decodePayloadItems(5n)).toThrow(Cip179DecodeError);
  });

  it("leaves the strict decoder strict", () => {
    expect(() => decodePayload(batch)).toThrow(Cip179DecodeError);
    expect(decodePayload([1n, [response(BigInt(Role.DRep))]])).toEqual({
      type: "responses",
      responses: [expect.objectContaining({ role: Role.DRep })],
    });
  });
});
