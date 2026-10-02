/**
 * Pure logic for composing a survey definition (the Create builder).
 *
 * The builder keeps a flat, "wide" {@link QuestionDraft} per question — every
 * type-specific field lives on the same object, so switching a question's type
 * preserves shared fields (prompt, required) and the inputs stay controlled.
 * This module projects those drafts into typed CIP-179 {@link Question}s and a
 * full {@link SurveyDefinition}, collecting structured problems along the way
 * (input the form cannot turn into a definition) and then deferring to the
 * codec's own {@link validateDefinition} for the semantic invariants.
 *
 * No framework, no I/O — every function here is unit-testable in isolation.
 */

import {
  Role,
  SPEC_VERSION,
  validateDefinition,
  type ContentAnchor,
  type Credential,
  type NumericConstraints,
  type OptionsOrCount,
  type Question,
  type RatingScale,
  type SurveyDefinition,
  type ValidationProblem,
} from "cip-179";

import { bytesToHex, hexToBytes } from "cip-179/domain";
import {
  PRESENTATION_KIND,
  applyPresentation,
  type Presentation,
} from "~/enrichment/presentation";
import { METADATA_INT_MAX } from "~/domain/detailedJson";
import { QUICKNET_CHAIN_HASH, maxPlaintextSize } from "cip-179/tlock";

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
  // Every number is kept as typed, so partial input doesn't fight the parser;
  // `buildDefinition` parses it.
  // multiSelect
  minSelections: string;
  maxSelections: string;
  // ranking
  minRanked: string;
  maxRanked: string;
  // numericRange and pointsAllocation
  numMin: string;
  numMax: string;
  numStep: string;
  budget: string;
  // rating
  ratingScale: "numeric" | "labels";
  ratingLabels: string[];
  ratingMin: string;
  ratingMax: string;
  ratingStep: string;
  /** CIP-179 v5 require_all: when true a present answer must rate every option. */
  requireAll: boolean;
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
   * Drand round at which sealed responses become decryptable, as text. Set by
   * the screen (from the end epoch, or as entered manually); ignored for public
   * surveys.
   */
  sealedRound: string;
  /**
   * Minimum plaintext byte length each sealed response is padded to, as text.
   * Blank means **auto**: `buildDefinition` sizes it to the worst-case
   * fully-answered response (see {@link maxPlaintextSize}). Ignored for public
   * surveys.
   */
  sealedPadding: string;
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

/** Builder metadata before anything is typed. */
export function initDefinitionMeta(): DefinitionMeta {
  return {
    title: "",
    description: "",
    eligibleRoles: [Role.Stakeholder],
    contentMode: "embedded",
    endEpoch: "",
    mode: "public",
    sealedRound: "",
    sealedPadding: "",
  };
}

/** A fresh draft for a new question of the given type. */
export function initQuestionDraft(type: QuestionType): QuestionDraft {
  return {
    type,
    prompt: "",
    required: false,
    labels: ["", ""],
    minSelections: "0",
    maxSelections: "2",
    minRanked: "1",
    maxRanked: "2",
    numMin: "0",
    numMax: "10",
    numStep: "",
    budget: "100",
    ratingScale: "numeric",
    ratingLabels: ["", ""],
    ratingMin: "1",
    ratingMax: "5",
    ratingStep: "",
    requireAll: true,
    customUri: "",
    customHash: "",
  };
}

/**
 * Switch a draft's type, keeping every field. Each type only reads the fields it
 * needs at projection time (see {@link toQuestion}), so the now-irrelevant
 * ones are simply ignored rather than cleared — and the user's input is kept if
 * they switch back.
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
// Form problems
// ----------------------------------------------------------------------------

/** The inputs a {@link FormProblem} can point at. */
export type FormField =
  | "endEpoch"
  | "revealRound"
  | "padding"
  | "min"
  | "max"
  | "step"
  | "budget"
  | "minSelections"
  | "maxSelections"
  | "minRanked"
  | "maxRanked"
  | "customUri"
  | "customHash";

export const FORM_PROBLEM_CODES = [
  "form.notWholeNumber",
  "form.outOfRange",
  "form.notHex",
  "form.hashLength",
  "form.missing",
] as const;

export type FormProblemCode = (typeof FORM_PROBLEM_CODES)[number];

/**
 * Input the form cannot turn into a definition. `question` is the 0-based
 * index of the question holding `field`, absent for survey-level fields.
 */
