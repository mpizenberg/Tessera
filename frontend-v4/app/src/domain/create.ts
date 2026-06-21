/**
 * Pure logic for composing a survey definition (the Create builder).
 *
 * The builder keeps a flat, "wide" {@link QuestionDraft} per question — every
 * type-specific field lives on the same object, so switching a question's type
 * preserves shared fields (prompt, required) and the inputs stay controlled.
 * This module projects those drafts into typed CIP-179 {@link Question}s and a
 * full {@link SurveyDefinition}, collecting human-readable problems along the
 * way (parse failures the codec can't express) and then deferring to the codec's
 * own {@link validateDefinition} for the semantic invariants.
 *
 * No framework, no I/O — every function here is unit-testable in isolation.
 * This layer only builds inline-content surveys (labels supplied on-chain);
 * external-content mode (option counts + an anchor) is out of scope here.
 */

import {
  SPEC_VERSION,
  validateDefinition,
  type Credential,
  type NumericConstraints,
  type Question,
  type RatingScale,
  type Role,
  type SurveyDefinition,
} from "cip-179";

import { hexToBytes } from "~/util/hex";

/** The question types the builder can author (all of them). */
export type QuestionType = Question["type"];

/**
 * One question's working state. Fields not relevant to the current `type` are
 * simply ignored when projecting to a {@link Question}; keeping them around lets
 * the user flip types without losing what they typed.
 */
export interface QuestionDraft {
  type: QuestionType;
  prompt: string;
  required: boolean;
  /** Inline option labels (single/multi/ranking/points/rating). */
  labels: string[];
  // multiSelect
  minSelections: number;
  maxSelections: number;
  // ranking
  minRanked: number;
  maxRanked: number;
  // numericRange (kept as strings so partial input doesn't fight the parser)
  numMin: string;
  numMax: string;
  numStep: string;
  // pointsAllocation
  budget: number;
  // rating
  ratingScale: "numeric" | "labels";
  ratingLabels: string[];
  ratingMin: string;
  ratingMax: string;
  ratingStep: string;
  // custom
  customUri: string;
  customHash: string;
}

/** Builder-level survey metadata (everything that isn't a question). */
export interface DefinitionMeta {
  title: string;
  description: string;
  eligibleRoles: Role[];
  /** End epoch as raw input text; parsed at build time. */
  endEpoch: string;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  custom: "Custom",
  singleChoice: "Single choice",
  multiSelect: "Multi-select",
  ranking: "Ranking",
  numericRange: "Numeric range",
  pointsAllocation: "Points allocation",
  rating: "Rating",
};

/** Display label for a question type (builder type picker). */
export function questionTypeLabel(t: QuestionType): string {
  return TYPE_LABELS[t];
}

/** Every authorable question type, in tag order (custom last). */
export const QUESTION_TYPES: readonly QuestionType[] = [
  "singleChoice",
  "multiSelect",
  "ranking",
  "numericRange",
  "pointsAllocation",
  "rating",
  "custom",
];

/** A fresh draft for a new question of the given type. */
export function initQuestionDraft(type: QuestionType): QuestionDraft {
  return {
    type,
    prompt: "",
    required: false,
    labels: ["", ""],
    minSelections: 1,
    maxSelections: 1,
    minRanked: 1,
    maxRanked: 2,
    numMin: "0",
    numMax: "10",
    numStep: "",
    budget: 100,
    ratingScale: "numeric",
    ratingLabels: ["", ""],
    ratingMin: "1",
    ratingMax: "5",
    ratingStep: "",
    customUri: "",
    customHash: "",
  };
}

/**
 * Switch a draft's type, preserving shared fields (prompt, required, labels) and
 * resetting only what the new type needs that the draft can't already provide.
 */
export function withType(draft: QuestionDraft, type: QuestionType): QuestionDraft {
  return { ...draft, type };
}

/** Does this question type carry an inline list of option labels? */
export function usesOptions(type: QuestionType): boolean {
  return (
    type === "singleChoice" ||
    type === "multiSelect" ||
    type === "ranking" ||
    type === "pointsAllocation" ||
    type === "rating"
  );
}

// ----------------------------------------------------------------------------
// Parsing helpers (push a problem + return a fallback on failure)
// ----------------------------------------------------------------------------

function parseBig(text: string, where: string, out: string[]): bigint {
  const t = text.trim();
  try {
    if (!/^[+-]?\d+$/.test(t)) throw new Error("not an integer");
    return BigInt(t);
  } catch {
    out.push(`${where}: "${text}" is not a whole number`);
    return 0n;
  }
}

