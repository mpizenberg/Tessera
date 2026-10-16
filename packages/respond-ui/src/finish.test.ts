import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { Role, SPEC_VERSION, type SurveyDefinition } from "cip-179";
import type { Responder } from "cardano-tessera-respond-core";

import { createFinish, type Finish } from "./finish";
import { createResponseDraft, type ResponseDraft } from "./response-draft";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

const choice = (required: boolean) =>
  ({
    type: "singleChoice",
    prompt: "pick one",
    required,
    options: { type: "options", labels: ["a", "b"] },
  }) as const;

const definition: SurveyDefinition = {
  specVersion: SPEC_VERSION,
  owner: { type: "key", keyHash: new Uint8Array(28) },
  title: "t",
  description: "d",
  eligibleRoles: [Role.DRep],
  endEpoch: 500,
  submissionMode: { type: "public" },
  questions: [choice(false), choice(true), choice(false)],
};

const responder: Responder = {
  [Role.DRep]: { type: "key", keyHash: new Uint8Array(28).fill(3) },
};

const pick = (optionIndex: number) =>
  ({ type: "singleChoice", optionIndex }) as const;

/** The spine and its Finish, with the steps and submits it made. */
function setup(): {
  draft: ResponseDraft;
  finish: Finish;
  steps: number[];
  submits: string[];
} {
  const steps: number[] = [];
  const submits: string[] = [];
  return createRoot((dispose) => {
    disposers.push(dispose);
    const draft = createResponseDraft({
      definition: () => definition,
      surveyRef: () => ({ txId: new Uint8Array(32), index: 0 }),
      responder: () => responder,
      priorResponses: () => [],
      preferredRole: () => null,
    });
    const finish = createFinish(draft, (i) => steps.push(i));
    return { draft, finish, steps, submits };
  });
}

describe("createFinish", () => {
  it("goes to the first required question, submitting nothing", () => {
    const { draft, finish, steps, submits } = setup();
    draft.markSeen(0);
    finish.finish(() => submits.push("sign"));
    expect(steps).toEqual([1]);
    expect(submits).toEqual([]);
    expect(finish.asking()).toBeUndefined();
  });

  it("asks for an answer when there is none to send", () => {
    const { draft, finish, submits } = setup();
    draft.setSkipped(0, true);
    draft.setSkipped(2, true);
    draft.setSkipped(1, true);
    finish.finish(() => submits.push("sign"));
    expect(finish.asking()).toBe("answerOne");
    expect(submits).toEqual([]);
  });

  it("asks before skipping the questions seen and left, then submits as pressed", () => {
    const { draft, finish, steps, submits } = setup();
    draft.setValue(1, pick(0));
    finish.finish(() => submits.push("queue"));
    expect(steps).toEqual([0]);
    draft.markSeen(0);
    draft.markSeen(2);
    finish.finish(() => submits.push("queue"));
    expect(finish.asking()).toBe("skip");

    // An edit closes it.
    draft.setValue(1, pick(1));
    expect(finish.asking()).toBeUndefined();

    finish.finish(() => submits.push("queue"));
    finish.skipAndFinish();
    expect(submits).toEqual(["queue"]);
    expect(draft.drafts.map((d) => d.skipped)).toEqual([true, false, true]);
    expect(finish.asking()).toBeUndefined();
  });

  it("submits at once with nothing left", () => {
    const { draft, finish, submits } = setup();
    draft.setValue(0, pick(0));
    draft.setValue(1, pick(0));
    draft.setSkipped(2, true);
    finish.finish(() => submits.push("sign"));
    expect(submits).toEqual(["sign"]);
  });
});
