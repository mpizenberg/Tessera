/**
 * Typed decoders for wire-form records: {@link fromJsonSafe} followed by a
 * structural check, so a record that crossed HTTP or SQLite comes back as the
 * type it claims or fails with the offending path — never as a cast whose
 * shape error surfaces as a crash several calls later.
 *
 * The check is shape, not semantics: every field the record type declares is
 * present with the declared primitive or union shape, and nothing else is
 * judged. A decoded definition may still be spec-invalid — `validateDefinition`
 * and `validateResponse` remain the judges of that — and byte lengths are not
 * re-measured here, since the metadatum decoder already refused a wrong-sized
 * hash before the record ever reached a wire. Unknown keys are dropped rather
 * than refused, matching the metadatum decoders' leniency toward future fields.
 *
 * @module
 */

import { ROLE_VALUES, type Role } from "../constants.js";
import { Cip179DecodeError } from "../errors.js";
import { isMetadatum } from "../metadatum.js";
import type {
  AnswerItem,
  ContentAnchor,
  Credential,
  NumericConstraints,
  OptionsOrCount,
  Question,
  RatingScale,
  ResponseAnswers,
  SubmissionMode,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
} from "../types.js";
import type {
  CancellationRecord,
  ChainPos,
  MechanismAProof,
  NativeScriptInfo,
  ResponseRecord,
  SurveyRecord,
} from "../domain/records.js";
import { fromJsonSafe } from "./wire.js";

// ----------------------------------------------------------------------------
// Path-aware primitives
// ----------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const fail = (message: string, path: string): never => {
  throw new Cip179DecodeError(message, path);
};

const at = (path: string, key: string): string =>
  path ? `${path}.${key}` : key;
const idx = (path: string, i: number): string => `${path}[${i}]`;

const obj = (v: unknown, path: string): Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Obj)
    : fail(v === undefined ? "missing" : "expected object", path);

const str = (v: unknown, path: string): string =>
  typeof v === "string"
    ? v
    : fail(v === undefined ? "missing" : "expected string", path);

const int = (v: unknown, path: string): number =>
  typeof v === "number" && Number.isSafeInteger(v)
    ? v
    : fail(v === undefined ? "missing" : "expected integer", path);

const big = (v: unknown, path: string): bigint =>
  typeof v === "bigint"
    ? v
    : fail(v === undefined ? "missing" : "expected bigint", path);

const bool = (v: unknown, path: string): boolean =>
  typeof v === "boolean"
    ? v
    : fail(v === undefined ? "missing" : "expected boolean", path);

const bytes = (v: unknown, path: string): Uint8Array =>
  v instanceof Uint8Array
    ? v
    : fail(v === undefined ? "missing" : "expected bytes", path);

const list = <T>(
  v: unknown,
  path: string,
  item: (x: unknown, p: string) => T,
): T[] =>
  Array.isArray(v)
    ? v.map((x, i) => item(x, idx(path, i)))
    : fail(v === undefined ? "missing" : "expected array", path);

/** Present-or-absent: `undefined` stays absent, anything else must decode. */
const opt = <T>(
  v: unknown,
  path: string,
  item: (x: unknown, p: string) => T,
): T | undefined => (v === undefined ? undefined : item(v, path));

/** Present-or-null: `null` is a value here, only `undefined` is absent. */
const nullable = <T>(
  v: unknown,
  path: string,
  item: (x: unknown, p: string) => T,
): T | null => (v === null ? null : item(v, path));

const role = (v: unknown, path: string): Role =>
  (ROLE_VALUES as readonly number[]).includes(int(v, path))
    ? (v as Role)
    : fail(`unknown role ${String(v)}`, path);

// ----------------------------------------------------------------------------
// Codec-level shapes (`cip-179` types)
// ----------------------------------------------------------------------------

const surveyRef = (v: unknown, path: string): SurveyRef => {
  const o = obj(v, path);
  return {
    txId: bytes(o.txId, at(path, "txId")),
    index: int(o.index, at(path, "index")),
  };
};

const contentAnchor = (v: unknown, path: string): ContentAnchor => {
  const o = obj(v, path);
  return {
    uri: str(o.uri, at(path, "uri")),
    hash: bytes(o.hash, at(path, "hash")),
  };
};

const credential = (v: unknown, path: string): Credential => {
  const o = obj(v, path);
  switch (o.type) {
    case "key":
      return { type: "key", keyHash: bytes(o.keyHash, at(path, "keyHash")) };
    case "script":
      return {
        type: "script",
        scriptHash: bytes(o.scriptHash, at(path, "scriptHash")),
      };
    default:
      return fail(
        `unknown credential type ${String(o.type)}`,
        at(path, "type"),
      );
  }
};

const submissionMode = (v: unknown, path: string): SubmissionMode => {
  const o = obj(v, path);
  switch (o.type) {
    case "public":
      return { type: "public" };
    case "sealed":
      return {
        type: "sealed",
        chainHash: bytes(o.chainHash, at(path, "chainHash")),
        round: int(o.round, at(path, "round")),
        paddingSize: int(o.paddingSize, at(path, "paddingSize")),
      };
    default:
      return fail(
        `unknown submission mode ${String(o.type)}`,
        at(path, "type"),
      );
  }
};

