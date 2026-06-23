/**
 * Decoders: generic {@link Metadatum} tree -> CIP-179 domain types.
 *
 * Decoding is shape-driven and total: every malformed input throws a
 * {@link Cip179DecodeError} carrying the path to the offending node. Decoders
 * are intentionally lenient about *unknown* map keys (reserved for future
 * versions) and strict about structure. They validate shape, not cross-field
 * semantics; use the `validate` module for that.
 *
 * @module
 */

import {
  CredentialTag,
  METADATA_LABEL,
  PayloadTag,
  QuestionTag,
  ROLE_VALUES,
  type Role,
  SubmissionModeTag,
} from "./constants.js";
import { Cip179DecodeError } from "./errors.js";
import {
  decodeChunkedBytes,
  decodeChunkedText,
  getKey,
  isBytes,
  isInt,
  isList,
  isText,
  type Metadatum,
  type MetadatumList,
  type MetadatumMap,
} from "./metadatum.js";
import type {
  AnswerItem,
  Cip179Payload,
  ContentAnchor,
  Credential,
  NumericConstraints,
  OptionsOrCount,
  PointsAllocation,
  Question,
  Rating,
  RatingScale,
  ResponseAnswers,
  SubmissionMode,
  SurveyCancellation,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
} from "./types.js";

// ----------------------------------------------------------------------------
// Local helpers (path-aware)
// ----------------------------------------------------------------------------

const fail = (message: string, path: string): never => {
  throw new Cip179DecodeError(message, path);
};

const asList = (m: Metadatum, path: string): MetadatumList =>
  isList(m) ? m : fail("expected array", path);

const asMap = (m: Metadatum, path: string): MetadatumMap =>
  m instanceof Map ? m : fail("expected map", path);

const asText = (m: Metadatum, path: string): string =>
  isText(m) ? m : fail("expected text", path);

const asBytes = (m: Metadatum, path: string): Uint8Array =>
  isBytes(m) ? m : fail("expected byte string", path);

const asInt = (m: Metadatum, path: string): bigint =>
  isInt(m) ? m : fail("expected integer", path);

const asNumber = (m: Metadatum, path: string): number => {
  const n = asInt(m, path);
  if (
    n > BigInt(Number.MAX_SAFE_INTEGER) ||
    n < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return fail(`integer out of safe range: ${n}`, path);
  }
  return Number(n);
};

const text = (m: Metadatum, path: string): string => {
  try {
    return decodeChunkedText(m);
  } catch (e) {
    return fail((e as Error).message, path);
  }
};

const expectLen = (
  arr: MetadatumList,
  min: number,
  max: number,
  path: string,
): void => {
  if (arr.length < min || arr.length > max) {
    fail(`expected array of length ${min}..${max}, got ${arr.length}`, path);
  }
};

// ----------------------------------------------------------------------------
// Primitives
// ----------------------------------------------------------------------------

export const decodeSurveyRef = (
  m: Metadatum,
  path = "surveyRef",
): SurveyRef => {
  const arr = asList(m, path);
  expectLen(arr, 2, 2, path);
  return {
    txId: asBytes(arr[0], `${path}[0]`),
    index: asNumber(arr[1], `${path}[1]`),
  };
};

export const decodeContentAnchor = (
  m: Metadatum,
  path = "contentAnchor",
): ContentAnchor => {
  const arr = asList(m, path);
  expectLen(arr, 2, 2, path);
  return {
    uri: text(arr[0], `${path}[0]`),
    hash: asBytes(arr[1], `${path}[1]`),
  };
};

export const decodeCredential = (
  m: Metadatum,
  path = "credential",
): Credential => {
  const arr = asList(m, path);
  expectLen(arr, 2, 2, path);
  const tag = asNumber(arr[0], `${path}[0]`);
  const hash = asBytes(arr[1], `${path}[1]`);
  switch (tag) {
    case CredentialTag.Key:
      return { type: "key", keyHash: hash };
    case CredentialTag.Script:
      return { type: "script", scriptHash: hash };
    default:
      return fail(`unknown credential tag ${tag}`, path);
  }
};

const decodeRole = (m: Metadatum, path: string): Role => {
  const r = asNumber(m, path);
  if (!ROLE_VALUES.includes(r as Role)) fail(`unknown role ${r}`, path);
  return r as Role;
};

