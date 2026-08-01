/**
 * Semantic validation of CIP-179 structures.
 *
 * These functions check the cross-field invariants the CDDL cannot express
 * (option-count bounds, abstain/required rules, points summing to budget, ...).
 * They are pure and return a list of {@link ValidationProblem}s — a stable
 * `{ code, params }` pair each, not prose — so a caller can render them in any
 * language (see {@link describeProblem} for the default English rendering). An
 * empty list means valid. They do NOT check anything requiring ledger state
 * (credential proofs, role membership, epochs, cancellation, dedup) — that is
 * the responsibility of an indexer with chain access.
 *
 * RULESET-PINNED BEHAVIOR: the "validity" rule in `cardano-tessera-core`'s
 * `RULESET_DESCRIPTOR` is exactly "the response passes this validation against
 * the on-chain definition", and that descriptor's hash is baked into every
 * tally artifact. The emitter freezes a response's `wellFormed` verdict at
 * validation time; an independent verifier re-runs whatever `validateResponse`
 * ships when it runs. So any change that flips a response from valid to invalid
 * (or back) is a semantic ruleset change: bump `rulesetVersion` in
 * `packages/core/src/artifact.ts` and update the golden hash in
 * `artifact.test.ts` in the same commit, or old artifacts silently stop
 * reproducing (a MISMATCH that reads as tampering, not as a rules upgrade).
 * Note that the *verdict* (whether the list is empty) is what is pinned — the
 * problem codes/messages are presentation only and can evolve freely.
 *
 * For sealed surveys this runs twice against the `sealed-reveal` rule: once
 * structurally on the sealed response at submit/scan time, then again on the
 * decrypted answers after the drand reveal — the same `validateResponse`.
 *
 * @module
 */

import { SPEC_VERSION } from "./constants.js";
import { mechanismAProven } from "./domain/mechanismA.js";
import type { SurveyRecord } from "./domain/records.js";
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

// ----------------------------------------------------------------------------
// Structured problems
// ----------------------------------------------------------------------------

/**
 * Every stable problem code the validators can emit. Frozen so downstream code
 * (the app, the embeddable widget) can map each to a localized message and a
 * test can assert its catalog is exhaustive.
 */
export const VALIDATION_PROBLEM_CODES = [
  // --- definition ---
  "definition.specVersionUnsupported",
  "definition.eligibleRolesEmpty",
  "definition.eligibleRolesDuplicate",
  "definition.noQuestions",
  "definition.sealedRoundInvalid",
  "definition.sealedPaddingInvalid",
  "definition.endEpochNotAfterInclusion",
  "definition.ownerUnproven",
  // --- question ---
  "question.tooFewOptions",
  "question.optionCountTooLow",
  "question.optionCountRequiresExternal",
  "question.labelTooLong",
  "question.maxLessThanMin",
  "question.stepNotPositive",
  "question.ratingTooFewLabels",
  "question.ratingCountTooLow",
  "question.ratingCountRequiresExternal",
  "question.minSelectionsNegative",
  "question.maxSelectionsTooLow",
  "question.minSelectionsGtMax",
  "question.maxSelectionsGtOptions",
  "question.minRankedTooLow",
  "question.minRankedGtMax",
  "question.maxRankedGtOptions",
  "question.budgetNotPositive",
  // --- response ---
  "response.specVersionMismatch",
  "response.roleNotEligible",
  "response.sealedRequired",
  "response.publicRequired",
  "response.sealedCiphertextEmpty",
  "response.answersEmpty",
  "response.duplicateAnswer",
  "response.questionIndexOutOfRange",
  "response.requiredNotAnswered",
  // --- answer ---
  "answer.typeMismatch",
  "answer.optionIndexOutOfRange",
  "answer.optionIndicesOutOfRange",
  "answer.duplicateOptionIndices",
  "answer.selectionCountOutOfRange",
  "answer.duplicateRankedIndices",
  "answer.rankedIndexOutOfRange",
  "answer.rankedCountOutOfRange",
  "answer.valueOutOfRange",
  "answer.valueStepMismatch",
  "answer.pointsNegative",
  "answer.pointsSumMismatch",
  "answer.ratingInvalid",
  "answer.ratingRequireAll",
] as const;

/** A stable identifier for a semantic validation problem. */
export type ValidationProblemCode = (typeof VALIDATION_PROBLEM_CODES)[number];

