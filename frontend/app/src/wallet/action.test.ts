import { describe, expect, test } from "vitest";

import {
  Role,
  SPEC_VERSION,
  type Cip179Payload,
  type Credential,
  type SurveyDefinition,
  type SurveyResponse,
} from "cip-179";
import { hexToBytes } from "cip-179/domain";

import {
  decodeAction,
  encodeAction,
  payloadActions,
  type Action,
} from "./action";

const TX_A = "aa".repeat(32);
const owner: Credential = { type: "key", keyHash: new Uint8Array(28).fill(1) };
const script: Credential = {
  type: "script",
  scriptHash: new Uint8Array(28).fill(9),
};

const definition: SurveyDefinition = {
  specVersion: SPEC_VERSION,
  owner,
  title: "Which way?",
  description: "",
  eligibleRoles: [Role.Stakeholder],
  endEpoch: 42,
  submissionMode: { type: "public" },
  questions: [],
};

const response: SurveyResponse = {
  specVersion: SPEC_VERSION,
  surveyRef: { txId: hexToBytes(TX_A), index: 0 },
  role: Role.Stakeholder,
  credential: owner,
  answers: {
    type: "public",
    answers: [{ type: "singleChoice", questionIndex: 0, optionIndex: 1 }],
  },
};

/** Storage is JSON: what survives is what `JSON.parse(JSON.stringify(…))` gives. */
const roundTrip = (action: Action): Action | null =>
  decodeAction(JSON.parse(JSON.stringify(encodeAction(action))));

describe("the durable form of an action", () => {
  test("a definition comes back whole, with its label and credentials", () => {
    const action: Action = {
      kind: "survey",
      definition,
      proveCredentials: [owner, script],
      title: "Which way?",
    };
    expect(roundTrip(action)).toEqual(action);
  });

  test("a response comes back whole", () => {
    const action: Action = {
      kind: "response",
      response,
      proveCredentials: [owner],
    };
    expect(roundTrip(action)).toEqual(action);
  });

  test("a cancellation comes back whole", () => {
    const action: Action = {
      kind: "cancel",
      cancellation: { txId: hexToBytes(TX_A), index: 2 },
      proveCredentials: [owner],
    };
    expect(roundTrip(action)).toEqual(action);
  });

  test("a governance proposal keeps its anchor and the survey it advertises", () => {
    const action: Action = {
      kind: "govAction",
      anchorUrl: "ipfs://doc",
      anchorDataHash: new Uint8Array(32).fill(7),
      surveyKey: `${TX_A}:0`,
      proveCredentials: [],
      title: "Which way?",
    };
    expect(roundTrip(action)).toEqual(action);
  });

  test("a payload that no longer decodes is dropped, not half-read", () => {
    expect(
      decodeAction({ kind: "survey", proveCredentials: [], payload: {} }),
    ).toBe(null);
    expect(decodeAction("not an action")).toBe(null);
  });

  test("a stored kind that disagrees with its payload is dropped", () => {
    const stored = encodeAction({
      kind: "survey",
      definition,
      proveCredentials: [],
    }) as Record<string, unknown>;
    expect(decodeAction({ ...stored, kind: "response" })).toBe(null);
  });

  test("a malformed credential takes the whole action with it", () => {
    const stored = encodeAction({
      kind: "survey",
      definition,
      proveCredentials: [],
    }) as Record<string, unknown>;
    expect(decodeAction({ ...stored, proveCredentials: ["nonsense"] })).toBe(
      null,
    );
  });
});

describe("payloadActions", () => {
  test("a payload comes apart into the actions it publishes", () => {
    const payload: Cip179Payload = {
      type: "responses",
      responses: [response, response],
    };
    expect(payloadActions(payload, [owner])).toEqual([
      { kind: "response", response, proveCredentials: [owner] },
      { kind: "response", response, proveCredentials: [owner] },
    ]);
  });
});