export const decodeSubmissionMode = (
  m: Metadatum,
  path = "submissionMode",
): SubmissionMode => {
  const arr = asList(m, path);
  const tag = asNumber(arr[0], `${path}[0]`);
  switch (tag) {
    case SubmissionModeTag.Public:
      return { type: "public" };
    case SubmissionModeTag.Sealed:
      expectLen(arr, 4, 4, path);
      return {
        type: "sealed",
        chainHash: asBytes(arr[1], `${path}[1]`),
        round: asNumber(arr[2], `${path}[2]`),
        paddingSize: asNumber(arr[3], `${path}[3]`),
      };
    default:
      return fail(`unknown submission mode tag ${tag}`, path);
  }
};

// ----------------------------------------------------------------------------
// Options / numeric constraints / rating scale
// ----------------------------------------------------------------------------

const decodeOptionsOrCount = (m: Metadatum, path: string): OptionsOrCount => {
  if (isInt(m)) return { type: "count", count: asNumber(m, path) };
  const arr = asList(m, path);
  return {
    type: "options",
    labels: arr.map((label, i) => asText(label, `${path}[${i}]`)),
  };
};

const decodeNumericConstraints = (
  m: Metadatum,
  path: string,
): NumericConstraints => {
  const arr = asList(m, path);
  expectLen(arr, 2, 3, path);
  const min = asInt(arr[0], `${path}[0]`);
  const max = asInt(arr[1], `${path}[1]`);
  return arr.length === 3
    ? { min, max, step: asInt(arr[2], `${path}[2]`) }
    : { min, max };
};

const decodeRatingScale = (m: Metadatum, path: string): RatingScale => {
  // uint -> level count; array of ints -> numeric grid; array of text -> labels.
  if (isInt(m)) return { type: "count", count: asNumber(m, path) };
  const arr = asList(m, path);
  if (arr.length === 0) return fail("empty rating_scale", path);
  if (isText(arr[0])) {
    return {
      type: "labels",
      labels: arr.map((label, i) => asText(label, `${path}[${i}]`)),
    };
  }
  return { type: "numeric", constraints: decodeNumericConstraints(m, path) };
};

// ----------------------------------------------------------------------------
// Questions
// ----------------------------------------------------------------------------

/**
 * Read the optional trailing `required` flag. Present (and true) when the array
 * has exactly one extra trailing element equal to int 1; absent otherwise.
 */
const readRequired = (
  arr: MetadatumList,
  baseLen: number,
  path: string,
): boolean | undefined => {
  if (arr.length === baseLen) return undefined;
  if (arr.length === baseLen + 1) {
    const flag = asNumber(arr[baseLen], `${path}[${baseLen}]`);
    if (flag === 0) return undefined;
    if (flag === 1) return true;
    return fail(`invalid required flag ${flag} (expected 0 or 1)`, path);
  }
  return fail(
    `expected array of length ${baseLen} or ${baseLen + 1}, got ${arr.length}`,
    path,
  );
};

const withRequired = <Q extends Question>(q: Q, required?: boolean): Q =>
  required ? { ...q, required: true } : q;

export const decodeQuestion = (m: Metadatum, path = "question"): Question => {
  const arr = asList(m, path);
  const tag = asNumber(arr[0], `${path}[0]`);
  const prompt = text(arr[1], `${path}[1]`);
  switch (tag) {
    case QuestionTag.Custom: {
      const required = readRequired(arr, 3, path);
      return withRequired(
        {
          type: "custom",
          prompt,
          methodSchema: decodeContentAnchor(arr[2], `${path}[2]`),
        },
        required,
      );
    }
    case QuestionTag.SingleChoice: {
      const required = readRequired(arr, 3, path);
      return withRequired(
        {
          type: "singleChoice",
          prompt,
          options: decodeOptionsOrCount(arr[2], `${path}[2]`),
        },
        required,
      );
    }
    case QuestionTag.MultiSelect: {
      const required = readRequired(arr, 5, path);
      return withRequired(
        {
          type: "multiSelect",
          prompt,
          options: decodeOptionsOrCount(arr[2], `${path}[2]`),
          minSelections: asNumber(arr[3], `${path}[3]`),
          maxSelections: asNumber(arr[4], `${path}[4]`),
        },
        required,
      );
    }
    case QuestionTag.Ranking: {
      const required = readRequired(arr, 5, path);
      return withRequired(
        {
          type: "ranking",
          prompt,
          options: decodeOptionsOrCount(arr[2], `${path}[2]`),
          minRanked: asNumber(arr[3], `${path}[3]`),
          maxRanked: asNumber(arr[4], `${path}[4]`),
        },
        required,
      );
    }
    case QuestionTag.NumericRange: {
      const required = readRequired(arr, 3, path);
      return withRequired(
        {
          type: "numericRange",
          prompt,
          constraints: decodeNumericConstraints(arr[2], `${path}[2]`),
        },
        required,
      );
    }
    case QuestionTag.PointsAllocation: {
      const required = readRequired(arr, 4, path);
      return withRequired(
        {
          type: "pointsAllocation",
          prompt,
          options: decodeOptionsOrCount(arr[2], `${path}[2]`),
          budget: asNumber(arr[3], `${path}[3]`),
        },
        required,
      );
    }
    case QuestionTag.Rating: {
      const required = readRequired(arr, 4, path);
      return withRequired(
        {
          type: "rating",
          prompt,
          options: decodeOptionsOrCount(arr[2], `${path}[2]`),
          scale: decodeRatingScale(arr[3], `${path}[3]`),
        },
        required,
      );
    }
    default:
      return fail(`unknown question tag ${tag}`, path);
  }
};

