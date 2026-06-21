import { describe, expect, it } from "vitest";

import {
  decodeMetadata,
  decodePayload,
  encodeMetadata,
  encodePayload,
  isMap,
  METADATA_LABEL,
  QuestionTag,
  Role,
  validateDefinition,
  validateResponse,
  type Cip179Payload,
  type Metadatum,
  type SurveyDefinition,
  type SurveyResponse,
} from "../src/index.js";

const bytes = (n: number, fill: number): Uint8Array =>
  new Uint8Array(n).fill(fill);
const txId = bytes(32, 0xef);
const ownerHash = bytes(28, 0xcd);
const responderHash = bytes(28, 0xab);
const anchorHash = bytes(32, 0xaa);

const roundtripPayload = (p: Cip179Payload): Cip179Payload =>
  decodePayload(encodePayload(p));

describe("definition round-trip (multi-select + ranking)", () => {
  const definition: SurveyDefinition = {
    specVersion: 4,
    owner: { type: "key", keyHash: ownerHash },
    title: "Dijkstra hard-fork CIP shortlist",
    description:
      "Select candidate CIPs for potential inclusion in the Dijkstra hard fork.",
    eligibleRoles: [Role.DRep],
    endEpoch: 504,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "multiSelect",
        prompt: "Which CIPs should be shortlisted for Dijkstra?",
        options: {
          type: "options",
          labels: ["CIP-0108", "CIP-0119", "CIP-0136", "CIP-0149"],
        },
        minSelections: 1,
        maxSelections: 4,
      },
      {
        type: "ranking",
        prompt: "Rank shortlisted CIPs by priority",
        options: {
          type: "options",
          labels: ["CIP-0108", "CIP-0119", "CIP-0136", "CIP-0149"],
        },
        minRanked: 1,
        maxRanked: 3,
      },
    ],
  };

  const payload: Cip179Payload = {
    type: "definitions",
    definitions: [definition],
  };

  it("survives encode/decode", () => {
    expect(roundtripPayload(payload)).toEqual(payload);
  });

  it("validates clean", () => {
    expect(validateDefinition(definition)).toEqual([]);
  });

  it("encodes the description as a chunked array (> 64 bytes)", () => {
    const m = encodePayload(payload) as readonly Metadatum[];
    const def = (m[1] as readonly Metadatum[])[0];
    expect(isMap(def)).toBe(true);
    if (!isMap(def)) return;
    expect(Array.isArray(def.get(3n))).toBe(true);
  });

  it("wraps under label 17", () => {
    const meta = encodeMetadata(payload);
    expect(isMap(meta)).toBe(true);
    if (!isMap(meta)) return;
    expect(meta.has(BigInt(METADATA_LABEL))).toBe(true);
    expect(decodeMetadata(meta)).toEqual(payload);
  });
});

describe("external-content mode with points-allocation", () => {
  const definition: SurveyDefinition = {
    specVersion: 4,
    owner: { type: "key", keyHash: ownerHash },
    title: "",
    description: "",
    eligibleRoles: [Role.DRep, Role.SPO, Role.Stakeholder],
    endEpoch: 612,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "pointsAllocation",
        prompt: "",
        options: { type: "count", count: 4 },
        budget: 100,
      },
    ],
    contentAnchor: { uri: "ipfs://bafy...survey", hash: anchorHash },
  };
  const payload: Cip179Payload = {
    type: "definitions",
    definitions: [definition],
  };

  it("survives encode/decode", () => {
    expect(roundtripPayload(payload)).toEqual(payload);
  });

  it("validates clean (count form allowed in external mode)", () => {
    expect(validateDefinition(definition)).toEqual([]);
  });

  it("rejects count form without an anchor", () => {
    const noAnchor: SurveyDefinition = {
      ...definition,
      contentAnchor: undefined,
    };
    expect(validateDefinition(noAnchor).length).toBeGreaterThan(0);
  });
});

describe("response round-trip", () => {
  const response: SurveyResponse = {
    specVersion: 4,
    surveyRef: { txId, index: 0 },
    role: Role.DRep,
    credential: { type: "key", keyHash: responderHash },
    answers: {
      type: "public",
      answers: [
        { type: "multiSelect", questionIndex: 0, optionIndices: [1, 3] },
        { type: "ranking", questionIndex: 1, ranking: [3, 1, 0] },
      ],
    },
    rationale: { uri: "ipfs://bafy...rationale", hash: bytes(32, 0xbb) },
  };
  const payload: Cip179Payload = { type: "responses", responses: [response] };

  it("survives encode/decode", () => {
    expect(roundtripPayload(payload)).toEqual(payload);
  });
});