/**
 * A single semantic validation problem: a stable {@link ValidationProblemCode}
 * plus the values it interpolates. Presentation-agnostic — render it with
 * {@link describeProblem} (English) or map `code` to a localized catalog.
 *
 * `where` (present on most question/answer problems) is a machine locator such
 * as `questions[2]` or `answers[0].ratings[1]`, meant to be shown verbatim, not
 * translated.
 */
export interface ValidationProblem {
  readonly code: ValidationProblemCode;
  readonly params?: Record<string, string | number>;
  /**
   * `"error"` (the default when this field is absent) marks a spec MUST-violation
   * that makes the structure invalid; `"warning"` marks a spec SHOULD-violation
   * that is surfaced but never disqualifies (finding 34). Only warnings set the
   * field, so an error problem stays `{ code, params? }`. Read it via
   * {@link problemSeverity}; the read-side talliability gate
   * ({@link isSurveyTalliable}) counts only errors, so a SHOULD-violation
   * (e.g. duplicate eligible_roles) can never render a spec-valid survey
   * untalliable.
   */
  readonly severity?: "error" | "warning";
}

const problem = (
  code: ValidationProblemCode,
  params?: Record<string, string | number>,
): ValidationProblem => (params ? { code, params } : { code });

/** A spec SHOULD-violation: surfaced, but never disqualifying (finding 34). */
const warning = (
  code: ValidationProblemCode,
  params?: Record<string, string | number>,
): ValidationProblem =>
  params
    ? { code, params, severity: "warning" }
    : { code, severity: "warning" };

/** A problem's severity, defaulting to `"error"` when the field is absent. */
export function problemSeverity(p: ValidationProblem): "error" | "warning" {
  return p.severity ?? "error";
}

/** Number of options a question offers (inline labels or external count). */
const optionCount = (opts: OptionsOrCount): number =>
  opts.type === "options" ? opts.labels.length : opts.count;

const hasDuplicates = (xs: readonly number[]): boolean =>
  new Set(xs).size !== xs.length;

const inRange = (x: number, n: number): boolean => x >= 0 && x < n;

/** Flag any `bounded_text` label over the 64 UTF-8 byte CDDL limit. */
const checkLabels = (
  labels: readonly string[],
  where: string,
  out: ValidationProblem[],
) =>
  labels.forEach((l, i) => {
    if (utf8ByteLength(l) > MAX_CHUNK_BYTES) {
      out.push(
        problem("question.labelTooLong", {
          where,
          index: i,
          max: MAX_CHUNK_BYTES,
        }),
      );
    }
  });

// ----------------------------------------------------------------------------
// Definition validation
// ----------------------------------------------------------------------------

const validateOptionsOrCount = (
  opts: OptionsOrCount,
  externalMode: boolean,
  where: string,
  out: ValidationProblem[],
): void => {
  if (opts.type === "options") {
    if (opts.labels.length < 2)
      out.push(problem("question.tooFewOptions", { where }));
    checkLabels(opts.labels, where, out);
  } else {
    if (opts.count < 2)
      out.push(problem("question.optionCountTooLow", { where }));
    if (!externalMode) {
      out.push(problem("question.optionCountRequiresExternal", { where }));
    }
  }
};

const validateNumericConstraints = (
  c: NumericConstraints,
  where: string,
  out: ValidationProblem[],
): void => {
  if (c.max < c.min) out.push(problem("question.maxLessThanMin", { where }));
  if (c.step !== undefined && c.step <= 0n)
    out.push(problem("question.stepNotPositive", { where }));
};

const validateRatingScale = (
  scale: RatingScale,
  externalMode: boolean,
  where: string,
  out: ValidationProblem[],
): void => {
  switch (scale.type) {
    case "numeric":
      validateNumericConstraints(scale.constraints, `${where} scale`, out);
      break;
    case "labels":
      if (scale.labels.length < 2) {
        out.push(problem("question.ratingTooFewLabels", { where }));
      }
      checkLabels(scale.labels, `${where} scale`, out);
      break;
    case "count":
      if (scale.count < 2)
        out.push(problem("question.ratingCountTooLow", { where }));
      if (!externalMode) {
        out.push(problem("question.ratingCountRequiresExternal", { where }));
      }
      break;
  }
};

