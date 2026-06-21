/**
 * Pure logic for composing a survey response.
 *
 * The Respond screen keeps a {@link Draft} per question (UI working state); this
 * module turns drafts into validated CIP-179 {@link AnswerItem}s and a
 * {@link SurveyResponse}, decides when a question is "answered" vs still pending,
 * and reconstructs drafts from a prior on-chain response (edit / replace flow).
 *
 * No framework, no I/O — every function here is unit-testable in isolation.
 * Semantic correctness of the assembled response is double-checked by the
 * codec's `validateResponse`; this layer just makes the common case easy and the
 * progress UI accurate.
 */

import {
  SPEC_VERSION,
  type AnswerItem,
  type Credential,
  type OptionsOrCount,
  type Question,
  type Role,
  type SurveyRef,
  type SurveyResponse,
} from "cip-179";

import { credentialKey, refKey } from "./survey";

/** Options a question offers (inline labels or an external count). */
export function optionCount(opts: OptionsOrCount): number {
  return opts.type === "options" ? opts.labels.length : opts.count;
}

/** Per-question working value, discriminated by the question's type. */
export type DraftValue =
  | { readonly type: "singleChoice"; readonly optionIndex: number | null }
  | { readonly type: "multiSelect"; readonly selected: readonly number[] }
  | { readonly type: "ranking"; readonly ranked: readonly number[] }
  | { readonly type: "numeric"; readonly value: bigint }
  | { readonly type: "pointsAllocation"; readonly points: readonly number[] }
  | { readonly type: "rating"; readonly ratings: readonly (bigint | null)[] }
  | { readonly type: "custom"; readonly text: string };

/** A question's draft: its value plus whether the responder chose to Skip it. */
export interface Draft {
  /** Skip = deliberate abstention (records nothing for this question). */
  readonly skipped: boolean;
  readonly value: DraftValue;
}

/** A fresh, un-skipped draft with sensible defaults for a question type. */
export function initDraft(q: Question): Draft {
  return { skipped: false, value: initValue(q) };
}

function initValue(q: Question): DraftValue {
  switch (q.type) {
    case "singleChoice":
      return { type: "singleChoice", optionIndex: null };
    case "multiSelect":
      return { type: "multiSelect", selected: [] };
    case "ranking":
      return { type: "ranking", ranked: [] };
    case "numericRange":
      return { type: "numeric", value: q.constraints.min };
    case "pointsAllocation":
      return {
        type: "pointsAllocation",
        points: Array.from({ length: optionCount(q.options) }, () => 0),
      };
    case "rating":
      return {
        type: "rating",
        ratings: Array.from({ length: optionCount(q.options) }, () => null),
      };
    case "custom":
      return { type: "custom", text: "" };
  }
}

/**
 * Is a question settled — either skipped, or carrying a complete, in-bounds
 * answer? Submission is gated on every question being decided; the codec's
 * validator is the final authority on the assembled response.
 */
export function decided(q: Question, draft: Draft): boolean {
  if (draft.skipped) return true;
  const v = draft.value;
  switch (q.type) {
    case "singleChoice":
      return v.type === "singleChoice" && v.optionIndex !== null;
    case "multiSelect":
      return (
        v.type === "multiSelect" &&
        v.selected.length >= q.minSelections &&
        v.selected.length <= q.maxSelections
      );
    case "ranking":
      return (
        v.type === "ranking" &&
        v.ranked.length >= q.minRanked &&
        v.ranked.length <= q.maxRanked
      );
    case "numericRange":
      return v.type === "numeric";
    case "pointsAllocation":
      return (
        v.type === "pointsAllocation" &&
        v.points.reduce((s, p) => s + p, 0) === q.budget
      );
    case "rating":
      return v.type === "rating" && v.ratings.every((r) => r !== null);
    case "custom":
      return v.type === "custom" && v.text.trim() !== "";
  }
}

/**
 * Build the CIP-179 answer item for a question, or null when there is no answer
 * to record (the question was skipped, or its draft isn't answerable yet).
 */