function parseConstraints(
  min: string,
  max: string,
  step: string,
  where: string,
  out: string[],
): NumericConstraints {
  const lo = parseBig(min, `${where} min`, out);
  const hi = parseBig(max, `${where} max`, out);
  if (step.trim() === "") return { min: lo, max: hi };
  return { min: lo, max: hi, step: parseBig(step, `${where} step`, out) };
}

function parseHash(hex: string, where: string, out: string[]): Uint8Array {
  const t = hex.trim();
  try {
    const bytes = hexToBytes(t);
    if (bytes.length !== 32) {
      out.push(`${where}: must be a 32-byte blake2b-256 hash (64 hex chars)`);
    }
    return bytes;
  } catch {
    out.push(`${where}: not valid hex`);
    return new Uint8Array(0);
  }
}

/** Inline option labels, trimmed; blank rows are dropped (count enforced later). */
function inlineLabels(labels: readonly string[]): string[] {
  return labels.map((l) => l.trim()).filter((l) => l !== "");
}

// ----------------------------------------------------------------------------
// Projection: draft -> Question
// ----------------------------------------------------------------------------

function toQuestion(draft: QuestionDraft, where: string, out: string[]): Question {
  const base = { prompt: draft.prompt.trim(), required: draft.required };
  switch (draft.type) {
    case "custom": {
      if (draft.customUri.trim() === "") {
        out.push(`${where}: custom question needs a method-schema URI`);
      }
      return {
        ...base,
        type: "custom",
        methodSchema: {
          uri: draft.customUri.trim(),
          hash: parseHash(draft.customHash, `${where} schema hash`, out),
        },
      };
    }
    case "singleChoice":
      return {
        ...base,
        type: "singleChoice",
        options: { type: "options", labels: inlineLabels(draft.labels) },
      };
    case "multiSelect":
      return {
        ...base,
        type: "multiSelect",
        options: { type: "options", labels: inlineLabels(draft.labels) },
        minSelections: draft.minSelections,
        maxSelections: draft.maxSelections,
      };
    case "ranking":
      return {
        ...base,
        type: "ranking",
        options: { type: "options", labels: inlineLabels(draft.labels) },
        minRanked: draft.minRanked,
        maxRanked: draft.maxRanked,
      };
    case "numericRange":
      return {
        ...base,
        type: "numericRange",
        constraints: parseConstraints(
          draft.numMin,
          draft.numMax,
          draft.numStep,
          where,
          out,
        ),
      };
    case "pointsAllocation":
      return {
        ...base,
        type: "pointsAllocation",
        options: { type: "options", labels: inlineLabels(draft.labels) },
        budget: draft.budget,
      };
    case "rating": {
      const scale: RatingScale =
        draft.ratingScale === "labels"
          ? { type: "labels", labels: inlineLabels(draft.ratingLabels) }
          : {
              type: "numeric",
              constraints: parseConstraints(
                draft.ratingMin,
                draft.ratingMax,
                draft.ratingStep,
                `${where} scale`,
                out,
              ),
            };
      return {
        ...base,
        type: "rating",
        options: { type: "options", labels: inlineLabels(draft.labels) },
        scale,
      };
    }
  }
}

// ----------------------------------------------------------------------------
// Projection: drafts + meta -> SurveyDefinition (+ problems)
// ----------------------------------------------------------------------------

/**
 * Build a {@link SurveyDefinition} from builder state. Always returns a
 * structurally-complete definition (parse failures fall back to safe defaults so
 * the codec validator can still run); `problems` is the concatenation of parse
 * problems and the codec's semantic problems. The definition is publishable iff
 * `problems` is empty.
 *
 * Only public (plaintext) surveys are produced here; sealed mode is a later
 * milestone. `owner` must be a key credential the connected wallet controls so
 * it can later prove ownership for a cancellation.
 */
export function buildDefinition(
  owner: Credential,
  meta: DefinitionMeta,
  drafts: readonly QuestionDraft[],
): { definition: SurveyDefinition; problems: string[] } {
  const problems: string[] = [];

  const endEpoch = parseEndEpoch(meta.endEpoch, problems);
  const questions = drafts.map((d, i) =>
    toQuestion(d, `Q${i + 1}`, problems),
  );

  const definition: SurveyDefinition = {
    specVersion: SPEC_VERSION,
    owner,
    title: meta.title.trim(),
    description: meta.description.trim(),
    eligibleRoles: [...meta.eligibleRoles].sort((a, b) => a - b),
    endEpoch,
    submissionMode: { type: "public" },
    questions,
  };

  problems.push(...validateDefinition(definition));
  return { definition, problems };
}

function parseEndEpoch(text: string, out: string[]): number {
  const t = text.trim();
  const n = Number(t);
  if (t === "" || !Number.isInteger(n) || n < 0) {
    out.push("end epoch must be a non-negative whole number");
    return 0;
  }
  return n;
}
