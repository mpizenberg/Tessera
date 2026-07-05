/**
 * Semantic validation of CIP-179 structures.
 *
 * These functions check the cross-field invariants the CDDL cannot express
 * (option-count bounds, abstain/required rules, points summing to budget, ...).
 * They are pure and return a list of human-readable problems; an empty list
 * means valid. They do NOT check anything requiring ledger state (credential
 * proofs, role membership, epochs, cancellation, dedup) — that is the
 * responsibility of an indexer with chain access.
 *
 * RULESET-PINNED BEHAVIOR: the "validity" rule in `@tessera/core`'s
 * `RULESET_DESCRIPTOR` is exactly "the response passes this validation against
 * the on-chain definition", and that descriptor's hash is baked into every
 * tally artifact. The emitter freezes a response's `wellFormed` verdict at
 * validation time; an independent verifier re-runs whatever `validateResponse`
 * ships when it runs. So any change that flips a response from valid to invalid
 * (or back) is a semantic ruleset change: bump `rulesetVersion` in
 * `packages/core/src/artifact.ts` and update the golden hash in
 * `artifact.test.ts` in the same commit, or old artifacts silently stop
 * reproducing (a MISMATCH that reads as tampering, not as a rules upgrade).
 *
 * @module
 */

import { SPEC_VERSION } from "./constants.js";
import { MAX_CHUNK_BYTES, utf8ByteLength } from "./metadatum.js";
import type {
  AnswerItem,
  NumericConstraints,
  OptionsOrCount,
  Question,
  RatingScale,
  SurveyDefinition,
  SurveyResponse,
} from "./types.js";

/** Number of options a question offers (inline labels or external count). */
const optionCount = (opts: OptionsOrCount): number =>
  opts.type === "options" ? opts.labels.length : opts.count;

const hasDuplicates = (xs: readonly number[]): boolean =>
  new Set(xs).size !== xs.length;

const inRange = (x: number, n: number): boolean => x >= 0 && x < n;

/** Flag any `bounded_text` label over the 64 UTF-8 byte CDDL limit. */
const checkLabels = (labels: readonly string[], where: string, out: string[]) =>
  labels.forEach((l, i) => {
    if (utf8ByteLength(l) > MAX_CHUNK_BYTES) {
      out.push(`${where}: label ${i} exceeds ${MAX_CHUNK_BYTES} UTF-8 bytes`);
    }
  });

// ----------------------------------------------------------------------------
// Definition validation
// ----------------------------------------------------------------------------

const validateOptionsOrCount = (
  opts: OptionsOrCount,
  externalMode: boolean,
  where: string,
  out: string[],
): void => {
  if (opts.type === "options") {
    if (opts.labels.length < 2) out.push(`${where}: needs at least 2 options`);
    checkLabels(opts.labels, where, out);
  } else {
    if (opts.count < 2) out.push(`${where}: option count must be >= 2`);
    if (!externalMode) {
      out.push(
        `${where}: option-count form requires external-content mode (key 8)`,
      );
    }
  }
};

const validateNumericConstraints = (
  c: NumericConstraints,
  where: string,
  out: string[],
): void => {
  if (c.max < c.min) out.push(`${where}: max_value must be >= min_value`);
  if (c.step !== undefined && c.step <= 0n)
    out.push(`${where}: step must be > 0`);
};

const validateRatingScale = (
  scale: RatingScale,
  externalMode: boolean,
  where: string,
  out: string[],
): void => {
  switch (scale.type) {
    case "numeric":
      validateNumericConstraints(scale.constraints, `${where} scale`, out);
      break;
    case "labels":
      if (scale.labels.length < 2) {
        out.push(`${where}: rating scale needs at least 2 labels`);
      }
      checkLabels(scale.labels, `${where} scale`, out);
      break;
    case "count":
      if (scale.count < 2)
        out.push(`${where}: rating level count must be >= 2`);
      if (!externalMode) {
        out.push(
          `${where}: rating level-count form requires external-content mode`,
        );
      }
      break;
  }
};

