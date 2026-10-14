/**
 * Survey text beside the definition. Answers carry option indices only, so
 * this text changes what a responder reads, never what they submit.
 *
 * None labels word a multi-select's "None of these" box, which CIP-179 has no
 * field for, in the definition's language. A label is bounded like an option
 * label, so the field could join the definition.
 *
 * The translations overlay names the language of the on-chain text
 * (`defaultLanguage`) and keys each other language by BCP-47 tag. An entry
 * mirrors the definition's text: title, description, and per question its
 * prompt, option labels, rating labels and None label, in question and option
 * order. Every field is optional, and a missing one falls back field by field
 * through the locale's less specific tags (`fr-CA`, then `fr`) to the
 * definition's own text.
 */

import {
  MAX_CHUNK_BYTES,
  utf8ByteLength,
  type Question,
  type SurveyDefinition,
} from "cip-179";

import { hasNoneBox, optionCount } from "./draft.js";

/** Labels keyed by the index of the multi-select whose None box each words. */
export type NoneLabels = Readonly<Record<number, string>>;

/** A None labels document's usable labels, and why the others were dropped. */
export interface ReadNoneLabels {
  /** One per question, index-aligned; `undefined` keeps the box's default. */
  readonly labels: readonly (string | undefined)[];
  /** One line per dropped label, for the console. */
  readonly dropped: readonly string[];
}

/**
 * The labels that fit the definition. A label on a question without a None
 * box (a multi-select with a minimum of 0), or one that is not 1 to 64 bytes
 * of text, is dropped: that box keeps its default.
 */
export function readNoneLabels(
  definition: SurveyDefinition,
  noneLabels: unknown,
): ReadNoneLabels {
  const questions = definition.questions;
  const labels: (string | undefined)[] = questions.map(() => undefined);
  if (!isFields(noneLabels))
    return {
      labels,
      dropped: ["the labels are not an object keyed by question index"],
    };
  const dropped: string[] = [];
  for (const [key, label] of Object.entries(noneLabels)) {
    const index = Number(key);
    const q = String(index) === key ? questions[index] : undefined;
    if (q === undefined)
      dropped.push(`question ${key} is not a question index`);
    else if (!hasNoneBox(q))
      dropped.push(`question ${key} is not a multi-select with a minimum of 0`);
    else if (!isNoneLabel(label))
      dropped.push(`question ${key} has no label of 1 to 64 bytes of text`);
    else labels[index] = label;
  }
  return { labels, dropped };
}

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
  /** The None box's label, on a multi-select with a minimum of 0. */
  readonly noneLabel?: string;
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
 * questions (count, option counts, rating levels, None boxes) or whose text
 * is not strings: it could pair a label with the wrong option. A None label
 * is held to {@link readNoneLabels}'s bound. A dropped language renders in
 * the default.
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
  const pick = picker(translations, locale);
  if (!pick) return definition;
  return {
    ...definition,
    title: pick((e) => e.title) ?? definition.title,
    description: pick((e) => e.description) ?? definition.description,
    questions: definition.questions.map((q, i) =>
      localizeQuestion(q, (field) => pick((e) => e.questions?.[i]?.[field])),
    ),
  };
}

/**
 * Each None box's label in `locale`, picked as {@link localizeDefinition}
 * picks the definition's text, over the labels of {@link readNoneLabels}.
 */
export function localizeNoneLabels(
  labels: readonly (string | undefined)[],
  translations: ReadTranslations,
  locale: string,
): readonly (string | undefined)[] {
  const pick = picker(translations, locale);
  return pick
    ? labels.map((own, i) => pick((e) => e.questions?.[i]?.noneLabel) ?? own)
    : labels;
}

type Picker = <T>(
  get: (e: SurveyTranslation) => T | undefined,
) => T | undefined;

/** Picks a field from the entries `locale` reads; none when it reads none. */
function picker(
  translations: ReadTranslations,
  locale: string,
): Picker | undefined {
  const chain: SurveyTranslation[] = [];
  for (const tag of lookupChain(locale)) {
    if (tag === translations.defaultLanguage) break;
    const entry = translations.entries.get(tag);
    if (entry) chain.push(entry);
  }
  if (chain.length === 0) return undefined;
  return (get) => {
    for (const e of chain) {
      const v = get(e);
      if (v !== undefined) return v;
    }
    return undefined;
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
      (levels !== undefined && isLabels(entry.ratingLabels, levels))) &&
    (entry.noneLabel === undefined ||
      (hasNoneBox(q) && isNoneLabel(entry.noneLabel)))
  );
}

const isNoneLabel = (x: unknown): x is string =>
  typeof x === "string" && x !== "" && utf8ByteLength(x) <= MAX_CHUNK_BYTES;

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