export function buildAnswerItem(
  q: Question,
  index: number,
  draft: Draft,
): AnswerItem | null {
  if (draft.skipped) return null;
  const v = draft.value;
  switch (q.type) {
    case "singleChoice":
      if (v.type !== "singleChoice" || v.optionIndex === null) return null;
      return {
        type: "singleChoice",
        questionIndex: index,
        optionIndex: v.optionIndex,
      };
    case "multiSelect":
      if (v.type !== "multiSelect") return null;
      return {
        type: "multiSelect",
        questionIndex: index,
        optionIndices: [...v.selected],
      };
    case "ranking":
      if (v.type !== "ranking") return null;
      return { type: "ranking", questionIndex: index, ranking: [...v.ranked] };
    case "numericRange":
      if (v.type !== "numeric") return null;
      return { type: "numeric", questionIndex: index, value: v.value };
    case "pointsAllocation":
      if (v.type !== "pointsAllocation") return null;
      return {
        type: "pointsAllocation",
        questionIndex: index,
        // Drop zero allocations; the remainder must still sum to budget.
        allocations: v.points
          .map((points, optionIndex) => ({ optionIndex, points }))
          .filter((a) => a.points > 0),
      };
    case "rating":
      if (v.type !== "rating") return null;
      return {
        type: "rating",
        questionIndex: index,
        ratings: v.ratings.flatMap((rating, optionIndex) =>
          rating === null ? [] : [{ optionIndex, rating }],
        ),
      };
    case "custom":
      if (v.type !== "custom") return null;
      return { type: "custom", questionIndex: index, value: v.text };
  }
}

/** All answer items for the non-skipped, answerable questions, in order. */
export function collectAnswers(
  questions: readonly Question[],
  drafts: readonly Draft[],
): AnswerItem[] {
  const out: AnswerItem[] = [];
  questions.forEach((q, i) => {
    const item = buildAnswerItem(q, i, drafts[i]!);
    if (item) out.push(item);
  });
  return out;
}

/** Assemble a public response from collected drafts. */
export function buildResponse(
  ref: SurveyRef,
  role: Role,
  credential: Credential,
  questions: readonly Question[],
  drafts: readonly Draft[],
): SurveyResponse {
  return {
    specVersion: SPEC_VERSION,
    surveyRef: ref,
    role,
    credential,
    answers: { type: "public", answers: collectAnswers(questions, drafts) },
  };
}

/**
 * Find a wallet's prior public response to this survey for the given role +
 * credential, if any (caller passes the latest-valid-wins–deduped set).
 */
export function findExistingResponse(
  responses: readonly SurveyResponse[],
  ref: SurveyRef,
  role: Role,
  credential: Credential,
): SurveyResponse | undefined {
  const target = refKey(ref);
  const cred = credentialKey(credential);
  return responses.find(
    (r) =>
      r.role === role &&
      refKey(r.surveyRef) === target &&
      credentialKey(r.credential) === cred &&
      r.answers.type === "public",
  );
}

/**
 * Reconstruct editable drafts from a prior response: questions it answered are
 * pre-filled with their values; the rest start at defaults. (Questions the prior
 * response omitted are left for the user to decide again, not auto-skipped.)
 */
export function prefillDrafts(
  questions: readonly Question[],
  response: SurveyResponse,
): Draft[] {
  const byIndex = new Map<number, AnswerItem>();
  if (response.answers.type === "public") {
    for (const a of response.answers.answers) byIndex.set(a.questionIndex, a);
  }
  return questions.map((q, i) => {
    const prior = byIndex.get(i);
    const value = prior ? valueFromAnswer(q, prior) : initValue(q);
    return { skipped: false, value: value ?? initValue(q) };
  });
}

function valueFromAnswer(q: Question, a: AnswerItem): DraftValue | null {
  switch (q.type) {
    case "singleChoice":
      return a.type === "singleChoice"
        ? { type: "singleChoice", optionIndex: a.optionIndex }
        : null;
    case "multiSelect":
      return a.type === "multiSelect"
        ? { type: "multiSelect", selected: [...a.optionIndices] }
        : null;
    case "ranking":
      return a.type === "ranking"
        ? { type: "ranking", ranked: [...a.ranking] }
        : null;
    case "numericRange":
      return a.type === "numeric" ? { type: "numeric", value: a.value } : null;
    case "pointsAllocation": {
      if (a.type !== "pointsAllocation") return null;
      const points = Array.from({ length: optionCount(q.options) }, () => 0);
      for (const alloc of a.allocations)
        points[alloc.optionIndex] = alloc.points;
      return { type: "pointsAllocation", points };
    }
    case "rating": {
      if (a.type !== "rating") return null;
      const ratings: (bigint | null)[] = Array.from(
        { length: optionCount(q.options) },
        () => null,
      );
      for (const r of a.ratings) ratings[r.optionIndex] = r.rating;
      return { type: "rating", ratings };
    }
    case "custom":
      return a.type === "custom"
        ? { type: "custom", text: typeof a.value === "string" ? a.value : "" }
        : null;
  }
}