const validateQuestion = (
  q: Question,
  externalMode: boolean,
  where: string,
  out: string[],
): void => {
  switch (q.type) {
    case "custom":
      break;
    case "singleChoice":
      validateOptionsOrCount(q.options, externalMode, where, out);
      break;
    case "multiSelect": {
      validateOptionsOrCount(q.options, externalMode, where, out);
      const n = optionCount(q.options);
      if (q.minSelections < 0)
        out.push(`${where}: min_selections must be >= 0`);
      if (q.maxSelections < 1)
        out.push(`${where}: max_selections must be >= 1`);
      if (q.minSelections > q.maxSelections) {
        out.push(`${where}: min_selections must be <= max_selections`);
      }
      if (q.maxSelections > n) {
        out.push(
          `${where}: max_selections must be <= number of options (${n})`,
        );
      }
      break;
    }
    case "ranking": {
      validateOptionsOrCount(q.options, externalMode, where, out);
      const n = optionCount(q.options);
      if (q.minRanked < 1) out.push(`${where}: min_ranked must be >= 1`);
      if (q.minRanked > q.maxRanked) {
        out.push(`${where}: min_ranked must be <= max_ranked`);
      }
      if (q.maxRanked > n) {
        out.push(`${where}: max_ranked must be <= number of options (${n})`);
      }
      break;
    }
    case "numericRange":
      validateNumericConstraints(q.constraints, where, out);
      break;
    case "pointsAllocation":
      validateOptionsOrCount(q.options, externalMode, where, out);
      if (q.budget <= 0) out.push(`${where}: budget must be > 0`);
      break;
    case "rating":
      validateOptionsOrCount(q.options, externalMode, where, out);
      validateRatingScale(q.scale, externalMode, where, out);
      break;
  }
};

/** Validate a survey definition's internal consistency. */
export const validateDefinition = (def: SurveyDefinition): string[] => {
  const out: string[] = [];
  if (def.specVersion !== SPEC_VERSION) {
    out.push(`spec_version ${def.specVersion} != supported ${SPEC_VERSION}`);
  }
  if (def.eligibleRoles.length === 0) {
    out.push("eligible_roles must be non-empty");
  }
  if (hasDuplicates(def.eligibleRoles as number[])) {
    out.push("eligible_roles should not contain duplicates");
  }
  if (def.questions.length === 0) {
    out.push("survey must have at least one question");
  }
  if (def.submissionMode.type === "sealed") {
    if (def.submissionMode.round <= 0) out.push("sealed round must be > 0");
    if (def.submissionMode.paddingSize <= 0) {
      out.push("sealed padding_size must be > 0");
    }
  }
  const externalMode = def.contentAnchor !== undefined;
  def.questions.forEach((q, i) =>
    validateQuestion(q, externalMode, `questions[${i}]`, out),
  );
  return out;
};

// ----------------------------------------------------------------------------
// Response validation (against the referenced definition)
// ----------------------------------------------------------------------------

const ratingValid = (rating: bigint, scale: RatingScale): boolean => {
  switch (scale.type) {
    case "numeric": {
      const { min, max, step } = scale.constraints;
      if (rating < min || rating > max) return false;
      if (step !== undefined && step > 0n && (rating - min) % step !== 0n) {
        return false;
      }
      return true;
    }
    case "labels":
      return rating >= 0n && rating < BigInt(scale.labels.length);
    case "count":
      return rating >= 0n && rating < BigInt(scale.count);
  }
};

/** The question discriminant whose tag matches a given answer discriminant. */
const QUESTION_TYPE_FOR_ANSWER = {
  custom: "custom",
  singleChoice: "singleChoice",
  multiSelect: "multiSelect",
  ranking: "ranking",
  numeric: "numericRange",
  pointsAllocation: "pointsAllocation",
  rating: "rating",
} as const;

