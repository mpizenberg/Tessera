import { describe, expect, test } from "vitest";

import type { Question, SurveyDefinition } from "cip-179";

import {
  localizeDefinition,
  localizeNoneLabels,
  readNoneLabels,
  readTranslations,
} from "../src/index.js";

const questions: Question[] = [
  {
    type: "singleChoice",
    prompt: "Pick one",
    options: { type: "options", labels: ["Yes", "No"] },
  },
  {
    type: "rating",
    prompt: "Rate",
    options: { type: "count", count: 2 },
    scale: { type: "labels", labels: ["Bad", "Fine", "Good"] },
    requireAll: false,
  },
  {
    type: "numericRange",
    prompt: "How many",
    constraints: { min: 0n, max: 9n },
  },
];
const definition = {
  title: "Survey",
  description: "About things",
  questions,
} as SurveyDefinition;

const fr = {
  title: "Enquête",
  description: "À propos",
  questions: [
    { prompt: "Choisissez", options: ["Oui", "Non"] },
    {
      prompt: "Notez",
      options: ["Un", "Deux"],
      ratingLabels: ["Mauvais", "Correct", "Bon"],
    },
    { prompt: "Combien" },
  ],
};

const localize = (overlay: unknown, locale: string) =>
  localizeDefinition(definition, readTranslations(definition, overlay), locale);

describe("readTranslations", () => {
  test("keeps a congruent entry under its lowercased tag", () => {
    const read = readTranslations(definition, {
      defaultLanguage: "en",
      translations: { "fr-CA": fr },
    });
    expect([...read.entries.keys()]).toEqual(["fr-ca"]);
    expect(read.dropped).toEqual([]);
  });

  test("drops an entry restating the default language, whatever its case", () => {
    const read = readTranslations(definition, {
      defaultLanguage: "en",
      translations: { EN: { title: "Other" }, fr },
    });
    expect([...read.entries.keys()]).toEqual(["fr"]);
    expect(read.dropped).toHaveLength(1);
  });

  test.each([
    ["a missing question", { questions: fr.questions.slice(0, 2) }],
    [
      "an option count that differs",
      { questions: [{ options: ["Oui"] }, {}, {}] },
    ],
    [
      "options on a question without any",
      { questions: [{}, {}, { options: ["a", "b"] }] },
    ],
    [
      "rating labels on a choice question",
      { questions: [{ ratingLabels: ["a", "b"] }, {}, {}] },
    ],
    [
      "a rating level count that differs",
      { questions: [{}, { ratingLabels: ["a", "b"] }, {}] },
    ],
    ["text that is not a string", { title: 3 }],
    ["a question that is not an object", { questions: [{}, null, {}] }],
  ])("drops an entry with %s", (_, entry) => {
    const read = readTranslations(definition, {
      defaultLanguage: "en",
      translations: { fr: entry },
    });
    expect(read.entries.size).toBe(0);
    expect(read.dropped).toHaveLength(1);
    expect(
      localize({ defaultLanguage: "en", translations: { fr: entry } }, "fr"),
    ).toBe(definition);
  });

  test("an overlay without defaultLanguage is dropped whole", () => {
    const read = readTranslations(definition, { translations: { fr } });
    expect(read.entries.size).toBe(0);
    expect(read.dropped).toHaveLength(1);
  });
});

describe("localizeDefinition", () => {
  test("replaces every translated field", () => {
    const out = localize({ defaultLanguage: "en", translations: { fr } }, "fr");
    expect(out.title).toBe("Enquête");
    expect(out.description).toBe("À propos");
    expect(out.questions.map((q) => q.prompt)).toEqual([
      "Choisissez",
      "Notez",
      "Combien",
    ]);
    expect(out.questions[0]).toMatchObject({
      options: { type: "options", labels: ["Oui", "Non"] },
    });
    expect(out.questions[1]).toMatchObject({
      options: { type: "options", labels: ["Un", "Deux"] },
      scale: { type: "labels", labels: ["Mauvais", "Correct", "Bon"] },
    });
  });

  test("leaves everything but text alone", () => {
    const out = localize({ defaultLanguage: "en", translations: { fr } }, "fr");
    expect(out.questions[2]).toEqual({ ...questions[2], prompt: "Combien" });
    expect({ ...out.questions[0], prompt: "", options: null }).toEqual({
      ...questions[0],
      prompt: "",
      options: null,
    });
  });

  test("falls back per field: region, then language, then on-chain", () => {
    const out = localize(
      {
        defaultLanguage: "en",
        translations: {
          "fr-CA": {
            title: "Sondage",
            questions: [{}, { prompt: "Évaluez" }, {}],
          },
          fr: { description: "À propos" },
        },
      },
      "fr-CA",
    );
    expect(out.title).toBe("Sondage");
    expect(out.description).toBe("À propos");
    expect(out.questions.map((q) => q.prompt)).toEqual([
      "Pick one",
      "Évaluez",
      "How many",
    ]);
    expect(out.questions[0]).toEqual(questions[0]);
  });

  test("drops a singleton subtag left at the end", () => {
    const out = localize(
      { defaultLanguage: "en", translations: { "zh-hant": { title: "調查" } } },
      "zh-Hant-x-private",
    );
    expect(out.title).toBe("調查");
  });

  test("matches tags whatever their case", () => {
    const out = localize(
      {
        defaultLanguage: "en",
        translations: { "FR-ca": { title: "Sondage" } },
      },
      "fr-CA",
    );
    expect(out.title).toBe("Sondage");
  });

  test("a locale with no entry keeps the definition", () => {
    const overlay = { defaultLanguage: "en", translations: { fr } };
    expect(localize(overlay, "de-DE")).toBe(definition);
    expect(localize(overlay, "en")).toBe(definition);
  });

  test("the default language stops the lookup before a broader entry", () => {
    const overlay = {
      defaultLanguage: "pt-BR",
      translations: { pt: { title: "Inquérito" } },
    };
    expect(localize(overlay, "pt-BR").title).toBe("Survey");
    expect(localize(overlay, "pt-PT").title).toBe("Inquérito");
  });
});