const validateQuestion = (
  q: Question,
  externalMode: boolean,
  where: string,
  out: ValidationProblem[],
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
        out.push(problem("question.minSelectionsNegative", { where }));
      if (q.maxSelections < 1)
        out.push(problem("question.maxSelectionsTooLow", { where }));
      if (q.minSelections > q.maxSelections) {
        out.push(problem("question.minSelectionsGtMax", { where }));
      }
      if (q.maxSelections > n) {
        out.push(
          problem("question.maxSelectionsGtOptions", { where, count: n }),
        );
      }
      break;
    }
    case "ranking": {
      validateOptionsOrCount(q.options, externalMode, where, out);
      const n = optionCount(q.options);
      if (q.minRanked < 1)
        out.push(problem("question.minRankedTooLow", { where }));
      if (q.minRanked > q.maxRanked) {
        out.push(problem("question.minRankedGtMax", { where }));
      }
      if (q.maxRanked > n) {
        out.push(problem("question.maxRankedGtOptions", { where, count: n }));
      }
      break;
    }
    case "numericRange":
      validateNumericConstraints(q.constraints, where, out);
      break;
    case "pointsAllocation":
      validateOptionsOrCount(q.options, externalMode, where, out);
      if (q.budget <= 0)
        out.push(problem("question.budgetNotPositive", { where }));
      break;
    case "rating":
      validateOptionsOrCount(q.options, externalMode, where, out);
      validateRatingScale(q.scale, externalMode, where, out);
      break;
  }
};

/** Validate a survey definition's internal consistency. */
export const validateDefinition = (
  def: SurveyDefinition,
): ValidationProblem[] => {
  const out: ValidationProblem[] = [];
  if (def.specVersion !== SPEC_VERSION) {
    out.push(
      problem("definition.specVersionUnsupported", {
        actual: def.specVersion,
        supported: SPEC_VERSION,
      }),
    );
  }
  if (def.eligibleRoles.length === 0) {
    out.push(problem("definition.eligibleRolesEmpty"));
  }
  if (hasDuplicates(def.eligibleRoles as number[])) {
    // Spec: eligible_roles entries "SHOULD be unique" — a SHOULD, so a warning,
    // not a disqualifier. A spec-valid foreign survey with duplicate roles stays
    // talliable (finding 34); the read-side gate ignores warnings.
    out.push(warning("definition.eligibleRolesDuplicate"));
  }
  if (def.questions.length === 0) {
    out.push(problem("definition.noQuestions"));
  }
  if (def.submissionMode.type === "sealed") {
    if (def.submissionMode.round <= 0)
      out.push(problem("definition.sealedRoundInvalid"));
    if (def.submissionMode.paddingSize <= 0) {
      out.push(problem("definition.sealedPaddingInvalid"));
    }
  }
  const externalMode = def.contentAnchor !== undefined;
  def.questions.forEach((q, i) =>
    validateQuestion(q, externalMode, `questions[${i}]`, out),
  );
  return out;
};

/**
 * The error-severity subset of {@link validateDefinition} — the MUST-violations
 * that make a definition untalliable. Excludes SHOULD-warnings (finding 34).
 */
export function definitionErrors(def: SurveyDefinition): ValidationProblem[] {
  return validateDefinition(def).filter((p) => problemSeverity(p) === "error");
}

/**
 * Is a definition talliable on its own terms? True iff it has **no
 * error-severity** problem: `spec_version === SPEC_VERSION` (findings 10 — a
 * non-v5 payload is never tallied under v5 semantics), non-empty `eligible_roles`,
 * at least one question, in-bounds question constraints, and a valid sealed
 * round/padding. Duplicate `eligible_roles` is a SHOULD (warning) and never
 * disqualifies.
 *
 * This covers only what the definition says about itself. The full read-side
 * gate is {@link isSurveyTalliable}, which adds the rules that need the
 * definition's chain position; prefer it wherever a {@link SurveyRecord} is at
 * hand.
 */
export function isDefinitionTalliable(def: SurveyDefinition): boolean {
  return definitionErrors(def).length === 0;
}

/**
 * The error-severity problems that make a *published* survey untalliable: every
 * {@link definitionErrors} problem, plus the two rules only the record can
 * decide.
 *
 *  - CIP-179 §Epoch Semantics: "`end_epoch` MUST be greater than the current
 *    epoch when the definition transaction is included." A definition published
 *    in its own final epoch leaves no epoch in which a response is both
 *    in-window and cast after the survey exists.
 *  - CIP-179 §Survey Definition: "The definition transaction MUST prove
 *    ownership of the `owner` credential." Without it a survey can name anyone
 *    as owner — a DRep, a foundation — and be counted under a borrowed name.
 *
 * The owner rule is judged only when the record actually carries the defining
 * transaction's evidence. An absent proof is unknown, not disproven, so it adds
 * no problem here; a caller that freezes a result must require the evidence
 * before it does (see `finalize`'s postpone path).
 */
