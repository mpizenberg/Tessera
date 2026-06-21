/**
 * Encoders: CIP-179 domain types -> generic {@link Metadatum} tree.
 *
 * The result is a library-agnostic metadatum that any Cardano library can
 * serialize to (deterministic) CBOR. Maps are emitted with integer keys in
 * ascending order so that order-preserving encoders produce canonical CBOR.
 *
 * @module
 */

import {
  CredentialTag,
  METADATA_LABEL,
  PayloadTag,
  QuestionTag,
  SubmissionModeTag,
} from "./constants.js";
import { Cip179EncodeError } from "./errors.js";
import {
  encodeChunkedBytes,
  encodeChunkedText,
  intMap,
  type Metadatum,
} from "./metadatum.js";
import type {
  AnswerItem,
  Cip179Payload,
  ContentAnchor,
  Credential,
  NumericConstraints,
  OptionsOrCount,
  Question,
  RatingScale,
  ResponseAnswers,
  SubmissionMode,
  SurveyCancellation,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
} from "./types.js";

const big = (n: number): bigint => BigInt(n);

// ----------------------------------------------------------------------------
// Primitives
// ----------------------------------------------------------------------------

export const encodeSurveyRef = (ref: SurveyRef): Metadatum => [
  ref.txId,
  big(ref.index),
];

export const encodeContentAnchor = (anchor: ContentAnchor): Metadatum => [
  encodeChunkedText(anchor.uri),
  anchor.hash,
];

export const encodeCredential = (cred: Credential): Metadatum =>
  cred.type === "key"
    ? [big(CredentialTag.Key), cred.keyHash]
    : [big(CredentialTag.Script), cred.scriptHash];

export const encodeSubmissionMode = (mode: SubmissionMode): Metadatum =>
  mode.type === "public"
    ? [big(SubmissionModeTag.Public)]
    : [
        big(SubmissionModeTag.Sealed),
        mode.chainHash,
        big(mode.round),
        big(mode.paddingSize),
      ];

const encodeOptionsOrCount = (opts: OptionsOrCount): Metadatum =>
  opts.type === "options" ? opts.labels.map((l) => l) : big(opts.count);

const encodeNumericConstraints = (c: NumericConstraints): Metadatum =>
  c.step === undefined ? [c.min, c.max] : [c.min, c.max, c.step];

const encodeRatingScale = (scale: RatingScale): Metadatum => {
  switch (scale.type) {
    case "numeric":
      return encodeNumericConstraints(scale.constraints);
    case "labels":
      return scale.labels.map((l) => l);
    case "count":
      return big(scale.count);
  }
};

/**
 * Append the optional trailing `required` flag. Encoded as int `1` when true
 * and omitted otherwise (Cardano metadata has no boolean type; see the CDDL
 * note in the README).
 */
const withRequired = (fields: Metadatum[], required?: boolean): Metadatum =>
  required ? [...fields, 1n] : fields;

// ----------------------------------------------------------------------------
// Questions
// ----------------------------------------------------------------------------

export const encodeQuestion = (q: Question): Metadatum => {
  switch (q.type) {
    case "custom":
      return withRequired(
        [
          big(QuestionTag.Custom),
          encodeChunkedText(q.prompt),
          encodeContentAnchor(q.methodSchema),
        ],
        q.required,
      );
    case "singleChoice":
      return withRequired(
        [
          big(QuestionTag.SingleChoice),
          encodeChunkedText(q.prompt),
          encodeOptionsOrCount(q.options),
        ],
        q.required,
      );
    case "multiSelect":
      return withRequired(
        [
          big(QuestionTag.MultiSelect),
          encodeChunkedText(q.prompt),
          encodeOptionsOrCount(q.options),
          big(q.minSelections),
          big(q.maxSelections),
        ],
        q.required,
      );
    case "ranking":
      return withRequired(
        [
          big(QuestionTag.Ranking),
          encodeChunkedText(q.prompt),
          encodeOptionsOrCount(q.options),
          big(q.minRanked),
          big(q.maxRanked),
        ],
        q.required,
      );
    case "numericRange":
      return withRequired(
        [
          big(QuestionTag.NumericRange),
          encodeChunkedText(q.prompt),
          encodeNumericConstraints(q.constraints),
        ],
        q.required,
      );
    case "pointsAllocation":
      return withRequired(
        [
          big(QuestionTag.PointsAllocation),
          encodeChunkedText(q.prompt),
          encodeOptionsOrCount(q.options),
          big(q.budget),
        ],
        q.required,
      );
    case "rating":
      return withRequired(
        [
          big(QuestionTag.Rating),
          encodeChunkedText(q.prompt),
          encodeOptionsOrCount(q.options),
          encodeRatingScale(q.scale),
        ],
        q.required,
      );
  }
};

