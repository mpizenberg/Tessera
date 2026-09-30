import { describe, expect, test } from "vitest";

import type { Question } from "cip-179";

import { decodeKeptForm, encodeKeptForm, type Draft } from "../src/index.js";

const options = { type: "options", labels: ["a", "b", "c"] } as const;
const questions: Question[] = [
  { type: "singleChoice", prompt: "", required: true, options },
  {
    type: "multiSelect",
    prompt: "",
    required: false,
    options,
    minSelections: 0,
    maxSelections: 3,
  },
  {
    type: "ranking",
    prompt: "",
    required: false,
    options,
    minRanked: 1,
    maxRanked: 3,
  },
  {
    type: "numericRange",
    prompt: "",
    required: false,
    constraints: { min: 0n, max: 10n ** 30n },
  },
  {
    type: "pointsAllocation",
    prompt: "",
    required: false,
    options,
    budget: 9n,
  },
  {
    type: "rating",
    prompt: "",
    required: false,
    options,
    scale: { type: "numeric", constraints: { min: 1n, max: 5n } },
    requireAll: false,
  },
  {
    type: "custom",
    prompt: "",
    required: false,
    methodSchema: { uri: "ipfs://schema", hash: new Uint8Array(32) },
  },
];

const form: Draft[] = [
  { skipped: false, value: { type: "singleChoice", optionIndex: 2 } },
  { skipped: false, value: { type: "multiSelect", selected: [0, 2] } },
  { skipped: true, value: { type: "ranking", ranked: [] } },
  { skipped: false, value: { type: "numeric", value: 10n ** 30n } },
  { skipped: false, value: { type: "pointsAllocation", points: [4n, 0n, 5n] } },
  { skipped: false, value: { type: "rating", ratings: [5n, null, 1n] } },
  { skipped: false, value: { type: "custom", text: "why not" } },
];

/** Through the JSON a store would keep, as a reload reads it back. */
const kept = (drafts: readonly Draft[]): unknown =>
  JSON.parse(JSON.stringify(encodeKeptForm(drafts)));

describe("a kept form", () => {
  test("comes back as it was, big integers included", () => {
    expect(decodeKeptForm(kept(form), questions)).toEqual(form);
  });

  test("comes back with answers not yet chosen unset", () => {
    const unset = form.map((d, i): Draft =>
      i === 1
        ? { ...d, value: { type: "multiSelect", selected: null } }
        : i === 3
          ? { ...d, value: { type: "numeric", value: null } }
          : d,
    );
    expect(decodeKeptForm(kept(unset), questions)).toEqual(unset);
  });

  test("reads as nothing when it no longer fits its questions", () => {
    const misfits: Draft[][] = [
      form.slice(1),
      form.map((d, i) =>
        i === 0 ? { ...d, value: { type: "custom", text: "2" } } : d,
      ),
      form.map((d, i) =>
        i === 0 ? { ...d, value: { type: "singleChoice", optionIndex: 3 } } : d,
      ),
      form.map((d, i) =>
        i === 1
          ? { ...d, value: { type: "multiSelect", selected: [2, 2] } }
          : d,
      ),
      form.map((d, i) =>
        i === 5 ? { ...d, value: { type: "rating", ratings: [5n, null] } } : d,
      ),
    ];
    for (const misfit of misfits)
      expect(decodeKeptForm(kept(misfit), questions)).toBeUndefined();
  });

  test("reads as nothing with numbers where big integers belong", () => {
    // As a hand edit of the store would leave it.
    const edited = kept(form) as { value: { value?: unknown } }[];
    edited[3]!.value.value = 7;
    expect(decodeKeptForm(edited, questions)).toBeUndefined();
  });

  test("reads as nothing when there is none", () => {
    expect(decodeKeptForm(undefined, questions)).toBeUndefined();
  });
});
