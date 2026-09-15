import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Role } from "cip-179";

import { initQuestionDraft } from "~/domain/create";
import { blankDraft, loadDraft, storeDraft, type SurveyDraft } from "./draft";

// Same shim as cart.test.ts: these tests run in plain Node, no DOM.
const store = new Map<string, string>();
const KEY = "tessera.createDraft.preview";

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

const written: SurveyDraft = {
  meta: {
    title: "Treasury priorities",
    description: "For next epoch",
    eligibleRoles: [Role.DRep, Role.Stakeholder],
    contentMode: "external",
    endEpoch: "321",
    mode: "sealed",
    sealedPadding: 128,
  },
  questions: [
    { ...initQuestionDraft("rating"), prompt: "Rate", ratingScale: "labels" },
    { ...initQuestionDraft("numericRange"), numMax: "99", required: true },
  ],
  drandMode: "manual",
  drandRoundText: "31287452",
  govLinked: true,
};

const stored = (): Record<string, unknown> =>
  JSON.parse(store.get(KEY)!) as Record<string, unknown>;

describe("the survey being written survives a reload", () => {
  test("a draft comes back as it was written", () => {
    storeDraft(written);
    expect(loadDraft()).toEqual(written);
  });

  test("a draft with no text in it clears the key", () => {
    storeDraft(written);
    const typedNothing: SurveyDraft = {
      ...blankDraft(),
      meta: { ...blankDraft().meta, title: "  ", mode: "sealed" },
      govLinked: true,
    };
    storeDraft(typedNothing);
    expect(store.has(KEY)).toBe(false);
    storeDraft(written);
    storeDraft(undefined);
    expect(store.has(KEY)).toBe(false);
  });

  test("storage the browser refuses is not an error", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => storeDraft(written)).not.toThrow();
    expect(() => storeDraft(undefined)).not.toThrow();
    expect(loadDraft()).toBeUndefined();
  });

  test("stored data that is not a draft object loads as nothing", () => {
    for (const text of ["{not json", "[1, 2]", "null", '"title"']) {
      store.set(KEY, text);
      expect(loadDraft()).toBeUndefined();
    }
  });

  test("a question of an unknown type goes without taking the rest", () => {
    storeDraft(written);
    const draft = stored();
    draft.questions = [{ type: "essay", prompt: "x" }, ...written.questions];
    store.set(KEY, JSON.stringify(draft));
    expect(loadDraft()?.questions).toEqual(written.questions);
  });

  test("with no question left, the draft starts from a fresh one", () => {
    storeDraft(written);
    store.set(KEY, JSON.stringify({ ...stored(), questions: [{ no: 1 }] }));
    expect(loadDraft()?.questions).toEqual(blankDraft().questions);
  });

  test("a field of the wrong shape falls back to its default", () => {
    storeDraft(written);
    const draft = stored();
    draft.meta = {
      ...(draft.meta as object),
      endEpoch: 321,
      mode: "secret",
      sealedPadding: "128",
    };
    draft.questions = [
      { ...written.questions[0], labels: [1, 2], ratingScale: "stars" },
    ];
    draft.drandMode = "sometimes";
    draft.govLinked = "yes";
    store.set(KEY, JSON.stringify(draft));

    const blank = blankDraft();
    const rating = initQuestionDraft("rating");
    expect(loadDraft()).toEqual({
      ...written,
      meta: {
        ...written.meta,
        endEpoch: blank.meta.endEpoch,
        mode: blank.meta.mode,
        sealedPadding: blank.meta.sealedPadding,
      },
      questions: [
        {
          ...written.questions[0],
          labels: rating.labels,
          ratingScale: rating.ratingScale,
        },
      ],
      drandMode: blank.drandMode,
      govLinked: blank.govLinked,
    });
  });

  test("roles the app does not know are dropped", () => {
    storeDraft(written);
    const draft = stored();
    draft.meta = { ...(draft.meta as object), eligibleRoles: [7, "0", 3, 3] };
    store.set(KEY, JSON.stringify(draft));
    expect(loadDraft()?.meta.eligibleRoles).toEqual([Role.Stakeholder]);
  });

  test("each network keeps its own draft", () => {
    vi.stubGlobal("__DEPLOYMENT__", {
      network: "preprod",
      appUrls: {},
      commit: "test",
    });
    storeDraft(written);
    expect([...store.keys()]).toEqual(["tessera.createDraft.preprod"]);
  });
});
