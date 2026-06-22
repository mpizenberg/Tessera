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
  type ContentAnchor,
  type Credential,
  type NumericConstraints,
  type OptionsOrCount,
  type Question,
  type RatingScale,
  type Role,
  type SurveyDefinition,
} from "cip-179";

import { hexToBytes } from "~/util/hex";
import { PRESENTATION_KIND } from "~/enrichment/presentation";
import { QUICKNET_CHAIN_HASH } from "~/tlock/drand";
import { maxPlaintextSize } from "~/tlock/padding";

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
  /**
   * Where the human-readable text lives: `embedded` (title/description/prompts/
   * labels on-chain) or `external` (off-chain in a pinned presentation document,
   * on-chain carries only a content anchor + option/level counts). External keeps
   * the chain payload small for large surveys; embedded has no off-chain deps.
   */
  contentMode: "embedded" | "external";
  /** End epoch as raw input text; parsed at build time. */
  endEpoch: string;
  /** Public (plaintext) or sealed (tlock commit-reveal) responses. */
  mode: "public" | "sealed";
  /**
   * Resolved drand round at which sealed responses become decryptable. Computed
   * by the screen (from the end epoch, or entered manually) and passed in;
   * ignored for public surveys.
   */
  sealedRound: number;
  /**
   * Minimum plaintext byte length each sealed response is padded to. `0` (or
   * any non-positive value) means **auto**: `buildDefinition` sizes it to the
   * worst-case fully-answered response (see {@link maxPlaintextSize}). Ignored
   * for public surveys.
   */
  sealedPadding: number;
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
    minSelections: 0,
    maxSelections: 2,
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
export function withType(
  draft: QuestionDraft,
  type: QuestionType,
): QuestionDraft {
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

function toQuestion(
  draft: QuestionDraft,
  where: string,
  external: boolean,
  out: string[],
): Question {
  // External-content mode moves prompts/labels off-chain: the prompt is blank
  // and option/level lists collapse to bare counts (the presentation document
  // supplies the text). Embedded mode keeps everything inline.
  const prompt = external ? "" : draft.prompt.trim();
  const base = { prompt, required: draft.required };
  const opts = (labels: readonly string[]): OptionsOrCount => {
    const inline = inlineLabels(labels);
    return external
      ? { type: "count", count: inline.length }
      : { type: "options", labels: inline };
  };
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
      return { ...base, type: "singleChoice", options: opts(draft.labels) };
    case "multiSelect":
      return {
        ...base,
        type: "multiSelect",
        options: opts(draft.labels),
        minSelections: draft.minSelections,
        maxSelections: draft.maxSelections,
      };
    case "ranking":
      return {
        ...base,
        type: "ranking",
        options: opts(draft.labels),
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
        options: opts(draft.labels),
        budget: draft.budget,
      };
    case "rating": {
      const scale: RatingScale =
        draft.ratingScale === "labels"
          ? external
            ? { type: "count", count: inlineLabels(draft.ratingLabels).length }
            : { type: "labels", labels: inlineLabels(draft.ratingLabels) }
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
        options: opts(draft.labels),
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
 * Produces public or sealed (tlock commit-reveal) surveys; sealed mode pins the
 * drand quicknet chain and carries the resolved reveal round + padding from
 * `meta`. `owner` must be a key credential the connected wallet controls so it
 * can later prove ownership for a cancellation.
 */
/**
 * Placeholder anchor used to *preview/validate* an external-content definition
 * before its presentation document is pinned. Its only job is to make
 * `contentAnchor` present so the codec accepts count forms; the real anchor
 * (from {@link buildPresentationDoc} → pin) is injected at publish time. Never
 * encode a definition built with this — rebuild with the real anchor first.
 */
const PLACEHOLDER_ANCHOR: ContentAnchor = {
  uri: "ipfs://pending",
  hash: new Uint8Array(32),
};

export function buildDefinition(
  owner: Credential,
  meta: DefinitionMeta,
  drafts: readonly QuestionDraft[],
  contentAnchor?: ContentAnchor,
): { definition: SurveyDefinition; problems: string[] } {
  const problems: string[] = [];
  const external = meta.contentMode === "external";

  const endEpoch = parseEndEpoch(meta.endEpoch, problems);
  const questions = drafts.map((d, i) =>
    toQuestion(d, `Q${i + 1}`, external, problems),
  );

  const definition: SurveyDefinition = {
    specVersion: SPEC_VERSION,
    owner,
    // External mode moves title/description into the presentation document.
    title: external ? "" : meta.title.trim(),
    description: external ? "" : meta.description.trim(),
    eligibleRoles: [...meta.eligibleRoles].sort((a, b) => a - b),
    endEpoch,
    submissionMode:
      meta.mode === "sealed"
        ? {
            type: "sealed",
            chainHash: QUICKNET_CHAIN_HASH,
            round: meta.sealedRound,
            paddingSize:
              meta.sealedPadding > 0
                ? meta.sealedPadding
                : maxPlaintextSize(questions),
          }
        : { type: "public" },
    questions,
    ...(external ? { contentAnchor: contentAnchor ?? PLACEHOLDER_ANCHOR } : {}),
  };

  problems.push(...validateDefinition(definition));
  return { definition, problems };
}

/** The off-chain presentation document (JSON) for an external-content survey. */
export interface PresentationDoc {
  readonly specVersion: number;
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly questions: ReadonlyArray<{
    readonly prompt: string;
    readonly options?: string[];
    readonly ratingLabels?: string[];
  }>;
}

/**
 * Project builder state into the presentation document that external mode pins
 * off-chain — the inverse of `applyPresentation`'s overlay. Option/rating-label
 * arrays use the same trim+drop-blank rule as the on-chain counts, so lengths
 * line up and the reader can re-attach labels to indices.
 */
export function buildPresentationDoc(
  meta: DefinitionMeta,
  drafts: readonly QuestionDraft[],
): PresentationDoc {
  return {
    specVersion: SPEC_VERSION,
    kind: PRESENTATION_KIND,
    title: meta.title.trim(),
    description: meta.description.trim(),
    questions: drafts.map((d) => ({
      prompt: d.prompt.trim(),
      ...(usesOptions(d.type) ? { options: inlineLabels(d.labels) } : {}),
      ...(d.type === "rating" && d.ratingScale === "labels"
        ? { ratingLabels: inlineLabels(d.ratingLabels) }
        : {}),
    })),
  };
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