export interface FormProblem {
  readonly code: FormProblemCode;
  readonly field: FormField;
  readonly question?: number;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * A single publish-blocking problem: the form's own, or one of the codec's
 * semantic problems. Both are structured; the caller renders them in its own
 * locale (see `~/i18n/problem`).
 */
export type CreateProblem = FormProblem | ValidationProblem;

type At = Pick<FormProblem, "field" | "question">;

// ----------------------------------------------------------------------------
// Parsing helpers (push a problem and return undefined on failure)
// ----------------------------------------------------------------------------

/** A whole number within [lo, hi], as typed: digits with an optional sign. */
function parseWhole(
  text: string,
  lo: bigint,
  hi: bigint,
  at: At,
  out: FormProblem[],
): bigint | undefined {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    out.push({ ...at, code: "form.notWholeNumber", params: { text } });
    return undefined;
  }
  const n = BigInt(t);
  if (n < lo || n > hi) {
    out.push({
      ...at,
      code: "form.outOfRange",
      params: { text: t, min: String(lo), max: String(hi) },
    });
    return undefined;
  }
  return n;
}

/** A survey written here must export to a file cardano-cli accepts. */
function parseBig(
  text: string,
  at: At,
  out: FormProblem[],
): bigint | undefined {
  return parseWhole(text, -METADATA_INT_MAX, METADATA_INT_MAX, at, out);
}

/** A non-negative whole number held as a JS number (counts, epochs, rounds). */
function parseCount(
  text: string,
  at: At,
  out: FormProblem[],
): number | undefined {
  const n = parseWhole(text, 0n, BigInt(Number.MAX_SAFE_INTEGER), at, out);
  return n === undefined ? undefined : Number(n);
}

function parseConstraints(
  min: string,
  max: string,
  step: string,
  question: number,
  out: FormProblem[],
): NumericConstraints | undefined {
  const lo = parseBig(min, { field: "min", question }, out);
  const hi = parseBig(max, { field: "max", question }, out);
  if (step.trim() === "") {
    return lo === undefined || hi === undefined
      ? undefined
      : { min: lo, max: hi };
  }
  const st = parseBig(step, { field: "step", question }, out);
  return lo === undefined || hi === undefined || st === undefined
    ? undefined
    : { min: lo, max: hi, step: st };
}

function parseHash(
  hex: string,
  at: At,
  out: FormProblem[],
): Uint8Array | undefined {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex.trim());
  } catch {
    out.push({ ...at, code: "form.notHex" });
    return undefined;
  }
  if (bytes.length !== 32) {
    out.push({ ...at, code: "form.hashLength" });
    return undefined;
  }
  return bytes;
}

/** Inline option labels, trimmed; blank rows are dropped (count enforced later). */
function inlineLabels(labels: readonly string[]): string[] {
  return labels.map((l) => l.trim()).filter((l) => l !== "");
}

// ----------------------------------------------------------------------------
// Projection: draft -> Question
// ----------------------------------------------------------------------------

/**
 * A draft as a {@link Question}, or undefined when one of its fields does not
 * parse (the problem is pushed to `out`).
 */
function toQuestion(
  draft: QuestionDraft,
  question: number,
  external: boolean,
  out: FormProblem[],
): Question | undefined {
  // External-content mode moves prompts/labels off-chain: the prompt is blank
  // and option/level lists collapse to bare counts (the presentation document
  // supplies the text). Embedded mode keeps everything inline.
  const prompt = external ? "" : draft.prompt.trim();
  // Absent when false, as the decoder reads it.
  const base = { prompt, ...(draft.required ? { required: true } : {}) };
  const opts = (labels: readonly string[]): OptionsOrCount => {
    const inline = inlineLabels(labels);
    return external
      ? { type: "count", count: inline.length }
      : { type: "options", labels: inline };
  };
  const count = (text: string, field: FormField) =>
    parseCount(text, { field, question }, out);
  switch (draft.type) {
    case "custom": {
      const uri = draft.customUri.trim();
      if (uri === "")
        out.push({ code: "form.missing", field: "customUri", question });
      const hash = parseHash(
        draft.customHash,
        { field: "customHash", question },
        out,
      );
      if (uri === "" || hash === undefined) return undefined;
      return { ...base, type: "custom", methodSchema: { uri, hash } };
    }
    case "singleChoice":
      return { ...base, type: "singleChoice", options: opts(draft.labels) };
    case "multiSelect": {
      const minSelections = count(draft.minSelections, "minSelections");
      const maxSelections = count(draft.maxSelections, "maxSelections");
      if (minSelections === undefined || maxSelections === undefined)
        return undefined;
      return {
        ...base,
        type: "multiSelect",
        options: opts(draft.labels),
        minSelections,
        maxSelections,
      };
    }
    case "ranking": {
      const minRanked = count(draft.minRanked, "minRanked");
      const maxRanked = count(draft.maxRanked, "maxRanked");
      if (minRanked === undefined || maxRanked === undefined) return undefined;
      return {
        ...base,
        type: "ranking",
        options: opts(draft.labels),
        minRanked,
        maxRanked,
      };
    }
    case "numericRange": {
      const constraints = parseConstraints(
        draft.numMin,
        draft.numMax,
        draft.numStep,
        question,
        out,
      );
      if (constraints === undefined) return undefined;
      return { ...base, type: "numericRange", constraints };
    }
    case "pointsAllocation": {
      const budget = parseBig(draft.budget, { field: "budget", question }, out);
      if (budget === undefined) return undefined;
      return {
        ...base,
        type: "pointsAllocation",
        options: opts(draft.labels),
        budget,
      };
    }
    case "rating": {
      let scale: RatingScale;
      if (draft.ratingScale === "labels") {
        scale = external
          ? { type: "count", count: inlineLabels(draft.ratingLabels).length }
          : { type: "labels", labels: inlineLabels(draft.ratingLabels) };
      } else {
        const constraints = parseConstraints(
          draft.ratingMin,
          draft.ratingMax,
          draft.ratingStep,
          question,
          out,
        );
        if (constraints === undefined) return undefined;
        scale = { type: "numeric", constraints };
      }
      return {
        ...base,
        type: "rating",
        options: opts(draft.labels),
        scale,
        requireAll: draft.requireAll,
      };
    }
  }
}