// ----------------------------------------------------------------------------
// Answers
// ----------------------------------------------------------------------------

const decodeUintPairs = <T>(
  m: Metadatum,
  path: string,
  make: (a: number, b: bigint) => T,
): T[] => {
  const arr = asList(m, path);
  return arr.map((pair, i) => {
    const p = asList(pair, `${path}[${i}]`);
    expectLen(p, 2, 2, `${path}[${i}]`);
    return make(
      asNumber(p[0], `${path}[${i}][0]`),
      asInt(p[1], `${path}[${i}][1]`),
    );
  });
};

export const decodeAnswerItem = (m: Metadatum, path = "answer"): AnswerItem => {
  const arr = asList(m, path);
  const tag = asNumber(arr[0], `${path}[0]`);
  const questionIndex = asNumber(arr[1], `${path}[1]`);
  switch (tag) {
    case QuestionTag.Custom:
      expectLen(arr, 3, 3, path);
      return { type: "custom", questionIndex, value: arr[2] };
    case QuestionTag.SingleChoice:
      expectLen(arr, 3, 3, path);
      return {
        type: "singleChoice",
        questionIndex,
        optionIndex: asNumber(arr[2], `${path}[2]`),
      };
    case QuestionTag.MultiSelect: {
      expectLen(arr, 3, 3, path);
      const indices = asList(arr[2], `${path}[2]`);
      return {
        type: "multiSelect",
        questionIndex,
        optionIndices: indices.map((x, i) => asNumber(x, `${path}[2][${i}]`)),
      };
    }
    case QuestionTag.Ranking: {
      expectLen(arr, 3, 3, path);
      const order = asList(arr[2], `${path}[2]`);
      return {
        type: "ranking",
        questionIndex,
        ranking: order.map((x, i) => asNumber(x, `${path}[2][${i}]`)),
      };
    }
    case QuestionTag.NumericRange:
      expectLen(arr, 3, 3, path);
      return {
        type: "numeric",
        questionIndex,
        value: asInt(arr[2], `${path}[2]`),
      };
    case QuestionTag.PointsAllocation:
      expectLen(arr, 3, 3, path);
      return {
        type: "pointsAllocation",
        questionIndex,
        allocations: decodeUintPairs<PointsAllocation>(
          arr[2],
          `${path}[2]`,
          (optionIndex, points) => ({ optionIndex, points: Number(points) }),
        ),
      };
    case QuestionTag.Rating:
      expectLen(arr, 3, 3, path);
      return {
        type: "rating",
        questionIndex,
        ratings: decodeUintPairs<Rating>(
          arr[2],
          `${path}[2]`,
          (optionIndex, rating) => ({ optionIndex, rating }),
        ),
      };
    default:
      return fail(`unknown answer tag ${tag}`, path);
  }
};

const decodeResponseAnswers = (
  m: Metadatum,
  path = "answers",
): ResponseAnswers => {
  // Sealed: byte string, or array of byte strings (chunked_bytes).
  // Public: array of answer items (each an array).
  if (isBytes(m)) {
    return { type: "sealed", ciphertext: decodeChunkedBytes(m) };
  }
  const arr = asList(m, path);
  if (arr.length > 0 && isBytes(arr[0])) {
    return { type: "sealed", ciphertext: decodeChunkedBytes(m) };
  }
  return {
    type: "public",
    answers: arr.map((a, i) => decodeAnswerItem(a, `${path}[${i}]`)),
  };
};

