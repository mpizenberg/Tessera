/**
 * A form kept between visits: drafts as plain JSON, so any store that holds
 * JSON can keep them, and read back only when they still fit the questions.
 */

import type { Question } from "cip-179";
import { fromJsonSafe, toJsonSafe } from "cip-179/tally";

import { optionCount, type Draft, type DraftValue } from "./draft.js";

/** The drafts as plain JSON; big integers become tagged strings. */
export function encodeKeptForm(drafts: readonly Draft[]): unknown {
  return toJsonSafe(drafts);
}

/**
 * A kept form, or nothing unless every question's draft fits it. A definition
 * cannot change under a survey reference, so a misfit is damage, and half a
 * form restored is worse than none.
 */
export function decodeKeptForm(
  raw: unknown,
  questions: readonly Question[],
): Draft[] | undefined {
  let form: unknown;
  try {
    form = fromJsonSafe(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(form) || form.length !== questions.length)
    return undefined;
  const drafts: Draft[] = [];
  for (const [i, q] of questions.entries()) {
    const d: unknown = form[i];
    if (!isFields(d) || typeof d.skipped !== "boolean") return undefined;
    const value = decodeValue(q, d.value);
    if (!value) return undefined;
    drafts.push({ skipped: d.skipped, value });
  }
  return drafts;
}

type Fields = Record<string, unknown>;

const isFields = (x: unknown): x is Fields =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isIndex = (x: unknown, count: number): x is number =>
  Number.isInteger(x) && (x as number) >= 0 && (x as number) < count;

const isIndexSet = (xs: unknown, count: number): xs is number[] =>
  Array.isArray(xs) &&
  xs.every((x) => isIndex(x, count)) &&
  new Set(xs).size === xs.length;

function decodeValue(q: Question, raw: unknown): DraftValue | undefined {
  if (!isFields(raw)) return undefined;
  switch (q.type) {
    case "singleChoice": {
      const i = raw.optionIndex;
      return raw.type === "singleChoice" &&
        (i === null || isIndex(i, optionCount(q.options)))
        ? { type: "singleChoice", optionIndex: i }
        : undefined;
    }
    case "multiSelect":
      return raw.type === "multiSelect" &&
        (raw.selected === null ||
          isIndexSet(raw.selected, optionCount(q.options)))
        ? { type: "multiSelect", selected: raw.selected }
        : undefined;
    case "ranking":
      return raw.type === "ranking" &&
        isIndexSet(raw.ranked, optionCount(q.options))
        ? { type: "ranking", ranked: raw.ranked }
        : undefined;
    case "numericRange":
      return raw.type === "numeric" &&
        (raw.value === null || typeof raw.value === "bigint")
        ? { type: "numeric", value: raw.value }
        : undefined;
    case "pointsAllocation": {
      const points = raw.points;
      return raw.type === "pointsAllocation" &&
        Array.isArray(points) &&
        points.length === optionCount(q.options) &&
        points.every((p) => typeof p === "bigint")
        ? { type: "pointsAllocation", points }
        : undefined;
    }
    case "rating": {
      const ratings = raw.ratings;
      return raw.type === "rating" &&
        Array.isArray(ratings) &&
        ratings.length === optionCount(q.options) &&
        ratings.every((r) => r === null || typeof r === "bigint")
        ? { type: "rating", ratings }
        : undefined;
    }
    case "custom":
      return raw.type === "custom" && typeof raw.text === "string"
        ? { type: "custom", text: raw.text }
        : undefined;
  }
}