// ----------------------------------------------------------------------------
// Projection: drafts + meta -> SurveyDefinition (+ problems)
// ----------------------------------------------------------------------------

/**
 * Owner of a definition built while no connected wallet can own it: the form
 * still validates and exports, and publishing waits for a wallet's key. A
 * transaction cannot prove this credential, so a definition carrying it is one
 * every reader ignores.
 */
export const PLACEHOLDER_OWNER: Credential = {
  type: "key",
  keyHash: new Uint8Array(28),
};

/**
 * Placeholder anchor used to *preview/validate* an external-content definition
 * before its presentation document is pinned. Its only job is to make
 * `contentAnchor` present so the codec accepts count forms; the real anchor
 * (from {@link buildPresentationDoc} → pin) is injected at publish time. Never
 * publish a definition built with this — rebuild with the real anchor first.
 * An exported file keeps its URI, with the document's real hash.
 */
export const PLACEHOLDER_ANCHOR: ContentAnchor = {
  uri: "ipfs://pending",
  hash: new Uint8Array(32),
};

/**
 * Build a {@link SurveyDefinition} from builder state. The definition is
 * returned only when every field parses, so it is always the form's; until
 * then `problems` holds the form's own problems alone. Once it parses,
 * `problems` holds the codec's semantic problems, and the definition is
 * publishable iff there are none.
 *
 * Produces public or sealed (tlock commit-reveal) surveys; sealed mode pins the
 * drand quicknet chain and carries the reveal round + padding from `meta`.
 * `owner` must be a key credential the connected wallet controls so it can
 * later prove ownership for a cancellation.
 */
export function buildDefinition(
  owner: Credential,
  meta: DefinitionMeta,
  drafts: readonly QuestionDraft[],
  opts: {
    contentAnchor?: ContentAnchor | undefined;
    /** Chain-tip epoch, when known — enables the CIP-179 end_epoch rule below. */
    tipEpoch?: number | undefined;
  } = {},
): { definition?: SurveyDefinition; problems: CreateProblem[] } {
  const problems: FormProblem[] = [];
  const external = meta.contentMode === "external";
  const sealed = meta.mode === "sealed";
  const { contentAnchor, tipEpoch } = opts;

  const endEpoch = parseCount(meta.endEpoch, { field: "endEpoch" }, problems);
  const round = sealed
    ? parseCount(meta.sealedRound, { field: "revealRound" }, problems)
    : undefined;
  const padding =
    sealed && meta.sealedPadding.trim() !== ""
      ? parseCount(meta.sealedPadding, { field: "padding" }, problems)
      : undefined;
  const parsed = drafts.map((d, i) => toQuestion(d, i, external, problems));
  if (
    problems.length > 0 ||
    endEpoch === undefined ||
    (sealed && round === undefined)
  )
    return { problems };
  const questions = parsed.filter((q) => q !== undefined);

  // CIP-179 §Epoch Semantics: end_epoch MUST be past the epoch the definition
  // is included in. Publishing one that isn't buys a survey no conformant
  // reader — this one included — will ever tally. Reported with the codec's own
  // problem code, since it is the same rule the read side gates on.
  const epochProblems: ValidationProblem[] =
    tipEpoch !== undefined && endEpoch <= tipEpoch
      ? [
          {
            code: "definition.endEpochNotAfterInclusion",
            params: { endEpoch, inclusionEpoch: tipEpoch },
          },
        ]
      : [];

  const definition: SurveyDefinition = {
    specVersion: SPEC_VERSION,
    owner,
    // External mode moves title/description into the presentation document.
    title: external ? "" : meta.title.trim(),
    description: external ? "" : meta.description.trim(),
    eligibleRoles: [...meta.eligibleRoles].sort((a, b) => a - b),
    endEpoch,
    submissionMode:
      round !== undefined
        ? {
            type: "sealed",
            chainHash: QUICKNET_CHAIN_HASH,
            round,
            paddingSize: padding ?? maxPlaintextSize(questions),
          }
        : { type: "public" },
    questions,
    ...(external ? { contentAnchor: contentAnchor ?? PLACEHOLDER_ANCHOR } : {}),
  };

  return {
    definition,
    problems: [...epochProblems, ...validateDefinition(definition)],
  };
}

