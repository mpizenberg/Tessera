import { describe, expect, it } from "vitest";

import { Cip179DecodeError, Role, type Metadatum } from "../index.js";
import type {
  CancellationRecord,
  ResponseRecord,
  SurveyRecord,
} from "../domain/records.js";
import {
  decodeCancellationRecord,
  decodeResponseRecord,
  decodeSurveyRecord,
} from "./records.js";
import { toJsonSafe } from "./wire.js";

/** What a record looks like after `toJsonSafe` and a trip through JSON. */
const wire = (record: unknown): unknown =>
  JSON.parse(JSON.stringify(toJsonSafe(record)));

const hash = (b: number, n = 32) => new Uint8Array(n).fill(b);

const survey: SurveyRecord = {
  txHash: "aa".repeat(32),
  slot: 1000,
  epochNo: 9,
  ref: { txId: hash(0xaa), index: 1 },
  definition: {
    specVersion: 5,
    owner: { type: "script", scriptHash: hash(1, 28) },
    title: "t",
    description: "d",
    eligibleRoles: [Role.DRep, Role.Stakeholder],
    endEpoch: 12,
    submissionMode: {
      type: "sealed",
      chainHash: hash(2),
      round: 31287452,
      paddingSize: 5,
    },
    contentAnchor: { uri: "ipfs://x", hash: hash(3) },
    questions: [
      {
        type: "custom",
        prompt: "c",
        methodSchema: { uri: "https://s", hash: hash(4) },
      },
      {
        type: "singleChoice",
        prompt: "s",
        required: true,
        options: { type: "options", labels: ["a", "b"] },
      },
      {
        type: "multiSelect",
        prompt: "m",
        options: { type: "count", count: 3 },
        minSelections: 0,
        maxSelections: 2,
      },
      {
        type: "ranking",
        prompt: "r",
        options: { type: "options", labels: ["a", "b", "c"] },
        minRanked: 1,
        maxRanked: 3,
      },
      {
        type: "numericRange",
        prompt: "n",
        constraints: { min: -5n, max: 5n, step: 1n },
      },
      {
        type: "pointsAllocation",
        prompt: "p",
        options: { type: "options", labels: ["a", "b"] },
        budget: 10,
      },
      {
        type: "rating",
        prompt: "g",
        options: { type: "options", labels: ["a", "b"] },
        scale: { type: "numeric", constraints: { min: 1n, max: 5n } },
        requireAll: false,
      },
      {
        type: "rating",
        prompt: "g2",
        options: { type: "options", labels: ["a"] },
        scale: { type: "labels", labels: ["bad", "good"] },
        requireAll: true,
      },
    ],
  },
  proof: {
    requiredSigners: ["01".repeat(28)],
    nativeScripts: [
      {
        scriptHash: "02".repeat(28),
        script: {
          kind: "atLeast",
          required: 1,
          scripts: [
            { kind: "sig", keyHash: "03".repeat(28) },
            { kind: "timelock" },
          ],
        },
      },
    ],
  },
};

const response: ResponseRecord = {
  txHash: "bb".repeat(32),
  slot: 1001,
  epochNo: 9,
  responseIndex: 0,
  blockIndex: 4,
  response: {
    specVersion: 5,
    surveyRef: { txId: hash(0xaa), index: 1 },
    role: Role.DRep,
    credential: { type: "key", keyHash: hash(5, 28) },
    answers: {
      type: "public",
      answers: [
        {
          questionIndex: 0,
          type: "custom",
          value: new Map<Metadatum, Metadatum>([
            [0n, "x"],
            ["k", [1n, hash(6, 2)]],
          ]),
        },
        { questionIndex: 1, type: "singleChoice", optionIndex: 1 },
        { questionIndex: 2, type: "multiSelect", optionIndices: [0, 2] },
        { questionIndex: 3, type: "ranking", ranking: [2, 0] },
        { questionIndex: 4, type: "numeric", value: -3n },
        {
          questionIndex: 5,
          type: "pointsAllocation",
          allocations: [{ optionIndex: 0, points: 10 }],
        },
        {
          questionIndex: 6,
          type: "rating",
          ratings: [{ optionIndex: 1, rating: 4n }],
        },
      ],
    },
    rationale: { uri: "ipfs://r", hash: hash(7) },
  },
};

