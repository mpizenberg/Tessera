/**
 * Translated survey text: an overlay document that holds, beside the
 * definition, the survey's text in languages other than its default. Answers
 * carry option indices only, so a translation changes what a responder reads,
 * never what they submit.
 *
 * The overlay names the language of the on-chain text (`defaultLanguage`) and
 * keys each other language by BCP-47 tag. An entry mirrors the definition's
 * text: title, description, and per question its prompt, option labels and
 * rating labels, in question and option order. Every field is optional, and a
 * missing one falls back field by field through the locale's less specific
 * tags (`fr-CA`, then `fr`) to the on-chain text.
 */

import type { Question, SurveyDefinition } from "cip-179";

import { optionCount } from "./draft.js";

export interface SurveyTranslations {
  /** BCP-47 tag of the definition's own text. */
  readonly defaultLanguage: string;
  /** One entry per other language, keyed by BCP-47 tag. */
  readonly translations?: Readonly<Record<string, SurveyTranslation>>;
}

export interface SurveyTranslation {
  readonly title?: string;
  readonly description?: string;
  /** One per question, in order. */
  readonly questions?: readonly QuestionTranslation[];
}

export interface QuestionTranslation {
  readonly prompt?: string;
  /** One per option, in option order. */
  readonly options?: readonly string[];
  /** One per level of a rating scale given as labels or a level count. */
  readonly ratingLabels?: readonly string[];
}

/** An overlay's usable entries, and why the others were dropped. */
export interface ReadTranslations {
  readonly defaultLanguage: string;
  /** Usable entries by lowercased tag. */
  readonly entries: ReadonlyMap<string, SurveyTranslation>;
  /** One line per dropped entry, for the console. */
  readonly dropped: readonly string[];
}

/**
 * The overlay's entries that fit the definition. An entry restating the
 * default language is dropped, and so is one whose shape differs from the
 * questions (count, option counts, rating levels) or whose text is not
 * strings: it could pair a label with the wrong option. A dropped language
 * renders in the default.
 */
export function readTranslations(
  definition: SurveyDefinition,
  overlay: unknown,
): ReadTranslations {
  const entries = new Map<string, SurveyTranslation>();
  if (!isFields(overlay) || typeof overlay.defaultLanguage !== "string") {
    return {
      defaultLanguage: "",
      entries,
      dropped: ["the overlay has no defaultLanguage; no translation is used"],
    };
  }
  const defaultLanguage = overlay.defaultLanguage.toLowerCase();
  const dropped: string[] = [];
  const raw = isFields(overlay.translations) ? overlay.translations : {};
  for (const [tag, entry] of Object.entries(raw)) {
    const key = tag.toLowerCase();
    if (key === defaultLanguage)
      dropped.push(`'${tag}' restates the default language`);
    else if (!fits(entry, definition.questions))
      dropped.push(`'${tag}' does not match the survey's questions`);
    else if (!entries.has(key)) entries.set(key, entry);
  }
  return { defaultLanguage, entries, dropped };
}

/**
 * The definition with its text in `locale`, picked per field by RFC 4647
 * lookup: `fr-CA`'s entry, then `fr`'s, then the on-chain text. A locale
 * falling back to the default language stops there, so a `pt-BR` default is
 * not overridden by a `pt` entry.
 */
export function localizeDefinition(
  definition: SurveyDefinition,
  translations: ReadTranslations,
  locale: string,
): SurveyDefinition {
  const chain: SurveyTranslation[] = [];
  for (const tag of lookupChain(locale)) {
    if (tag === translations.defaultLanguage) break;
    const entry = translations.entries.get(tag);
    if (entry) chain.push(entry);
  }
  if (chain.length === 0) return definition;

  const pick = <T>(get: (e: SurveyTranslation) => T | undefined) => {
    for (const e of chain) {
      const v = get(e);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  return {
    ...definition,
    title: pick((e) => e.title) ?? definition.title,
    description: pick((e) => e.description) ?? definition.description,
    questions: definition.questions.map((q, i) =>
      localizeQuestion(q, (field) => pick((e) => e.questions?.[i]?.[field])),
    ),
  };
}

function localizeQuestion(
  q: Question,
  pick: <K extends keyof QuestionTranslation>(
    field: K,
  ) => QuestionTranslation[K] | undefined,
): Question {
  const prompt = pick("prompt") ?? q.prompt;
  if (q.type === "custom" || q.type === "numericRange") return { ...q, prompt };
  const labels = pick("options");
  const options = labels ? { type: "options" as const, labels } : q.options;
  if (q.type !== "rating") return { ...q, prompt, options };
  const levels = pick("ratingLabels");
  const scale = levels ? { type: "labels" as const, labels: levels } : q.scale;
  return { ...q, prompt, options, scale };
}

/** RFC 4647 lookup: drop the last subtag, and a singleton left before it. */
function lookupChain(locale: string): string[] {
  const subtags = locale.toLowerCase().split("-");
  const chain: string[] = [];
  while (subtags.length > 0 && subtags[0] !== "") {
    chain.push(subtags.join("-"));
    subtags.pop();
    if (subtags[subtags.length - 1]?.length === 1) subtags.pop();
  }
  return chain;
}

type Fields = Record<string, unknown>;

const isFields = (x: unknown): x is Fields =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isText = (x: unknown): boolean =>
  x === undefined || typeof x === "string";

const isLabels = (x: unknown, count: number): boolean =>
  x === undefined ||
  (Array.isArray(x) &&
    x.length === count &&
    x.every((l) => typeof l === "string"));

function fits(
  entry: unknown,
  questions: readonly Question[],
): entry is SurveyTranslation {
  if (!isFields(entry) || !isText(entry.title) || !isText(entry.description))
    return false;
  const qs = entry.questions;
  if (qs === undefined) return true;
  return (
    Array.isArray(qs) &&
    qs.length === questions.length &&
    questions.every((q, i) => fitsQuestion(qs[i], q))
  );
}

function fitsQuestion(entry: unknown, q: Question): boolean {
  if (!isFields(entry) || !isText(entry.prompt)) return false;
  const options = "options" in q ? optionCount(q.options) : undefined;
  const levels = q.type === "rating" ? ratingLevelCount(q) : undefined;
  return (
    (entry.options === undefined ||
      (options !== undefined && isLabels(entry.options, options))) &&
    (entry.ratingLabels === undefined ||
      (levels !== undefined && isLabels(entry.ratingLabels, levels)))
  );
}

/** Levels a rating scale names; a numeric scale names none. */
function ratingLevelCount(
  q: Extract<Question, { type: "rating" }>,
): number | undefined {
  switch (q.scale.type) {
    case "labels":
      return q.scale.labels.length;
    case "count":
      return q.scale.count;
    case "numeric":
      return undefined;
  }
}
