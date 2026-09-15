import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import {
  Role,
  SPEC_VERSION,
  type Credential,
  type Question,
  type SurveyDefinition,
  type SurveyRef,
  type SurveyResponse,
} from "cip-179";
import type { Draft, Responder } from "cardano-tessera-respond-core";

import {
  createResponseDraft,
  type DraftStash,
  type ResponseDraft,
  type ResponseDraftSource,
} from "./response-draft";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/**
 * Build the hook in its own root. Solid flushes queued effects as the root
 * returns, so the first seed has already happened by the time we assert.
 */
function draftIn(source: ResponseDraftSource): ResponseDraft {
  return createRoot((dispose) => {
    disposers.push(dispose);
    return createResponseDraft(source);
  });
}

const single: Question = {
  type: "singleChoice",
  prompt: "pick one",
  required: true,
  options: { type: "options", labels: ["a", "b", "c"] },
};

const optional: Question = {
  type: "numericRange",
  prompt: "how many",
  required: false,
  constraints: { min: 0n, max: 10n },
};

const defWith = (...roles: Role[]): SurveyDefinition => ({
  specVersion: SPEC_VERSION,
  owner: { type: "key", keyHash: new Uint8Array(28) },
  title: "t",
  description: "d",
  eligibleRoles: roles,
  endEpoch: 500,
  submissionMode: { type: "public" },
  questions: [single, optional],
});

const ref = (fill: number): SurveyRef => ({
  txId: new Uint8Array(32).fill(fill),
  index: 0,
});
const cred = (fill: number): Credential => ({
  type: "key",
  keyHash: new Uint8Array(28).fill(fill),
});

const priorPick = (
  surveyRef: SurveyRef,
  role: Role,
  credential: Credential,
  optionIndex: number,
): SurveyResponse => ({
  specVersion: SPEC_VERSION,
  surveyRef,
  role,
  credential,
  answers: {
    type: "public",
    answers: [{ type: "singleChoice", questionIndex: 0, optionIndex }],
  },
});

const pick = (optionIndex: number | null) =>
  ({ type: "singleChoice", optionIndex }) as const;

/** A stash whose kept forms a test can read and plant directly. */
function mapStash(): DraftStash & { forms: Map<string, readonly Draft[]> } {
  const forms = new Map<string, readonly Draft[]>();
  return {
    forms,
    get: (formKey) => forms.get(formKey),
    set: (formKey, drafts) => void forms.set(formKey, drafts),
    delete: (formKey) => void forms.delete(formKey),
  };
}

/** Two roles, two distinct credentials — enough to switch between. */
const both: Responder = { [Role.DRep]: cred(3), [Role.Keyholder]: cred(1) };