const optionsOrCount = (v: unknown, path: string): OptionsOrCount => {
  const o = obj(v, path);
  switch (o.type) {
    case "options":
      return {
        type: "options",
        labels: list(o.labels, at(path, "labels"), str),
      };
    case "count":
      return { type: "count", count: int(o.count, at(path, "count")) };
    default:
      return fail(`unknown options type ${String(o.type)}`, at(path, "type"));
  }
};

const numericConstraints = (v: unknown, path: string): NumericConstraints => {
  const o = obj(v, path);
  const step = opt(o.step, at(path, "step"), big);
  return {
    min: big(o.min, at(path, "min")),
    max: big(o.max, at(path, "max")),
    ...(step === undefined ? {} : { step }),
  };
};

const ratingScale = (v: unknown, path: string): RatingScale => {
  const o = obj(v, path);
  switch (o.type) {
    case "numeric":
      return {
        type: "numeric",
        constraints: numericConstraints(o.constraints, at(path, "constraints")),
      };
    case "labels":
      return {
        type: "labels",
        labels: list(o.labels, at(path, "labels"), str),
      };
    case "count":
      return { type: "count", count: int(o.count, at(path, "count")) };
    default:
      return fail(`unknown scale type ${String(o.type)}`, at(path, "type"));
  }
};

const question = (v: unknown, path: string): Question => {
  const o = obj(v, path);
  const prompt = str(o.prompt, at(path, "prompt"));
  const required = opt(o.required, at(path, "required"), bool);
  const base = { prompt, ...(required === undefined ? {} : { required }) };
  const options = () => optionsOrCount(o.options, at(path, "options"));
  switch (o.type) {
    case "custom":
      return {
        ...base,
        type: "custom",
        methodSchema: contentAnchor(o.methodSchema, at(path, "methodSchema")),
      };
    case "singleChoice":
      return { ...base, type: "singleChoice", options: options() };
    case "multiSelect":
      return {
        ...base,
        type: "multiSelect",
        options: options(),
        minSelections: int(o.minSelections, at(path, "minSelections")),
        maxSelections: int(o.maxSelections, at(path, "maxSelections")),
      };
    case "ranking":
      return {
        ...base,
        type: "ranking",
        options: options(),
        minRanked: int(o.minRanked, at(path, "minRanked")),
        maxRanked: int(o.maxRanked, at(path, "maxRanked")),
      };
    case "numericRange":
      return {
        ...base,
        type: "numericRange",
        constraints: numericConstraints(o.constraints, at(path, "constraints")),
      };
    case "pointsAllocation":
      return {
        ...base,
        type: "pointsAllocation",
        options: options(),
        budget: int(o.budget, at(path, "budget")),
      };
    case "rating":
      return {
        ...base,
        type: "rating",
        options: options(),
        scale: ratingScale(o.scale, at(path, "scale")),
        requireAll: bool(o.requireAll, at(path, "requireAll")),
      };
    default:
      return fail(`unknown question type ${String(o.type)}`, at(path, "type"));
  }
};

const definition = (v: unknown, path: string): SurveyDefinition => {
  const o = obj(v, path);
  const contentAnchorValue = opt(
    o.contentAnchor,
    at(path, "contentAnchor"),
    contentAnchor,
  );
  return {
    specVersion: int(o.specVersion, at(path, "specVersion")),
    owner: credential(o.owner, at(path, "owner")),
    title: str(o.title, at(path, "title")),
    description: str(o.description, at(path, "description")),
    eligibleRoles: list(o.eligibleRoles, at(path, "eligibleRoles"), role),
    endEpoch: int(o.endEpoch, at(path, "endEpoch")),
    submissionMode: submissionMode(
      o.submissionMode,
      at(path, "submissionMode"),
    ),
    questions: list(o.questions, at(path, "questions"), question),
    ...(contentAnchorValue === undefined
      ? {}
      : { contentAnchor: contentAnchorValue }),
  };
};

const answerItem = (v: unknown, path: string): AnswerItem => {
  const o = obj(v, path);
  const questionIndex = int(o.questionIndex, at(path, "questionIndex"));
  switch (o.type) {
    case "custom":
      return isMetadatum(o.value)
        ? { questionIndex, type: "custom", value: o.value }
        : fail("expected metadatum", at(path, "value"));
    case "singleChoice":
      return {
        questionIndex,
        type: "singleChoice",
        optionIndex: int(o.optionIndex, at(path, "optionIndex")),
      };
    case "multiSelect":
      return {
        questionIndex,
        type: "multiSelect",
        optionIndices: list(o.optionIndices, at(path, "optionIndices"), int),
      };
    case "ranking":
      return {
        questionIndex,
        type: "ranking",
        ranking: list(o.ranking, at(path, "ranking"), int),
      };
    case "numeric":
      return {
        questionIndex,
        type: "numeric",
        value: big(o.value, at(path, "value")),
      };
    case "pointsAllocation":
      return {
        questionIndex,
        type: "pointsAllocation",
        allocations: list(o.allocations, at(path, "allocations"), (x, p) => {
          const a = obj(x, p);
          return {
            optionIndex: int(a.optionIndex, at(p, "optionIndex")),
            points: int(a.points, at(p, "points")),
          };
        }),
      };
    case "rating":
      return {
        questionIndex,
        type: "rating",
        ratings: list(o.ratings, at(path, "ratings"), (x, p) => {
          const r = obj(x, p);
          return {
            optionIndex: int(r.optionIndex, at(p, "optionIndex")),
            rating: big(r.rating, at(p, "rating")),
          };
        }),
      };
    default:
      return fail(`unknown answer type ${String(o.type)}`, at(path, "type"));
  }
};