const cancellation: CancellationRecord = {
  txHash: "cc".repeat(32),
  slot: 1002,
  epochNo: 9,
  target: { txId: hash(0xaa), index: 1 },
  proof: null,
};

/** The thrown error, with its path, or `undefined` when nothing throws. */
const errorOf = (f: () => unknown): Cip179DecodeError | undefined => {
  try {
    f();
    return undefined;
  } catch (e) {
    return e instanceof Cip179DecodeError ? e : undefined;
  }
};

describe("typed record decoders", () => {
  it("round-trips a survey record with every question shape and a proof", () => {
    expect(decodeSurveyRecord(wire(survey))).toEqual(survey);
  });

  it("round-trips a response record with every answer shape", () => {
    expect(decodeResponseRecord(wire(response))).toEqual(response);
  });

  it("round-trips a sealed response and a proof-less survey", () => {
    const sealed: ResponseRecord = {
      ...response,
      response: {
        ...response.response,
        answers: { type: "sealed", ciphertext: hash(8, 64) },
      },
    };
    expect(decodeResponseRecord(wire(sealed))).toEqual(sealed);
    const { proof: _proof, ...bare } = survey;
    const decoded = decodeSurveyRecord(wire(bare));
    expect(decoded).toEqual(bare);
    expect("proof" in decoded).toBe(false);
  });

  it("round-trips a cancellation with and without a proof", () => {
    expect(decodeCancellationRecord(wire(cancellation))).toEqual(cancellation);
    const proven = { ...cancellation, proof: survey.proof! };
    expect(decodeCancellationRecord(wire(proven))).toEqual(proven);
  });

  it("drops keys the type does not declare", () => {
    const extra = { ...(wire(survey) as object), extra: 1 };
    expect("extra" in decodeSurveyRecord(extra)).toBe(false);
  });

  it("names the path of a missing field", () => {
    const w = wire(survey) as { definition: Record<string, unknown> };
    delete w.definition.questions;
    const e = errorOf(() => decodeSurveyRecord(w));
    expect(e?.path).toBe("definition.questions");
    expect(e?.message).toContain("missing");
  });

  it("names the path of a field with the wrong shape", () => {
    const w = wire(survey) as { definition: Record<string, unknown> };
    w.definition.eligibleRoles = 3;
    expect(errorOf(() => decodeSurveyRecord(w))?.path).toBe(
      "definition.eligibleRoles",
    );
  });

  it("refuses an unknown union tag and an unknown role, deep in the tree", () => {
    const w = wire(survey) as {
      definition: { questions: Record<string, unknown>[] };
    };
    w.definition.questions[3]!.type = "essay";
    expect(errorOf(() => decodeSurveyRecord(w))?.path).toBe(
      "definition.questions[3].type",
    );
    const r = wire(response) as { response: Record<string, unknown> };
    r.response.role = 9;
    expect(errorOf(() => decodeResponseRecord(r))?.path).toBe("response.role");
  });

  it("refuses a non-metadatum custom answer value", () => {
    const r = wire(response) as {
      response: { answers: { answers: Record<string, unknown>[] } };
    };
    r.response.answers.answers[0]!.value = { plain: "object" };
    expect(errorOf(() => decodeResponseRecord(r))?.path).toBe(
      "response.answers.answers[0].value",
    );
  });

  it("still fails on bad hex the way fromJsonSafe does", () => {
    const w = wire(cancellation) as { target: { txId: unknown } };
    w.target.txId = { $bytes: "zz" };
    expect(() => decodeCancellationRecord(w)).toThrow(/invalid hex/);
  });
});
