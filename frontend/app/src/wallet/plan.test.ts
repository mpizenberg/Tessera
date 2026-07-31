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

import { payloadActions, plan, type Action, type PlanContext } from "./plan";

const TX_A = "aa".repeat(32);
const TX_B = "bb".repeat(32);
const owner: Credential = { type: "key", keyHash: new Uint8Array(28).fill(1) };
const responder: Credential = {
  type: "key",
  keyHash: new Uint8Array(28).fill(2),
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

const responseTo = (surveyKey: string): SurveyResponse => {
  const [txId, index] = surveyKey.split(":");
  return {
    specVersion: SPEC_VERSION,
    surveyRef: { txId: hexToBytes(txId!), index: Number(index) },
    role: Role.Stakeholder,
    credential: responder,
    answers: { type: "public", answers: [] },
  };
};

/** Item count of a payload — what the sizing stubs below charge per item. */
function itemCount(payload: Cip179Payload): number {
  switch (payload.type) {
    case "definitions":
      return payload.definitions.length;
    case "responses":
      return payload.responses.length;
    case "cancellations":
      return payload.cancellations.length;
  }
}

/** Two items per transaction fit, three do not (`MAX_TX_BYTES` is 16384). */
const perItem =
  (bytes: number) =>
  (payload: Cip179Payload): number =>
    itemCount(payload) * bytes;

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  definingTx: new Map(),
  measure: () => 0,
  ...over,
});

const survey = (title?: string): Action => ({
  kind: "survey",
  definition,
  proveCredentials: [owner],
  ...(title !== undefined && { title }),
});
const respond = (surveyKey: string): Action => ({
  kind: "response",
  response: responseTo(surveyKey),
  proveCredentials: [responder],
});
const cancel = (surveyKey: string): Action => {
  const [txId, index] = surveyKey.split(":");
  return {
    kind: "cancel",
    cancellation: { txId: hexToBytes(txId!), index: Number(index) },
    proveCredentials: [owner],
  };
};
const propose = (surveyKey: string | undefined): Action => ({
  kind: "govAction",
  anchorUrl: "ipfs://doc",
  anchorDataHash: new Uint8Array(32),
  surveyKey,
  proveCredentials: [],
});

describe("grouping", () => {
  test("each event kind gets its own transaction, definitions first", () => {
    const txs = plan(
      [propose(undefined), cancel(`${TX_A}:0`), respond(`${TX_A}:0`), survey()],
      ctx(),
    );
    expect(
      txs.map((t) =>
        t.body.type === "metadata" ? t.body.payload.type : "proposal",
      ),
    ).toEqual(["definitions", "responses", "cancellations", "proposal"]);
  });

  test("same-kind actions ride in one transaction", () => {
    const [tx, ...rest] = plan([survey(), survey()], ctx());
    expect(rest).toEqual([]);
    expect(tx?.body.type === "metadata" && tx.body.payload).toMatchObject({
      type: "definitions",
      definitions: [definition, definition],
    });
  });

  test("governance proposals are never batched", () => {
    expect(plan([propose(undefined), propose(undefined)], ctx())).toHaveLength(
      2,
    );
  });

  test("a batch's proof credentials are the union, without repeats", () => {
    const [tx] = plan([survey(), survey(), cancel(`${TX_A}:0`)], ctx());
    expect(tx?.proveCredentials).toEqual([owner]);
  });

  test("only a lone action lends the transaction its label", () => {
    expect(plan([survey("Which way?")], ctx())[0]?.title).toBe("Which way?");
    expect(plan([survey("Which way?"), survey()], ctx())[0]?.title).toBe(
      undefined,
    );
  });
});

describe("dependency edges", () => {
  const definingTx = new Map([[`${TX_A}:0`, TX_A]]);

  test("answering a survey that is still in flight chains onto it", () => {
    const [tx] = plan([respond(`${TX_A}:0`)], ctx({ definingTx }));
    expect(tx?.dependsOn).toEqual([TX_A]);
  });

  test("answering a survey the chain already carries chains onto nothing", () => {
    const [tx] = plan([respond(`${TX_B}:0`)], ctx({ definingTx }));
    expect(tx?.dependsOn).toEqual([]);
  });

  test("cancelling and advertising chain the same way", () => {
    expect(
      plan([cancel(`${TX_A}:0`)], ctx({ definingTx }))[0]?.dependsOn,
    ).toEqual([TX_A]);
    expect(
      plan([propose(`${TX_A}:0`)], ctx({ definingTx }))[0]?.dependsOn,
    ).toEqual([TX_A]);
  });

  test("one transaction defining two surveys is depended on once", () => {
    const [tx] = plan(
      [respond(`${TX_A}:0`), respond(`${TX_A}:1`)],
      ctx({
        definingTx: new Map([
          [`${TX_A}:0`, TX_A],
          [`${TX_A}:1`, TX_A],
        ]),
      }),
    );
    expect(tx?.dependsOn).toEqual([TX_A]);
  });

  test("a definition depends on nothing — its survey is the one it creates", () => {
    const [tx] = plan([survey()], ctx({ definingTx }));
    expect(tx?.dependsOn).toEqual([]);
  });
});

describe("size splitting", () => {
  test("a batch is cut where the next item would overflow a transaction", () => {
    const txs = plan(
      [survey(), survey(), survey()],
      ctx({ measure: perItem(6000) }),
    );
    expect(
      txs.map((t) =>
        t.body.type === "metadata" && t.body.payload.type === "definitions"
          ? t.body.payload.definitions.length
          : 0,
      ),
    ).toEqual([2, 1]);
  });

  test("an action too large for any transaction still gets one", () => {
    const txs = plan([survey(), survey()], ctx({ measure: perItem(20_000) }));
    expect(txs).toHaveLength(2);
  });
});

describe("payloadActions", () => {
  test("a payload comes apart into the actions it publishes", () => {
    const payload: Cip179Payload = {
      type: "responses",
      responses: [responseTo(`${TX_A}:0`), responseTo(`${TX_B}:0`)],
    };
    const [tx, ...rest] = plan(payloadActions(payload, [responder]), ctx());
    expect(rest).toEqual([]);
    expect(tx?.body.type === "metadata" && tx.body.payload).toEqual(payload);
    expect(tx?.proveCredentials).toEqual([responder]);
  });
});