// ----------------------------------------------------------------------------
// Top-level records
// ----------------------------------------------------------------------------

export const decodeSurveyDefinition = (
  m: Metadatum,
  path = "definition",
): SurveyDefinition => {
  const map = asMap(m, path);
  const get = (k: number, name: string): Metadatum => {
    const v = getKey(map, k);
    if (v === undefined) fail(`missing key ${k} (${name})`, path);
    return v as Metadatum;
  };
  const questions = asList(get(7, "questions"), `${path}.questions`);
  const anchor = getKey(map, 8);
  return {
    specVersion: asNumber(get(0, "specVersion"), `${path}.specVersion`),
    owner: decodeCredential(get(1, "owner"), `${path}.owner`),
    title: text(get(2, "title"), `${path}.title`),
    description: text(get(3, "description"), `${path}.description`),
    eligibleRoles: asList(get(4, "eligibleRoles"), `${path}.eligibleRoles`).map(
      (r, i) => decodeRole(r, `${path}.eligibleRoles[${i}]`),
    ),
    endEpoch: asNumber(get(5, "endEpoch"), `${path}.endEpoch`),
    submissionMode: decodeSubmissionMode(
      get(6, "submissionMode"),
      `${path}.submissionMode`,
    ),
    questions: questions.map((q, i) =>
      decodeQuestion(q, `${path}.questions[${i}]`),
    ),
    ...(anchor !== undefined
      ? { contentAnchor: decodeContentAnchor(anchor, `${path}.contentAnchor`) }
      : {}),
  };
};

export const decodeSurveyResponse = (
  m: Metadatum,
  path = "response",
): SurveyResponse => {
  const map = asMap(m, path);
  const get = (k: number, name: string): Metadatum => {
    const v = getKey(map, k);
    if (v === undefined) fail(`missing key ${k} (${name})`, path);
    return v as Metadatum;
  };
  const rationale = getKey(map, 5);
  return {
    specVersion: asNumber(get(0, "specVersion"), `${path}.specVersion`),
    surveyRef: decodeSurveyRef(get(1, "surveyRef"), `${path}.surveyRef`),
    role: decodeRole(get(2, "role"), `${path}.role`),
    credential: decodeCredential(get(3, "credential"), `${path}.credential`),
    answers: decodeResponseAnswers(get(4, "answers"), `${path}.answers`),
    ...(rationale !== undefined
      ? { rationale: decodeContentAnchor(rationale, `${path}.rationale`) }
      : {}),
  };
};

export const decodeSurveyCancellation = (
  m: Metadatum,
  path = "cancellation",
): SurveyCancellation => decodeSurveyRef(m, path);

/** Decode a top-level CIP-179 payload (`cip_179_payload`). */
export const decodePayload = (
  m: Metadatum,
  path = "payload",
): Cip179Payload => {
  const arr = asList(m, path);
  expectLen(arr, 2, 2, path);
  const tag = asNumber(arr[0], `${path}[0]`);
  const items = asList(arr[1], `${path}[1]`);
  if (items.length === 0) fail("payload array must be non-empty", `${path}[1]`);
  switch (tag) {
    case PayloadTag.Definitions:
      return {
        type: "definitions",
        definitions: items.map((d, i) =>
          decodeSurveyDefinition(d, `${path}.definitions[${i}]`),
        ),
      };
    case PayloadTag.Responses:
      return {
        type: "responses",
        responses: items.map((r, i) =>
          decodeSurveyResponse(r, `${path}.responses[${i}]`),
        ),
      };
    case PayloadTag.Cancellations:
      return {
        type: "cancellations",
        cancellations: items.map((c, i) =>
          decodeSurveyCancellation(c, `${path}.cancellations[${i}]`),
        ),
      };
    default:
      return fail(`unknown payload tag ${tag}`, path);
  }
};

/**
 * Decode a labelled metadata map `{ 17 => payload }` into a CIP-179 payload.
 * Throws if the label-17 entry is absent.
 */
export const decodeMetadata = (
  m: Metadatum,
  path = "metadata",
): Cip179Payload => {
  const map = asMap(m, path);
  const entry = getKey(map, METADATA_LABEL);
  if (entry === undefined) {
    fail(`no metadata under label ${METADATA_LABEL}`, path);
  }
  return decodePayload(entry as Metadatum, `${path}[${METADATA_LABEL}]`);
};
