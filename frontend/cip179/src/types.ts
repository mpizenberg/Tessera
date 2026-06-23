/**
 * CIP-179 domain types.
 *
 * These are ergonomic TypeScript representations of the CDDL. Chunked text is
 * exposed as a plain (already-joined) `string`; chunking happens only at
 * encode time. Chunked tlock ciphertext is exposed as a single `Uint8Array`.
 *
 * Numeric convention:
 * - `bigint` for ledger-style integers whose magnitude is unbounded in
 *   principle (numeric-range bounds/values, rating-grid bounds/values).
 * - `number` for small structural integers (tags, indices, counts, epochs,
 *   roles, drand round, padding size).
 *
 * @module
 */

import type { Metadatum } from "./metadatum.js";
import type { Role } from "./constants.js";

// ----------------------------------------------------------------------------
// Primitives
// ----------------------------------------------------------------------------

/** 32-byte transaction id. */
export type TxId = Uint8Array;

/** 32-byte blake2b-256 hash. */
export type Blake2b256 = Uint8Array;

/** Reference to a survey definition: `(tx_id, survey_index)`. */
export interface SurveyRef {
  /** Transaction carrying the definitions payload (32 bytes). */
  readonly txId: TxId;
  /** Position of the definition within that payload's array (uint .size 2). */
  readonly index: number;
}

/** Off-chain content reference, tamper-evident via its hash. */
export interface ContentAnchor {
  /** URI of the content (e.g. `ipfs://...`, `https://...`). */
  readonly uri: string;
  /** blake2b-256 of the raw bytes at the URI (32 bytes). */
  readonly hash: Blake2b256;
}

/** A Cardano credential: key-based or script-based. */
export type Credential =
  | { readonly type: "key"; readonly keyHash: Uint8Array }
  | { readonly type: "script"; readonly scriptHash: Uint8Array };

// ----------------------------------------------------------------------------
// Submission mode
// ----------------------------------------------------------------------------

export type SubmissionMode = PublicSubmissionMode | SealedSubmissionMode;

/** Responses carry plaintext answer items. */
export interface PublicSubmissionMode {
  readonly type: "public";
}

/**
 * Responses carry a timelock-encrypted (Drand `tlock`) ciphertext, decryptable
 * by anyone once `round` publishes on the pinned chain. Delayed reveal, not
 * permanent secrecy.
 */
export interface SealedSubmissionMode {
  readonly type: "sealed";
  /** Drand chain hash for tlock (32 bytes). */
  readonly chainHash: Uint8Array;
  /** Drand round at which answers become decryptable (> 0). */
  readonly round: number;
  /** Minimum plaintext byte length each response is padded to (> 0). */
  readonly paddingSize: number;
}

// ----------------------------------------------------------------------------
// Options / numeric constraints / rating scale
// ----------------------------------------------------------------------------

/**
 * Inline labels (>= 2) or, in external-content mode, an option count (>= 2)
 * with labels supplied by the anchored document.
 */
export type OptionsOrCount =
  | { readonly type: "options"; readonly labels: readonly string[] }
  | { readonly type: "count"; readonly count: number };

/** `[min_value, max_value, ?step]`. */
export interface NumericConstraints {
  readonly min: bigint;
  readonly max: bigint;
  /** Optional positive step. */
  readonly step?: bigint;
}

/**
 * Rating scale: a numeric grid, an ordered worst-to-best label list, or (in
 * external-content mode) a bare level count. The three CBOR shapes are
 * distinct.
 */
export type RatingScale =
  | { readonly type: "numeric"; readonly constraints: NumericConstraints }
  | { readonly type: "labels"; readonly labels: readonly string[] }
  | { readonly type: "count"; readonly count: number };

// ----------------------------------------------------------------------------
// Questions
// ----------------------------------------------------------------------------

interface QuestionBase {
  /** Prompt text (already joined; chunked at encode time). */
  readonly prompt: string;
  /** When true, a response MUST NOT omit this question. Default false. */
  readonly required?: boolean;
}

/** Tag 0: answer format defined by the schema at the anchor. */
export interface CustomQuestion extends QuestionBase {
  readonly type: "custom";
  readonly methodSchema: ContentAnchor;
}

/** Tag 1: exactly one option selected. */
export interface SingleChoiceQuestion extends QuestionBase {
  readonly type: "singleChoice";
  readonly options: OptionsOrCount;
}

/** Tag 2: between min and max options (min may be 0). */
export interface MultiSelectQuestion extends QuestionBase {
  readonly type: "multiSelect";
  readonly options: OptionsOrCount;
  readonly minSelections: number;
  readonly maxSelections: number;
}

/** Tag 3: between min and max options, in preference order. */
export interface RankingQuestion extends QuestionBase {
  readonly type: "ranking";
  readonly options: OptionsOrCount;
  readonly minRanked: number;
  readonly maxRanked: number;
}

/** Tag 4: an integer satisfying the constraints. */
export interface NumericRangeQuestion extends QuestionBase {
  readonly type: "numericRange";
  readonly constraints: NumericConstraints;
}