// ----------------------------------------------------------------------------
// Answers
// ----------------------------------------------------------------------------

export const encodeAnswerItem = (a: AnswerItem): Metadatum => {
  switch (a.type) {
    case "custom":
      return [big(QuestionTag.Custom), big(a.questionIndex), a.value];
    case "singleChoice":
      return [
        big(QuestionTag.SingleChoice),
        big(a.questionIndex),
        big(a.optionIndex),
      ];
    case "multiSelect":
      return [
        big(QuestionTag.MultiSelect),
        big(a.questionIndex),
        a.optionIndices.map(big),
      ];
    case "ranking":
      return [
        big(QuestionTag.Ranking),
        big(a.questionIndex),
        a.ranking.map(big),
      ];
    case "numeric":
      return [big(QuestionTag.NumericRange), big(a.questionIndex), a.value];
    case "pointsAllocation":
      return [
        big(QuestionTag.PointsAllocation),
        big(a.questionIndex),
        a.allocations.map((p) => [big(p.optionIndex), big(p.points)]),
      ];
    case "rating":
      return [
        big(QuestionTag.Rating),
        big(a.questionIndex),
        a.ratings.map((r) => [big(r.optionIndex), r.rating]),
      ];
  }
};

const encodeResponseAnswers = (ans: ResponseAnswers): Metadatum =>
  ans.type === "public"
    ? ans.answers.map(encodeAnswerItem)
    : encodeChunkedBytes(ans.ciphertext);

// ----------------------------------------------------------------------------
// Top-level records
// ----------------------------------------------------------------------------

export const encodeSurveyDefinition = (def: SurveyDefinition): Metadatum =>
  intMap([
    [0, big(def.specVersion)],
    [1, encodeCredential(def.owner)],
    [2, encodeChunkedText(def.title)],
    [3, encodeChunkedText(def.description)],
    [4, def.eligibleRoles.map(big)],
    [5, big(def.endEpoch)],
    [6, encodeSubmissionMode(def.submissionMode)],
    [7, def.questions.map(encodeQuestion)],
    [8, def.contentAnchor ? encodeContentAnchor(def.contentAnchor) : undefined],
  ]);

export const encodeSurveyResponse = (res: SurveyResponse): Metadatum =>
  intMap([
    [0, big(res.specVersion)],
    [1, encodeSurveyRef(res.surveyRef)],
    [2, big(res.role)],
    [3, encodeCredential(res.credential)],
    [4, encodeResponseAnswers(res.answers)],
    [5, res.rationale ? encodeContentAnchor(res.rationale) : undefined],
  ]);

export const encodeSurveyCancellation = (
  cancellation: SurveyCancellation,
): Metadatum => encodeSurveyRef(cancellation);

/** Encode a top-level CIP-179 payload (`cip_179_payload`). */
export const encodePayload = (payload: Cip179Payload): Metadatum => {
  switch (payload.type) {
    case "definitions":
      if (payload.definitions.length === 0) {
        throw new Cip179EncodeError("definitions payload must be non-empty");
      }
      return [
        big(PayloadTag.Definitions),
        payload.definitions.map(encodeSurveyDefinition),
      ];
    case "responses":
      if (payload.responses.length === 0) {
        throw new Cip179EncodeError("responses payload must be non-empty");
      }
      return [
        big(PayloadTag.Responses),
        payload.responses.map(encodeSurveyResponse),
      ];
    case "cancellations":
      if (payload.cancellations.length === 0) {
        throw new Cip179EncodeError("cancellations payload must be non-empty");
      }
      return [
        big(PayloadTag.Cancellations),
        payload.cancellations.map(encodeSurveyCancellation),
      ];
  }
};

/**
 * Encode a payload into a labelled metadata map `{ 17 => payload }`, ready to
 * be merged into a transaction's auxiliary data / metadata.
 */
export const encodeMetadata = (payload: Cip179Payload): Metadatum =>
  new Map<Metadatum, Metadatum>([
    [big(METADATA_LABEL), encodePayload(payload)],
  ]);