describe("createResponseDraft", () => {
  it("seeds a pristine draft per question once the definition arrives", () => {
    const [definition, setDefinition] = createSignal<
      SurveyDefinition | undefined
    >(undefined);
    const draft = draftIn({
      definition,
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    expect(draft.drafts).toHaveLength(0);
    expect(draft.role()).toBeNull();

    setDefinition(defWith(Role.DRep, Role.Keyholder));

    expect(draft.drafts).toHaveLength(2);
    expect(draft.total()).toBe(2);
    // The numeric question seeds to an in-range value, so it counts as both
    // decided and answered from the start; the required choice does not.
    expect(draft.decidedCount()).toBe(1);
    expect(draft.answered()).toBe(true);
    expect(draft.drafts[0]?.value).toEqual(pick(null));
  });

  it("answers as the preferred role when respondable, else the first claimable", () => {
    const [preferred, setPreferred] = createSignal<Role | null>(null);
    const draft = draftIn({
      definition: () => defWith(Role.DRep, Role.Keyholder),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: preferred,
    });

    expect(draft.respondable()).toEqual([Role.DRep, Role.Keyholder]);
    expect(draft.role()).toBe(Role.DRep);

    setPreferred(Role.Keyholder);
    expect(draft.role()).toBe(Role.Keyholder);
    expect(draft.credential()).toEqual(cred(1));

    // A role this responder cannot claim here is ignored, not honored.
    setPreferred(Role.SPO);
    expect(draft.role()).toBe(Role.DRep);

    draft.pickRole(Role.Keyholder);
    expect(draft.role()).toBe(Role.Keyholder);
  });

  it("prefills from a public prior response, and skips what it omitted", () => {
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [priorPick(ref(1), Role.DRep, cred(3), 2)],
      preferredRole: () => null,
    });

    expect(draft.prior()).toBeDefined();
    expect(draft.drafts[0]).toEqual({ skipped: false, value: pick(2) });
    // Omitted by the prior response, and optional — an abstention, restored.
    expect(draft.drafts[1]?.skipped).toBe(true);
    expect(draft.decidedCount()).toBe(2);
    expect(draft.answered()).toBe(true);
  });

  it("reports a sealed prior without prefilling from it", () => {
    const sealed: SurveyResponse = {
      specVersion: SPEC_VERSION,
      surveyRef: ref(1),
      role: Role.DRep,
      credential: cred(3),
      answers: { type: "sealed", ciphertext: new Uint8Array(8) },
    };
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [sealed],
      preferredRole: () => null,
    });

    expect(draft.prior()).toBe(sealed);
    expect(draft.drafts[0]?.value).toEqual(pick(null));
  });

  it("stops reseeding once the user edits, even when the prior arrives late", () => {
    const [priors, setPriors] = createSignal<readonly SurveyResponse[]>([]);
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: priors,
      preferredRole: () => null,
    });

    draft.setValue(0, pick(1));
    setPriors([priorPick(ref(1), Role.DRep, cred(3), 2)]);

    expect(draft.prior()).toBeDefined();
    expect(draft.drafts[0]?.value).toEqual(pick(1));
  });

  it("stashes edits per role and restores them when switching back", () => {
    const draft = draftIn({
      definition: () => defWith(Role.DRep, Role.Keyholder),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    draft.setValue(0, pick(1));

    draft.pickRole(Role.Keyholder);
    expect(draft.credential()).toEqual(cred(1));
    expect(draft.drafts[0]?.value).toEqual(pick(null));

    draft.setValue(0, pick(2));
    draft.pickRole(Role.DRep);
    expect(draft.drafts[0]?.value).toEqual(pick(1));

    draft.pickRole(Role.Keyholder);
    expect(draft.drafts[0]?.value).toEqual(pick(2));
  });

  it("brings edits back when the survey returns", () => {
    const [surveyRef, setSurveyRef] = createSignal(ref(1));
    const draft = draftIn({
      definition: () => defWith(Role.DRep, Role.Keyholder),
      surveyRef,
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    draft.setValue(0, pick(1));
    setSurveyRef(ref(2));
    expect(draft.drafts[0]?.value).toEqual(pick(null));
    expect(draft.restored()).toBe(false);

    setSurveyRef(ref(1));
    expect(draft.drafts[0]?.value).toEqual(pick(1));
    expect(draft.restored()).toBe(true);
  });

  it("writes every edit to an injected stash under the form key", () => {
    const stash = mapStash();
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
      stash,
    });

    expect(stash.forms.size).toBe(0);
    draft.setValue(0, pick(2));
    draft.setSkipped(1, true);
    expect(stash.forms.get(draft.formKey())).toEqual([
      { skipped: false, value: pick(2) },
      { skipped: true, value: draft.drafts[1]?.value },
    ]);
  });

  it("restores a kept form at mount, and a late prior does not replace it", () => {
    const stash = mapStash();
    const source = {
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      preferredRole: () => null,
      stash,
    };
    draftIn({ ...source, priorResponses: () => [] }).setValue(0, pick(1));
    for (const dispose of disposers.splice(0)) dispose();

    // A new spine over the same stash, as after a reload, with the identity
    // already known on its first run.
    const [priors, setPriors] = createSignal<
      readonly SurveyResponse[] | undefined
    >(undefined);
    const draft = draftIn({ ...source, priorResponses: priors });
    expect(draft.drafts[0]?.value).toEqual(pick(1));
    expect(draft.restored()).toBe(true);

    setPriors([priorPick(ref(1), Role.DRep, cred(3), 2)]);
    expect(draft.prior()).toBeDefined();
    expect(draft.drafts[0]?.value).toEqual(pick(1));
  });

  it("falls back to the prior when the stash has no form that fits", () => {
    const stash = mapStash();
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [priorPick(ref(1), Role.DRep, cred(3), 2)],
      preferredRole: () => null,
      stash: { ...stash, get: () => undefined },
    });

    expect(draft.drafts[0]?.value).toEqual(pick(2));
    expect(draft.restored()).toBe(false);
  });

  it("discards a kept form back to the prior", () => {
    const stash = mapStash();
    const draft = draftIn({
      definition: () => defWith(Role.DRep, Role.Keyholder),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [priorPick(ref(1), Role.DRep, cred(3), 2)],
      preferredRole: () => null,
      stash,
    });
    stash.forms.set(draft.formKey(), [
      { skipped: false, value: pick(0) },
      { skipped: true, value: { type: "numeric", value: 0n } },
    ]);
    draft.pickRole(Role.Keyholder);
    draft.pickRole(Role.DRep);
    expect(draft.drafts[0]?.value).toEqual(pick(0));
    expect(draft.restored()).toBe(true);

    draft.discard();
    expect(stash.forms.has(draft.formKey())).toBe(false);
    expect(draft.drafts[0]?.value).toEqual(pick(2));
    expect(draft.restored()).toBe(false);
  });

  it("is no longer restored once reseeded for an identity with nothing kept", () => {
    const draft = draftIn({
      definition: () => defWith(Role.DRep, Role.Keyholder),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    draft.setValue(0, pick(1));
    draft.pickRole(Role.Keyholder);
    draft.pickRole(Role.DRep);
    expect(draft.restored()).toBe(true);

    draft.pickRole(Role.Keyholder);
    expect(draft.restored()).toBe(false);
  });

  it("replaces an edited value, so an earlier snapshot keeps what it read", () => {
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    draft.setValue(0, pick(1));
    const snapshot = draft.drafts.map((d) => ({
      skipped: d.skipped,
      value: d.value,
    }));
    draft.setValue(0, pick(2));
    expect(snapshot[0]?.value).toEqual(pick(1));
    expect(draft.drafts[0]?.value).toEqual(pick(2));
  });

  it("reseeds under a swapped credential for the same role", () => {
    const [responder, setResponder] = createSignal<Responder>({
      [Role.DRep]: cred(3),
    });
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    draft.setValue(0, pick(1));
    // A different wallet, same role: wallet A's answers must not be carried
    // under wallet B's credential.
    setResponder({ [Role.DRep]: cred(9) });

    expect(draft.credential()).toEqual(cred(9));
    expect(draft.drafts[0]?.value).toEqual(pick(null));
  });

  it("counts a skipped optional question as decided but not as an answer", () => {
    const draft = draftIn({
      definition: () => defWith(Role.DRep),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: () => [],
      preferredRole: () => null,
    });

    draft.setSkipped(1, true);
    expect(draft.decidedCount()).toBe(1);
    expect(draft.answered()).toBe(false);

    draft.setValue(0, pick(0));
    expect(draft.decidedCount()).toBe(2);
    expect(draft.answered()).toBe(true);
  });

  it("keeps the form key stable across data refreshes, not across identity", () => {
    const [priors, setPriors] = createSignal<readonly SurveyResponse[]>([]);
    const draft = draftIn({
      definition: () => defWith(Role.DRep, Role.Keyholder),
      surveyRef: () => ref(1),
      responder: () => both,
      priorResponses: priors,
      preferredRole: () => null,
    });

    const initial = draft.formKey();
    setPriors([priorPick(ref(1), Role.Keyholder, cred(1), 0)]);
    expect(draft.formKey()).toBe(initial);

    draft.pickRole(Role.Keyholder);
    expect(draft.formKey()).not.toBe(initial);
  });
});