export function surveyErrors(record: SurveyRecord): ValidationProblem[] {
  const out = definitionErrors(record.definition);
  if (record.definition.endEpoch <= record.epochNo) {
    out.push(
      problem("definition.endEpochNotAfterInclusion", {
        endEpoch: record.definition.endEpoch,
        inclusionEpoch: record.epochNo,
      }),
    );
  }
  if (
    record.proof &&
    !mechanismAProven(record.definition.owner, record.proof)
  ) {
    out.push(problem("definition.ownerUnproven"));
  }
  return out;
}

/**
 * Is a published survey talliable at all? The read-side gate the emitter and any
 * independent verifier both apply (finding 11): a survey failing it produces
 * **no artifact** and is never tallied, so a hostile definition cannot be
 * counted under broken constraints, and a backend that tallies one anyway
 * diverges from a conformant verifier. It is pinned in `RULESET_DESCRIPTOR` (see
 * `tally/artifact.ts`), so a change to *which* surveys are talliable is a
 * semantic ruleset change.
 */
export function isSurveyTalliable(record: SurveyRecord): boolean {
  return surveyErrors(record).length === 0;
}

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
  out: ValidationProblem[],
): void => {
  const expected = QUESTION_TYPE_FOR_ANSWER[answer.type];
  if (question.type !== expected) {
    out.push(
      problem("answer.typeMismatch", {
        where,
        answerType: answer.type,
        questionType: question.type,
      }),
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
        out.push(
          problem("answer.optionIndexOutOfRange", {
            where,
            index: answer.optionIndex,
          }),
        );
      }
      break;
    }
    case "multiSelect": {
      if (question.type !== "multiSelect") return;
      const n = optionCount(question.options);
      const idx = answer.optionIndices;
      if (hasDuplicates(idx))
        out.push(problem("answer.duplicateOptionIndices", { where }));
      if (!idx.every((x) => inRange(x, n))) {
        out.push(problem("answer.optionIndicesOutOfRange", { where }));
      }
      if (
        idx.length < question.minSelections ||
        idx.length > question.maxSelections
      ) {
        out.push(
          problem("answer.selectionCountOutOfRange", {
            where,
            count: idx.length,
            min: question.minSelections,
            max: question.maxSelections,
          }),
        );
      }
      break;
    }
    case "ranking": {
      if (question.type !== "ranking") return;
      const n = optionCount(question.options);
      const idx = answer.ranking;
      if (hasDuplicates(idx))
        out.push(problem("answer.duplicateRankedIndices", { where }));
      if (!idx.every((x) => inRange(x, n))) {
        out.push(problem("answer.rankedIndexOutOfRange", { where }));
      }
      if (idx.length < question.minRanked || idx.length > question.maxRanked) {
        out.push(
          problem("answer.rankedCountOutOfRange", {
            where,
            count: idx.length,
            min: question.minRanked,
            max: question.maxRanked,
          }),
        );
      }
      break;
    }
    case "numeric": {
      if (question.type !== "numericRange") return;
      const { min, max, step } = question.constraints;
      const v = answer.value;
      if (v < min || v > max)
        out.push(
          problem("answer.valueOutOfRange", { where, value: String(v) }),
        );
      if (step !== undefined && step > 0n && (v - min) % step !== 0n) {
        out.push(
          problem("answer.valueStepMismatch", {
            where,
            value: String(v),
            step: String(step),
          }),
        );
      }
      break;
    }
    case "pointsAllocation": {
      if (question.type !== "pointsAllocation") return;
      const n = optionCount(question.options);
      const idx = answer.allocations.map((a) => a.optionIndex);
      if (hasDuplicates(idx))
        out.push(problem("answer.duplicateOptionIndices", { where }));
      if (!idx.every((x) => inRange(x, n))) {
        out.push(problem("answer.optionIndicesOutOfRange", { where }));
      }
      if (answer.allocations.some((a) => a.points < 0)) {
        out.push(problem("answer.pointsNegative", { where }));
      }
      // Exact integer arithmetic — a float sum can lose precision above 2^53
      // and disagree with a bigint verifier on the hash-relevant verdict.
      const sum = answer.allocations.reduce((s, a) => s + BigInt(a.points), 0n);
      if (sum !== BigInt(question.budget)) {
        out.push(
          problem("answer.pointsSumMismatch", {
            where,
            sum: String(sum),
            budget: String(question.budget),
          }),
        );
      }
      break;
    }
    case "rating": {
      if (question.type !== "rating") return;
      const n = optionCount(question.options);
      const idx = answer.ratings.map((r) => r.optionIndex);
      if (hasDuplicates(idx))
        out.push(problem("answer.duplicateOptionIndices", { where }));
      if (!idx.every((x) => inRange(x, n))) {
        out.push(problem("answer.optionIndicesOutOfRange", { where }));
      }
      answer.ratings.forEach((r, i) => {
        if (!ratingValid(r.rating, question.scale)) {
          out.push(
            problem("answer.ratingInvalid", {
              where,
              index: i,
              rating: String(r.rating),
            }),
          );
        }
      });
      // v5 require_all: a *present* answer must rate every option. Omitting the
      // question stays an abstain (handled by the required-questions check),
      // which this rule does not touch.
      if (question.requireAll && answer.ratings.length !== n) {
        out.push(
          problem("answer.ratingRequireAll", {
            where,
            count: n,
            got: answer.ratings.length,
          }),
        );
      }
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
): ValidationProblem[] => {
  const out: ValidationProblem[] = [];

  if (response.specVersion !== definition.specVersion) {
    out.push(
      problem("response.specVersionMismatch", {
        actual: response.specVersion,
        expected: definition.specVersion,
      }),
    );
  }
  if (!definition.eligibleRoles.includes(response.role)) {
    out.push(problem("response.roleNotEligible", { role: response.role }));
  }

  const sealed = definition.submissionMode.type === "sealed";
  if (sealed && response.answers.type !== "sealed") {
    out.push(problem("response.sealedRequired"));
    return out;
  }
  if (!sealed && response.answers.type !== "public") {
    out.push(problem("response.publicRequired"));
    return out;
  }
  if (response.answers.type === "sealed") {
    if (response.answers.ciphertext.length === 0) {
      out.push(problem("response.sealedCiphertextEmpty"));
    }
    return out;
  }

  const answers = response.answers.answers;
  // CDDL: response_answers = [+ answer_item] — a public response MUST carry at
  // least one answer. The decoder already rejects an empty array (decode.ts),
  // so this never fires for an on-chain public response; it guards the two
  // paths that build a public answer set without going through the decoder —
  // the responder UIs before submit, and a revealed sealed plaintext
  // (seal.ts) whose empty array would otherwise count as a phantom participant.
  if (answers.length === 0) {
    out.push(problem("response.answersEmpty"));
  }
  const answered = new Set<number>();
  answers.forEach((a, i) => {
    const where = `answers[${i}]`;
    if (answered.has(a.questionIndex)) {
      out.push(
        problem("response.duplicateAnswer", {
          where,
          questionIndex: a.questionIndex,
        }),
      );
    }
    answered.add(a.questionIndex);
    const question = definition.questions[a.questionIndex];
    if (question === undefined) {
      out.push(
        problem("response.questionIndexOutOfRange", {
          where,
          questionIndex: a.questionIndex,
        }),
      );
      return;
    }
    validateAnswer(a, question, where, out);
  });

  definition.questions.forEach((q, i) => {
    if (q.required && !answered.has(i)) {
      out.push(problem("response.requiredNotAnswered", { questionIndex: i }));
    }
  });

  return out;
};

// ----------------------------------------------------------------------------
// Default English rendering (logging / CLI / fallback)
// ----------------------------------------------------------------------------

/**
 * English one-liner templates for every problem code. `{token}` placeholders are
 * filled from a problem's `params`. Downstream UIs (the app, the widget) map
 * `code` to their own localized catalogs instead; this map is the fallback and
 * keeps the library self-describing.
 */
const PROBLEM_MESSAGES_EN: Record<ValidationProblemCode, string> = {
  "definition.specVersionUnsupported":
    "spec_version {actual} != supported {supported}",
  "definition.eligibleRolesEmpty": "eligible_roles must be non-empty",
  "definition.eligibleRolesDuplicate":
    "eligible_roles should not contain duplicates",
  "definition.noQuestions": "survey must have at least one question",
  "definition.sealedRoundInvalid": "sealed round must be > 0",
  "definition.sealedPaddingInvalid": "sealed padding_size must be > 0",
  "definition.endEpochNotAfterInclusion":
    "end_epoch {endEpoch} must be greater than the inclusion epoch {inclusionEpoch}",
  "definition.ownerUnproven":
    "the defining transaction does not prove the owner credential",

  "question.tooFewOptions": "{where}: needs at least 2 options",
  "question.optionCountTooLow": "{where}: option count must be >= 2",
  "question.optionCountRequiresExternal":
    "{where}: option-count form requires external-content mode (key 8)",
  "question.labelTooLong": "{where}: label {index} exceeds {max} UTF-8 bytes",
  "question.maxLessThanMin": "{where}: max_value must be >= min_value",
  "question.stepNotPositive": "{where}: step must be > 0",
  "question.ratingTooFewLabels":
    "{where}: rating scale needs at least 2 labels",
  "question.ratingCountTooLow": "{where}: rating level count must be >= 2",
  "question.ratingCountRequiresExternal":
    "{where}: rating level-count form requires external-content mode",
  "question.minSelectionsNegative": "{where}: min_selections must be >= 0",
  "question.maxSelectionsTooLow": "{where}: max_selections must be >= 1",
  "question.minSelectionsGtMax":
    "{where}: min_selections must be <= max_selections",
  "question.maxSelectionsGtOptions":
    "{where}: max_selections must be <= number of options ({count})",
  "question.minRankedTooLow": "{where}: min_ranked must be >= 1",
  "question.minRankedGtMax": "{where}: min_ranked must be <= max_ranked",
  "question.maxRankedGtOptions":
    "{where}: max_ranked must be <= number of options ({count})",
  "question.budgetNotPositive": "{where}: budget must be > 0",

  "response.specVersionMismatch":
    "response spec_version {actual} != survey {expected}",
  "response.roleNotEligible":
    "role {role} is not in the survey's eligible_roles",
  "response.sealedRequired":
    "sealed survey requires a sealed (ciphertext) response",
  "response.publicRequired":
    "public survey requires public (plaintext) answers",
  "response.sealedCiphertextEmpty": "sealed response ciphertext is empty",
  "response.answersEmpty":
    "a public response must answer at least one question",
  "response.duplicateAnswer":
    "{where}: duplicate answer for question {questionIndex}",
  "response.questionIndexOutOfRange":
    "{where}: question index {questionIndex} out of range",
  "response.requiredNotAnswered":
    "required question {questionIndex} is not answered",

  "answer.typeMismatch":
    '{where}: answer type "{answerType}" does not match question type "{questionType}"',
  "answer.optionIndexOutOfRange": "{where}: option index {index} out of range",
  "answer.optionIndicesOutOfRange": "{where}: option index out of range",
  "answer.duplicateOptionIndices": "{where}: duplicate option indices",
  "answer.selectionCountOutOfRange":
    "{where}: selection count {count} not in [{min}, {max}]",
  "answer.duplicateRankedIndices": "{where}: duplicate ranked indices",
  "answer.rankedIndexOutOfRange": "{where}: ranked index out of range",
  "answer.rankedCountOutOfRange":
    "{where}: ranked count {count} not in [{min}, {max}]",
  "answer.valueOutOfRange": "{where}: value {value} out of range",
  "answer.valueStepMismatch":
    "{where}: value {value} does not satisfy step {step}",
  "answer.pointsNegative": "{where}: points must be >= 0",
  "answer.pointsSumMismatch": "{where}: points sum {sum} != budget {budget}",
  "answer.ratingInvalid":
    "{where}.ratings[{index}]: rating {rating} invalid for scale",
  "answer.ratingRequireAll":
    "{where}: require_all rating must cover all {count} options, got {got}",
};

const interpolate = (
  template: string,
  params: Record<string, string | number> = {},
): string =>
  template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );

/** Render a single problem in English (default/fallback presentation). */
export const describeProblem = (p: ValidationProblem): string =>
  interpolate(PROBLEM_MESSAGES_EN[p.code], p.params);

/** Render a list of problems in English. */
export const describeProblems = (
  problems: readonly ValidationProblem[],
): string[] => problems.map(describeProblem);
