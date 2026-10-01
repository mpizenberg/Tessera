/**
 * Conditional display: a document beside the definition that shows a question
 * only when an earlier choice question's answer matches. A hidden question
 * reads as skipped: it records nothing, and it counts as no option selected for
 * any later condition.
 */

import type { Question, SurveyDefinition } from "cip-179";

import { optionCount, type Draft } from "./draft.js";

/**
 * Show a question when the single- or multi-choice question at index
 * `question`, which comes earlier, has one of `anyOf` selected, or none of
 * `noneOf`. A skipped or hidden question has no option selected.
 */
export type DisplayCondition =
  | { readonly question: number; readonly anyOf: readonly number[] }
  | { readonly question: number; readonly noneOf: readonly number[] };

/** Conditions keyed by the index of the question each one shows or hides. */
export type DisplayConditions = Readonly<Record<number, DisplayCondition>>;

/** A condition as checked: the options it tests, and how. */
export interface DisplayRule {
  readonly question: number;
  readonly options: ReadonlySet<number>;
  /** Shown when one of `options` is selected, or when none is. */
  readonly when: "any" | "none";
}

/** A conditions document checked against the definition. */
export interface ReadConditions {
  /** One per question, index-aligned; all `undefined` when any was faulty. */
  readonly rules: readonly (DisplayRule | undefined)[];
  /** One line per fault, for the console; any fault disables every rule. */
  readonly faults: readonly string[];
}

/**
 * The document's rules, or none when any is faulty: a condition on a required
 * question, on a question it does not come after, naming a question that is
 * not a single or multiple choice, an option out of range, or a malformed
 * entry. A fault most likely means the whole document is wrong, so applying
 * the rest would show a flow its author never meant.
 */
export function readConditions(
  definition: SurveyDefinition,
  conditions: unknown,
): ReadConditions {
  const questions = definition.questions;
  const rules: (DisplayRule | undefined)[] = questions.map(() => undefined);
  const faults: string[] = [];
  if (!isFields(conditions)) {
    faults.push("the conditions are not an object keyed by question index");
  } else {
    for (const [key, entry] of Object.entries(conditions)) {
      const index = Number(key);
      const read =
        String(index) === key && index >= 0 && index < questions.length
          ? readRule(questions, index, entry)
          : "is not a question index";
      if (typeof read === "string") faults.push(`question ${key} ${read}`);
      else rules[index] = read;
    }
  }
  return faults.length > 0
    ? { rules: questions.map(() => undefined), faults }
    : { rules, faults };
}

function readRule(
  questions: readonly Question[],
  index: number,
  entry: unknown,
): DisplayRule | string {
  if (questions[index]!.required) return "is required and cannot be hidden";
  if (!isFields(entry)) return "has a condition that is not an object";
  const question = entry.question;
  if (!Number.isInteger(question) || typeof question !== "number")
    return "names no question";
  if (question < 0 || question >= index)
    return `names question ${question}, which does not come before it`;
  const named = questions[question]!;
  if (named.type !== "singleChoice" && named.type !== "multiSelect")
    return `names question ${question}, which is not a choice question`;
  const hasAny = "anyOf" in entry;
  if (hasAny === "noneOf" in entry)
    return "needs exactly one of anyOf and noneOf";
  const options = hasAny ? entry.anyOf : entry.noneOf;
  const count = optionCount(named.options);
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    !options.every((o) => Number.isInteger(o) && o >= 0 && o < count)
  )
    return `lists options that question ${question} does not have`;
  return {
    question,
    options: new Set(options as number[]),
    when: hasAny ? "any" : "none",
  };
}

/**
 * Which questions are hidden, index-aligned with the drafts, decided in
 * question order so a hidden question reads as skipped for later conditions.
 */
export function hiddenQuestions(
  conditions: ReadConditions,
  drafts: readonly Draft[],
): boolean[] {
  const hidden: boolean[] = [];
  conditions.rules.forEach((rule) => {
    if (!rule) return void hidden.push(false);
    const draft = drafts[rule.question];
    const selected =
      draft && !draft.skipped && !hidden[rule.question]
        ? selectedOptions(draft)
        : [];
    const matched = selected.some((o) => rule.options.has(o));
    hidden.push(rule.when === "any" ? !matched : matched);
  });
  return hidden;
}

function selectedOptions(draft: Draft): readonly number[] {
  const v = draft.value;
  if (v.type === "singleChoice")
    return v.optionIndex === null ? [] : [v.optionIndex];
  if (v.type === "multiSelect") return v.selected ?? [];
  return [];
}

const isFields = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