/**
 * The form that builds `def`: the inverse of {@link buildDefinition}, with the
 * text of an external-content survey taken from its presentation document.
 *
 * What the form does not hold is left out: the owner and content anchor (the
 * wallet and pinning supply them at publish time), the drand chain (the form
 * writes quicknet, the only one a sealed survey can be revealed on) and the
 * reveal round (the screen derives it, as after a reload). A padding equal to
 * the automatic size comes back blank, so it keeps following the questions.
 *
 * Text the document does not supply, or does not supply in full, comes back
 * blank: a prompt as "", a count form as that many blank labels.
 */
export function formFromDefinition(
  def: SurveyDefinition,
  presentation?: Presentation,
): {
  meta: Omit<DefinitionMeta, "sealedRound">;
  questions: QuestionDraft[];
} {
  const text = presentation ? applyPresentation(def, presentation) : def;
  const mode = def.submissionMode;
  return {
    meta: {
      title: text.title,
      description: text.description,
      eligibleRoles: [...def.eligibleRoles],
      contentMode: def.contentAnchor ? "external" : "embedded",
      endEpoch: String(def.endEpoch),
      mode: mode.type,
      sealedPadding:
        mode.type === "sealed" &&
        mode.paddingSize !== maxPlaintextSize(def.questions)
          ? String(mode.paddingSize)
          : "",
    },
    questions: text.questions.map(questionDraft),
  };
}

const blanks = (count: number): string[] => Array<string>(count).fill("");

const labelsOf = (o: OptionsOrCount): string[] =>
  o.type === "options" ? [...o.labels] : blanks(o.count);

function questionDraft(q: Question): QuestionDraft {
  const draft: QuestionDraft = {
    ...initQuestionDraft(q.type),
    prompt: q.prompt,
    required: q.required ?? false,
  };
  const range = (c: NumericConstraints) => ({
    min: String(c.min),
    max: String(c.max),
    step: c.step === undefined ? "" : String(c.step),
  });
  switch (q.type) {
    case "custom":
      return {
        ...draft,
        customUri: q.methodSchema.uri,
        customHash: bytesToHex(q.methodSchema.hash),
      };
    case "singleChoice":
      return { ...draft, labels: labelsOf(q.options) };
    case "multiSelect":
      return {
        ...draft,
        labels: labelsOf(q.options),
        minSelections: String(q.minSelections),
        maxSelections: String(q.maxSelections),
      };
    case "ranking":
      return {
        ...draft,
        labels: labelsOf(q.options),
        minRanked: String(q.minRanked),
        maxRanked: String(q.maxRanked),
      };
    case "numericRange": {
      const { min, max, step } = range(q.constraints);
      return { ...draft, numMin: min, numMax: max, numStep: step };
    }
    case "pointsAllocation":
      return {
        ...draft,
        labels: labelsOf(q.options),
        budget: String(q.budget),
      };
    case "rating": {
      const rated = {
        ...draft,
        labels: labelsOf(q.options),
        requireAll: q.requireAll,
      };
      if (q.scale.type !== "numeric")
        return {
          ...rated,
          ratingScale: "labels",
          ratingLabels:
            q.scale.type === "labels"
              ? [...q.scale.labels]
              : blanks(q.scale.count),
        };
      const { min, max, step } = range(q.scale.constraints);
      return {
        ...rated,
        ratingScale: "numeric",
        ratingMin: min,
        ratingMax: max,
        ratingStep: step,
      };
    }
  }
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