/** Tag 5: distribute exactly `budget` points across options. */
export interface PointsAllocationQuestion extends QuestionBase {
  readonly type: "pointsAllocation";
  readonly options: OptionsOrCount;
  readonly budget: number;
}

/** Tag 6: rate options on the given scale. */
export interface RatingQuestion extends QuestionBase {
  readonly type: "rating";
  readonly options: OptionsOrCount;
  readonly scale: RatingScale;
}

export type Question =
  | CustomQuestion
  | SingleChoiceQuestion
  | MultiSelectQuestion
  | RankingQuestion
  | NumericRangeQuestion
  | PointsAllocationQuestion
  | RatingQuestion;

// ----------------------------------------------------------------------------
// Answers (tag matches the referenced question type)
// ----------------------------------------------------------------------------

interface AnswerBase {
  /** Index of the answered question within the definition's questions array. */
  readonly questionIndex: number;
}

/** Tag 0: free-form value interpreted per the custom method schema. */
export interface CustomAnswer extends AnswerBase {
  readonly type: "custom";
  readonly value: Metadatum;
}

/** Tag 1: exactly one selected option index. */
export interface SingleChoiceAnswer extends AnswerBase {
  readonly type: "singleChoice";
  readonly optionIndex: number;
}

/** Tag 2: unique valid option indices (may be empty when min is 0). */
export interface MultiSelectAnswer extends AnswerBase {
  readonly type: "multiSelect";
  readonly optionIndices: readonly number[];
}

/** Tag 3: unique valid option indices, most preferred first. */
export interface RankingAnswer extends AnswerBase {
  readonly type: "ranking";
  readonly ranking: readonly number[];
}

/** Tag 4: an integer in range. */
export interface NumericAnswer extends AnswerBase {
  readonly type: "numeric";
  readonly value: bigint;
}

/** Tag 5: `(option_index, points)` pairs summing to the budget. */
export interface PointsAllocationAnswer extends AnswerBase {
  readonly type: "pointsAllocation";
  readonly allocations: readonly PointsAllocation[];
}

export interface PointsAllocation {
  readonly optionIndex: number;
  readonly points: number;
}

/** Tag 6: `(option_index, rating)` pairs valid for the scale. */
export interface RatingAnswer extends AnswerBase {
  readonly type: "rating";
  readonly ratings: readonly Rating[];
}

export interface Rating {
  readonly optionIndex: number;
  readonly rating: bigint;
}

export type AnswerItem =
  | CustomAnswer
  | SingleChoiceAnswer
  | MultiSelectAnswer
  | RankingAnswer
  | NumericAnswer
  | PointsAllocationAnswer
  | RatingAnswer;

/**
 * Response answers, shaped by the referenced survey's submission mode: an array
 * of plaintext answer items (public), or a tlock ciphertext (sealed).
 */
export type ResponseAnswers =
  | { readonly type: "public"; readonly answers: readonly AnswerItem[] }
  | { readonly type: "sealed"; readonly ciphertext: Uint8Array };

// ----------------------------------------------------------------------------
// Top-level records
// ----------------------------------------------------------------------------

/** A survey definition (`survey_definition`, integer-keyed map keys 0-8). */
export interface SurveyDefinition {
  /** spec_version (key 0). */
  readonly specVersion: number;
  /** Owner credential authorizing cancellation (key 1). */
  readonly owner: Credential;
  /** Title; may be empty in external-content mode (key 2). */
  readonly title: string;
  /** Description; may be empty in external-content mode (key 3). */
  readonly description: string;
  /** Non-empty set of roles permitted to respond (key 4). */
  readonly eligibleRoles: readonly Role[];
  /** Inclusive cutoff epoch (key 5). */
  readonly endEpoch: number;
  /** How responses are submitted (key 6). */
  readonly submissionMode: SubmissionMode;
  /** Questions, at least one (key 7). */
  readonly questions: readonly Question[];
  /** Optional external presentation document; signals external-content mode (key 8). */
  readonly contentAnchor?: ContentAnchor;
}

/** A survey response (`survey_response`, integer-keyed map keys 0-5). */
export interface SurveyResponse {
  /** spec_version; MUST match the referenced survey's (key 0). */
  readonly specVersion: number;
  /** Reference to the survey definition (key 1). */
  readonly surveyRef: SurveyRef;
  /** Claimed responder role (key 2). */
  readonly role: Role;
  /** Responder's credential (key 3). */
  readonly credential: Credential;
  /** Answers, or a sealed ciphertext (key 4). */
  readonly answers: ResponseAnswers;
  /** Optional voter rationale (key 5). */
  readonly rationale?: ContentAnchor;
}

/** A survey cancellation is a bare survey reference (`survey_cancellation`). */
export type SurveyCancellation = SurveyRef;

/** Top-level payload under metadata label 17 (`cip_179_payload`). */
export type Cip179Payload =
  | {
      readonly type: "definitions";
      readonly definitions: readonly SurveyDefinition[];
    }
  | {
      readonly type: "responses";
      readonly responses: readonly SurveyResponse[];
    }
  | {
      readonly type: "cancellations";
      readonly cancellations: readonly SurveyCancellation[];
    };
