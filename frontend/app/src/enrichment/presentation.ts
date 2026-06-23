/**
 * External-content presentation: the off-chain JSON document that supplies the
 * human-readable text an external-content survey leaves off-chain.
 *
 * A survey carrying a `content_anchor` (key 8) MAY ship empty title/description/
 * prompts and `option_count` forms instead of inline labels; the anchored
 * document (the `cardano-survey-presentation` JSON profile, see the CIP) fills
 * them back in. Everything validation-relevant stays on-chain, so a survey is
 * still answerable and tallyable from on-chain data alone — only labels are
 * missing when the document is unavailable.
 *
 * This module is pure: it parses the profile and overlays it onto a
 * {@link SurveyDefinition}, producing an *enriched* copy. Fetching + hash
 * verification live in `content.ts`.
 */

import type {
  OptionsOrCount,
  Question,
  RatingScale,
  SurveyDefinition,
} from "cip-179";

/** Discriminator every presentation document must carry. */
export const PRESENTATION_KIND = "cardano-survey-presentation";

/** Per-question presentation text, in survey-definition order. */
export interface QuestionPresentation {
  readonly prompt?: string | undefined;
  /** Option labels, in option-index order. */
  readonly options?: readonly string[] | undefined;
  /** Rating level labels (for a count-form rating scale), in rating-index order. */
  readonly ratingLabels?: readonly string[] | undefined;
}

/** Parsed presentation document. Unknown fields are ignored (per the CIP). */
export interface Presentation {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly questions: readonly QuestionPresentation[];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

/**
 * Parse a fetched JSON value into a {@link Presentation}. Throws if it isn't a
 * `cardano-survey-presentation` document; tolerant of missing/extra fields
 * otherwise (a partial document still fills in whatever it provides).
 */
export function parsePresentation(json: unknown): Presentation {
  if (typeof json !== "object" || json === null) {
    throw new Error("presentation document is not a JSON object");
  }
  const obj = json as Record<string, unknown>;
  if (obj["kind"] !== PRESENTATION_KIND) {
    throw new Error(
      `presentation document has wrong kind (expected "${PRESENTATION_KIND}")`,
    );
  }
  const rawQuestions = Array.isArray(obj["questions"]) ? obj["questions"] : [];
  const questions: QuestionPresentation[] = rawQuestions.map((q) => {
    if (typeof q !== "object" || q === null) return {};
    const qo = q as Record<string, unknown>;
    return {
      prompt: asString(qo["prompt"]),
      options: asStringArray(qo["options"]),
      ratingLabels: asStringArray(qo["ratingLabels"]),
    };
  });
  return {
    title: asString(obj["title"]),
    description: asString(obj["description"]),
    questions,
  };
}

/** Fill an empty on-chain string from the presentation, otherwise keep on-chain. */
function fill(onChain: string, off: string | undefined): string {
  return onChain.trim() === "" && off ? off : onChain;
}

/**
 * Replace a `count` form with inline labels when the document supplies exactly
 * `count` of them. A length mismatch is treated as no data (keep the count form)
 * rather than risk mislabelling option indices.
 */
function fillOptions(
  o: OptionsOrCount,
  labels: readonly string[] | undefined,
): OptionsOrCount {
  return o.type === "count" && labels && labels.length === o.count
    ? { type: "options", labels: [...labels] }
    : o;
}

function fillScale(
  s: RatingScale,
  labels: readonly string[] | undefined,
): RatingScale {
  return s.type === "count" && labels && labels.length === s.count
    ? { type: "labels", labels: [...labels] }
    : s;
}

function applyQuestion(
  q: Question,
  p: QuestionPresentation | undefined,
): Question {
  const prompt = fill(q.prompt, p?.prompt);
  switch (q.type) {
    case "custom":
    case "numericRange":
      return { ...q, prompt };
    case "singleChoice":
    case "multiSelect":
    case "ranking":
    case "pointsAllocation":
      return { ...q, prompt, options: fillOptions(q.options, p?.options) };
    case "rating":
      return {
        ...q,
        prompt,
        options: fillOptions(q.options, p?.options),
        scale: fillScale(q.scale, p?.ratingLabels),
      };
  }
}

/**
 * Overlay a presentation document onto a definition, returning an enriched copy.
 * Only empty title/description/prompts and `count`-form options/scales are
 * filled; on-chain values always win where present, so the result is safe to use
 * everywhere the original definition is (indices, constraints, owner, mode are
 * untouched — only labels change).
 */
export function applyPresentation(
  def: SurveyDefinition,
  pres: Presentation,
): SurveyDefinition {
  return {
    ...def,
    title: fill(def.title, pres.title),
    description: fill(def.description, pres.description),
    questions: def.questions.map((q, i) => applyQuestion(q, pres.questions[i])),
  };
}