const validateAnswer = (
  answer: AnswerItem,
  question: Question,
  where: string,
  out: string[],
): void => {
  const expected = QUESTION_TYPE_FOR_ANSWER[answer.type];
  if (question.type !== expected) {
    out.push(
      `${where}: answer type "${answer.type}" does not match question type "${question.type}"`,
    );
    return;
  }
  switch (answer.type) {
    case "custom":
      // Validated off-chain against the custom method schema.
      break;
    case "singleChoice": {
      if (question.type !== "singleChoice") return;
      const n = optionCount(question.options);
      if (!inRange(answer.optionIndex, n)) {
        out.push(`${where}: option index ${answer.optionIndex} out of range`);
      }
      break;
    }
    case "multiSelect": {
      if (question.type !== "multiSelect") return;
      const n = optionCount(question.options);
      const idx = answer.optionIndices;
      if (hasDuplicates(idx)) out.push(`${where}: duplicate option indices`);
      if (!idx.every((x) => inRange(x, n))) {
        out.push(`${where}: option index out of range`);
      }
      if (
        idx.length < question.minSelections ||
        idx.length > question.maxSelections
      ) {
        out.push(
          `${where}: selection count ${idx.length} not in [${question.minSelections}, ${question.maxSelections}]`,
        );
      }
      break;
    }
    case "ranking": {
      if (question.type !== "ranking") return;
      const n = optionCount(question.options);
      const idx = answer.ranking;
      if (hasDuplicates(idx)) out.push(`${where}: duplicate ranked indices`);
      if (!idx.every((x) => inRange(x, n))) {
        out.push(`${where}: ranked index out of range`);
      }
      if (idx.length < question.minRanked || idx.length > question.maxRanked) {
        out.push(
          `${where}: ranked count ${idx.length} not in [${question.minRanked}, ${question.maxRanked}]`,
        );
      }
      break;
    }
    case "numeric": {
      if (question.type !== "numericRange") return;
      const { min, max, step } = question.constraints;
      const v = answer.value;
      if (v < min || v > max) out.push(`${where}: value ${v} out of range`);
      if (step !== undefined && step > 0n && (v - min) % step !== 0n) {
        out.push(`${where}: value ${v} does not satisfy step ${step}`);
      }
      break;
    }
    case "pointsAllocation": {
      if (question.type !== "pointsAllocation") return;
      const n = optionCount(question.options);
      const idx = answer.allocations.map((a) => a.optionIndex);
      if (hasDuplicates(idx)) out.push(`${where}: duplicate option indices`);
      if (!idx.every((x) => inRange(x, n))) {
        out.push(`${where}: option index out of range`);
      }
      if (answer.allocations.some((a) => a.points < 0)) {
        out.push(`${where}: points must be >= 0`);
      }
      // Exact integer arithmetic — a float sum can lose precision above 2^53
      // and disagree with a bigint verifier on the hash-relevant verdict.
      const sum = answer.allocations.reduce((s, a) => s + BigInt(a.points), 0n);
      if (sum !== BigInt(question.budget)) {
        out.push(`${where}: points sum ${sum} != budget ${question.budget}`);
      }
      break;
    }
    case "rating": {
      if (question.type !== "rating") return;
      const n = optionCount(question.options);
      const idx = answer.ratings.map((r) => r.optionIndex);
      if (hasDuplicates(idx)) out.push(`${where}: duplicate option indices`);
      if (!idx.every((x) => inRange(x, n))) {
        out.push(`${where}: option index out of range`);
      }
      answer.ratings.forEach((r, i) => {
        if (!ratingValid(r.rating, question.scale)) {
          out.push(
            `${where}.ratings[${i}]: rating ${r.rating} invalid for scale`,
          );
        }
      });
      break;
    }
  }
};

/**
 * Validate a response against the survey definition it references.
 *
 * Sealed responses can only be checked structurally (mode agreement); their
 * answers are opaque until the tlock round publishes.
 */
export const validateResponse = (
  definition: SurveyDefinition,
  response: SurveyResponse,
): string[] => {
  const out: string[] = [];

  if (response.specVersion !== definition.specVersion) {
    out.push(
      `response spec_version ${response.specVersion} != survey ${definition.specVersion}`,
    );
  }
  if (!definition.eligibleRoles.includes(response.role)) {
    out.push(`role ${response.role} is not in the survey's eligible_roles`);
  }

  const sealed = definition.submissionMode.type === "sealed";
  if (sealed && response.answers.type !== "sealed") {
    out.push("sealed survey requires a sealed (ciphertext) response");
    return out;
  }
  if (!sealed && response.answers.type !== "public") {
    out.push("public survey requires public (plaintext) answers");
    return out;
  }
  if (response.answers.type === "sealed") {
    if (response.answers.ciphertext.length === 0) {
      out.push("sealed response ciphertext is empty");
    }
    return out;
  }

  const answers = response.answers.answers;
  const answered = new Set<number>();
  answers.forEach((a, i) => {
    const where = `answers[${i}]`;
    if (answered.has(a.questionIndex)) {
      out.push(`${where}: duplicate answer for question ${a.questionIndex}`);
    }
    answered.add(a.questionIndex);
    const question = definition.questions[a.questionIndex];
    if (question === undefined) {
      out.push(`${where}: question index ${a.questionIndex} out of range`);
      return;
    }
    validateAnswer(a, question, where, out);
  });

  definition.questions.forEach((q, i) => {
    if (q.required && !answered.has(i)) {
      out.push(`required question ${i} is not answered`);
    }
  });

  return out;
};