const responseAnswers = (v: unknown, path: string): ResponseAnswers => {
  const o = obj(v, path);
  switch (o.type) {
    case "public":
      return {
        type: "public",
        answers: list(o.answers, at(path, "answers"), answerItem),
      };
    case "sealed":
      return {
        type: "sealed",
        ciphertext: bytes(o.ciphertext, at(path, "ciphertext")),
      };
    default:
      return fail(`unknown answers type ${String(o.type)}`, at(path, "type"));
  }
};

const response = (v: unknown, path: string): SurveyResponse => {
  const o = obj(v, path);
  const rationale = opt(o.rationale, at(path, "rationale"), contentAnchor);
  return {
    specVersion: int(o.specVersion, at(path, "specVersion")),
    surveyRef: surveyRef(o.surveyRef, at(path, "surveyRef")),
    role: role(o.role, at(path, "role")),
    credential: credential(o.credential, at(path, "credential")),
    answers: responseAnswers(o.answers, at(path, "answers")),
    ...(rationale === undefined ? {} : { rationale }),
  };
};

// ----------------------------------------------------------------------------
// Record-level shapes (`cip-179/domain`)
// ----------------------------------------------------------------------------

const nativeScript = (v: unknown, path: string): NativeScriptInfo => {
  const o = obj(v, path);
  const scripts = () => list(o.scripts, at(path, "scripts"), nativeScript);
  switch (o.kind) {
    case "sig":
      return { kind: "sig", keyHash: str(o.keyHash, at(path, "keyHash")) };
    case "all":
      return { kind: "all", scripts: scripts() };
    case "any":
      return { kind: "any", scripts: scripts() };
    case "atLeast":
      return {
        kind: "atLeast",
        required: int(o.required, at(path, "required")),
        scripts: scripts(),
      };
    case "timelock":
      return { kind: "timelock" };
    default:
      return fail(
        `unknown native script kind ${String(o.kind)}`,
        at(path, "kind"),
      );
  }
};

const mechanismAProof = (v: unknown, path: string): MechanismAProof => {
  const o = obj(v, path);
  return {
    requiredSigners: list(o.requiredSigners, at(path, "requiredSigners"), str),
    nativeScripts: list(o.nativeScripts, at(path, "nativeScripts"), (x, p) => {
      const n = obj(x, p);
      return {
        scriptHash: str(n.scriptHash, at(p, "scriptHash")),
        script: nativeScript(n.script, at(p, "script")),
      };
    }),
  };
};

const chainPos = (o: Obj, path: string): ChainPos => ({
  txHash: str(o.txHash, at(path, "txHash")),
  slot: int(o.slot, at(path, "slot")),
  epochNo: int(o.epochNo, at(path, "epochNo")),
});

/**
 * A wire-form {@link SurveyRecord} (the `toJsonSafe` image, parsed from JSON)
 * back to the record, or a {@link Cip179DecodeError} naming the field that
 * does not fit.
 */
export function decodeSurveyRecord(json: unknown): SurveyRecord {
  const o = obj(fromJsonSafe(json), "");
  const proof = opt(o.proof, "proof", (x, p) =>
    nullable(x, p, mechanismAProof),
  );
  return {
    ...chainPos(o, ""),
    ref: surveyRef(o.ref, "ref"),
    definition: definition(o.definition, "definition"),
    ...(proof === undefined ? {} : { proof }),
  };
}

/** A wire-form {@link ResponseRecord} back to the record; see {@link decodeSurveyRecord}. */
export function decodeResponseRecord(json: unknown): ResponseRecord {
  const o = obj(fromJsonSafe(json), "");
  const blockIndex = opt(o.blockIndex, "blockIndex", int);
  return {
    ...chainPos(o, ""),
    responseIndex: int(o.responseIndex, "responseIndex"),
    ...(blockIndex === undefined ? {} : { blockIndex }),
    response: response(o.response, "response"),
  };
}

/** A wire-form {@link CancellationRecord} back to the record; see {@link decodeSurveyRecord}. */
export function decodeCancellationRecord(json: unknown): CancellationRecord {
  const o = obj(fromJsonSafe(json), "");
  return {
    ...chainPos(o, ""),
    target: surveyRef(o.target, "target"),
    proof: nullable(o.proof, "proof", mechanismAProof),
  };
}