const multiSelect = (minSelections: number): Question => ({
  type: "multiSelect",
  prompt: "Pick some",
  minSelections,
  maxSelections: 2,
  options: { type: "options", labels: ["A", "B"] },
});
const withNone = {
  title: "Survey",
  description: "",
  questions: [multiSelect(0), multiSelect(1), questions[0]!],
} as SurveyDefinition;

describe("readNoneLabels", () => {
  test("keeps a label of up to 64 bytes on a multi-select with a minimum of 0", () => {
    expect(readNoneLabels(withNone, { 0: "é".repeat(32) })).toEqual({
      labels: ["é".repeat(32), undefined, undefined],
      dropped: [],
    });
  });

  test.each([
    ["on a multi-select with a minimum of 1", { 1: "Nothing" }],
    ["on a single choice", { 2: "Nothing" }],
    ["on a missing question", { 3: "Nothing" }],
    ["keyed by something other than an index", { "00": "Nothing" }],
    ["that is empty", { 0: "" }],
    ["over 64 bytes", { 0: "é".repeat(33) }],
    ["that is not a string", { 0: 7 }],
  ])("drops a label %s", (_, entry) => {
    const read = readNoneLabels(withNone, entry);
    expect(read.labels).toEqual([undefined, undefined, undefined]);
    expect(read.dropped).toHaveLength(1);
  });

  test("keeps a label beside a dropped one", () => {
    const read = readNoneLabels(withNone, { 0: "Nothing", 2: "Nothing" });
    expect(read.labels).toEqual(["Nothing", undefined, undefined]);
    expect(read.dropped).toHaveLength(1);
  });

  test("drops a document that is not an object", () => {
    const read = readNoneLabels(withNone, ["Nothing"]);
    expect(read.labels).toEqual([undefined, undefined, undefined]);
    expect(read.dropped).toHaveLength(1);
  });
});

describe("None labels in translations", () => {
  const overlay = (noneLabel: unknown, at = 0) => ({
    defaultLanguage: "en",
    translations: {
      fr: { questions: [0, 1, 2].map((i) => (i === at ? { noneLabel } : {})) },
    },
  });
  const localizeNone = (labels: object, overlay: unknown, locale: string) =>
    localizeNoneLabels(
      readNoneLabels(withNone, labels).labels,
      readTranslations(withNone, overlay),
      locale,
    );

  test("a translation's label replaces the survey's, region to language", () => {
    expect(localizeNone({ 0: "Nothing" }, overlay("Rien"), "fr-CA")).toEqual([
      "Rien",
      undefined,
      undefined,
    ]);
  });

  test("words a box the survey leaves to its default", () => {
    expect(localizeNone({}, overlay("Rien"), "fr")[0]).toBe("Rien");
  });

  test("falls back to the survey's label", () => {
    const fallback = overlay(undefined);
    expect(localizeNone({ 0: "Nothing" }, fallback, "fr")[0]).toBe("Nothing");
    expect(localizeNone({ 0: "Nothing" }, fallback, "de")[0]).toBe("Nothing");
  });

  test.each([
    ["on a question without a None box", overlay("Rien", 1)],
    ["that is empty", overlay("")],
    ["over 64 bytes", overlay("é".repeat(33))],
    ["that is not a string", overlay(3)],
  ])("drops an entry with a None label %s", (_, overlay) => {
    const read = readTranslations(withNone, overlay);
    expect(read.entries.size).toBe(0);
    expect(read.dropped).toHaveLength(1);
  });
});