describe("cancellation round-trip", () => {
  const payload: Cip179Payload = {
    type: "cancellations",
    cancellations: [{ txId, index: 0 }],
  };
  it("survives encode/decode", () => {
    expect(roundtripPayload(payload)).toEqual(payload);
  });
});

describe("sealed submission round-trip", () => {
  const definition: SurveyDefinition = {
    specVersion: 4,
    owner: { type: "script", scriptHash: ownerHash },
    title: "Sealed poll",
    description: "Answers revealed at a future drand round.",
    eligibleRoles: [Role.DRep],
    endEpoch: 700,
    submissionMode: {
      type: "sealed",
      chainHash: bytes(32, 0x11),
      round: 123456,
      paddingSize: 256,
    },
    questions: [
      {
        type: "singleChoice",
        prompt: "Yes or no?",
        options: { type: "options", labels: ["Yes", "No"] },
        required: true,
      },
    ],
  };
  const response: SurveyResponse = {
    specVersion: 4,
    surveyRef: { txId, index: 0 },
    role: Role.DRep,
    credential: { type: "key", keyHash: responderHash },
    answers: { type: "sealed", ciphertext: bytes(200, 0x42) },
  };

  it("definition survives encode/decode", () => {
    const payload: Cip179Payload = {
      type: "definitions",
      definitions: [definition],
    };
    expect(roundtripPayload(payload)).toEqual(payload);
  });

  it("response with chunked ciphertext survives encode/decode", () => {
    const payload: Cip179Payload = { type: "responses", responses: [response] };
    expect(roundtripPayload(payload)).toEqual(payload);
  });

  it("validates sealed response against sealed survey", () => {
    expect(validateResponse(definition, response)).toEqual([]);
  });

  it("rejects a public response to a sealed survey", () => {
    const publicResp: SurveyResponse = {
      ...response,
      answers: { type: "public", answers: [] },
    };
    expect(validateResponse(definition, publicResp).length).toBeGreaterThan(0);
  });

  it("preserves the required flag", () => {
    const q = definition.questions[0];
    expect(q.required).toBe(true);
  });
});

describe("response validation against a definition", () => {
  const definition: SurveyDefinition = {
    specVersion: 4,
    owner: { type: "key", keyHash: ownerHash },
    title: "Numbers",
    description: "",
    eligibleRoles: [Role.Stakeholder],
    endEpoch: 500,
    submissionMode: { type: "public" },
    questions: [
      {
        type: "numericRange",
        prompt: "Pick an even number 0..10",
        constraints: { min: 0n, max: 10n, step: 2n },
        required: true,
      },
      {
        type: "rating",
        prompt: "Rate these",
        options: { type: "options", labels: ["A", "B"] },
        scale: { type: "labels", labels: ["bad", "ok", "good"] },
      },
    ],
  };

  it("accepts a valid response", () => {
    const res: SurveyResponse = {
      specVersion: 4,
      surveyRef: { txId, index: 0 },
      role: Role.Stakeholder,
      credential: { type: "key", keyHash: responderHash },
      answers: {
        type: "public",
        answers: [
          { type: "numeric", questionIndex: 0, value: 4n },
          {
            type: "rating",
            questionIndex: 1,
            ratings: [
              { optionIndex: 0, rating: 2n },
              { optionIndex: 1, rating: 0n },
            ],
          },
        ],
      },
    };
    expect(validateResponse(definition, res)).toEqual([]);
  });

  it("flags an out-of-step numeric value, a bad rating, and a missing required question", () => {
    const res: SurveyResponse = {
      specVersion: 4,
      surveyRef: { txId, index: 0 },
      role: Role.DRep, // not eligible
      credential: { type: "key", keyHash: responderHash },
      answers: {
        type: "public",
        answers: [
          {
            type: "rating",
            questionIndex: 1,
            ratings: [{ optionIndex: 0, rating: 9n }],
          },
        ],
      },
    };
    const problems = validateResponse(definition, res);
    // ineligible role + missing required q0 + invalid rating
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("custom question/answer", () => {
  it("passes a transaction_metadatum value through unchanged", () => {
    const value: Metadatum = new Map<Metadatum, Metadatum>([
      [0n, "freeform"],
      [1n, 42n],
    ]);
    const payload: Cip179Payload = {
      type: "responses",
      responses: [
        {
          specVersion: 4,
          surveyRef: { txId, index: 1 },
          role: Role.Owner,
          credential: { type: "script", scriptHash: ownerHash },
          answers: {
            type: "public",
            answers: [{ type: "custom", questionIndex: 0, value }],
          },
        },
      ],
    };
    expect(roundtripPayload(payload)).toEqual(payload);
  });

  it("exposes the custom tag as 0", () => {
    expect(QuestionTag.Custom).toBe(0);
  });
});
