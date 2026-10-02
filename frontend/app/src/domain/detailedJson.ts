/**
 * Transaction metadata as cardano-cli's detailed JSON schema
 * (`--json-metadata-detailed-schema`): `{"<label>": value}`, where each value
 * is one of `{"int": n}`, `{"bytes": "<hex>"}`, `{"string": s}`,
 * `{"list": [values]}` or `{"map": [{"k": value, "v": value}]}`.
 *
 * The schema is a lossless image of a ledger metadatum: map entries keep their
 * order, and integers are exact JSON numbers of any size (read through the
 * parser's source text, written as raw digits).
 */

import {
  MAX_CHUNK_BYTES,
  isBytes,
  isInt,
  isList,
  isText,
  utf8ByteLength,
  type Metadatum,
} from "cip-179";
import { bytesToHex, hexToBytes } from "cip-179/domain";

/**
 * cardano-cli's metadata integer range. The ledger also accepts -2^64, but a
 * file cardano-cli refuses is no use as an export.
 */
export const METADATA_INT_MAX = 2n ** 64n - 1n;

export const DETAILED_JSON_PROBLEM_CODES = [
  "detailedJson.notJson",
  "detailedJson.repeatedJsonKey",
  "detailedJson.notObject",
  "detailedJson.badLabel",
  "detailedJson.badValue",
  "detailedJson.notInteger",
  "detailedJson.intOutOfRange",
  "detailedJson.badHex",
  "detailedJson.tooLong",
  "detailedJson.badMapEntry",
  "detailedJson.duplicateKey",
] as const;

export type DetailedJsonProblemCode =
  (typeof DETAILED_JSON_PROBLEM_CODES)[number];

/** Why a file is not detailed-schema metadata; `where` locates the value. */
export interface DetailedJsonProblem {
  readonly code: DetailedJsonProblemCode;
  readonly params?: Readonly<Record<string, string>>;
}

/** Metadata by label. */
export type Metadata = ReadonlyMap<bigint, Metadatum>;

/** The metadata as detailed-schema JSON text, indented. */
export function toDetailedJson(metadata: Metadata): string {
  return JSON.stringify(
    Object.fromEntries(
      [...metadata].map(([label, value]) => [String(label), plain(value)]),
    ),
    null,
    2,
  );
}

function plain(m: Metadatum): unknown {
  if (isInt(m)) return { int: rawJson(String(m)) };
  if (isText(m)) return { string: m };
  if (isBytes(m)) return { bytes: bytesToHex(m) };
  if (isList(m)) return { list: m.map(plain) };
  return { map: [...m].map(([k, v]) => ({ k: plain(k), v: plain(v) })) };
}

// `JSON.rawJSON` and the reviver's `context.source` are JSON.parse source text
// access (ES2025), present everywhere the app runs; the TypeScript lib in use
// does not declare them yet.
const rawJson = (digits: string): unknown =>
  (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(digits);

type Reviver = (key: string, value: unknown) => unknown;

/** Every JSON number becomes a bigint when its source text is an integer. */
const exactIntegers = ((
  _key: string,
  value: unknown,
  context: { source: string },
) =>
  typeof value === "number" && /^-?\d+$/.test(context.source)
    ? BigInt(context.source)
    : value) as Reviver;

class Rejected {
  constructor(readonly problem: DetailedJsonProblem) {}
}

const reject = (code: DetailedJsonProblemCode, where?: string): Rejected =>
  new Rejected(where === undefined ? { code } : { code, params: { where } });

/** Read detailed-schema JSON text; the first problem found when it is not. */
export function fromDetailedJson(
  text: string,
): { metadata: Metadata } | { problem: DetailedJsonProblem } {
  let json: unknown;
  try {
    json = JSON.parse(text, exactIntegers);
  } catch {
    return { problem: { code: "detailedJson.notJson" } };
  }
  const repeated = repeatedJsonKey(text);
  if (repeated !== undefined)
    return {
      problem: {
        code: "detailedJson.repeatedJsonKey",
        params: { where: repeated },
      },
    };
  try {
    if (!isObject(json)) throw reject("detailedJson.notObject");
    const metadata = new Map<bigint, Metadatum>();
    for (const [label, value] of Object.entries(json)) {
      if (!/^(0|[1-9]\d*)$/.test(label) || BigInt(label) > METADATA_INT_MAX)
        throw reject("detailedJson.badLabel", label);
      metadata.set(BigInt(label), decode(value, label));
    }
    return { metadata };
  } catch (e) {
    if (e instanceof Rejected) return { problem: e.problem };
    throw e;
  }
}

/**
 * The path of the first key written twice in one object of `text` (JSON that
 * parses). `JSON.parse` keeps the last of the two and cardano-cli the first,
 * so such a file would import as something other than what cardano-cli
 * publishes.
 */
function repeatedJsonKey(text: string): string | undefined {
  interface Frame {
    readonly path: string;
    /** Keys seen so far, for an object; undefined for an array. */
    readonly keys?: Set<string>;
    key: string;
    index: number;
    expectKey: boolean;
  }
  const stack: Frame[] = [];
  const child = (top: Frame | undefined): string =>
    top === undefined
      ? ""
      : top.keys
        ? top.path === ""
          ? top.key
          : `${top.path}.${top.key}`
        : `${top.path}[${top.index}]`;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        top.key = key;
        if (top.keys.has(key)) return child(top);
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end;
    } else if (c === "{" || c === "[") {
      stack.push({
        path: child(top),
        ...(c === "{" ? { keys: new Set<string>() } : {}),
        key: "",
        index: 0,
        expectKey: c === "{",
      });
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === "," && top) {
      if (top.keys) top.expectKey = true;
      else top.index++;
    }
  }
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function decode(json: unknown, where: string): Metadatum {
  if (!isObject(json)) throw reject("detailedJson.badValue", where);
  const keys = Object.keys(json);
  if (keys.length !== 1) throw reject("detailedJson.badValue", where);
  const tag = keys[0]!;
  const v = json[tag];
  const at = `${where}.${tag}`;
  switch (tag) {
    case "int":
      if (typeof v !== "bigint") throw reject("detailedJson.notInteger", at);
      if (v < -METADATA_INT_MAX || v > METADATA_INT_MAX)
        throw reject("detailedJson.intOutOfRange", at);
      return v;
    case "string":
      if (typeof v !== "string") throw reject("detailedJson.badValue", at);
      if (utf8ByteLength(v) > MAX_CHUNK_BYTES)
        throw reject("detailedJson.tooLong", at);
      return v;
    case "bytes": {
      if (typeof v !== "string" || !/^([0-9a-fA-F]{2})*$/.test(v))
        throw reject("detailedJson.badHex", at);
      const bytes = hexToBytes(v);
      if (bytes.length > MAX_CHUNK_BYTES)
        throw reject("detailedJson.tooLong", at);
      return bytes;
    }
    case "list":
      if (!Array.isArray(v)) throw reject("detailedJson.badValue", at);
      return v.map((item, i) => decode(item, `${at}[${i}]`));
    case "map": {
      if (!Array.isArray(v)) throw reject("detailedJson.badValue", at);
      const map = new Map<Metadatum, Metadatum>();
      // Keys compare by value: the same written form is the same key.
      const seen = new Set<string>();
      v.forEach((entry, i) => {
        const here = `${at}[${i}]`;
        if (
          !isObject(entry) ||
          Object.keys(entry).length !== 2 ||
          !("k" in entry) ||
          !("v" in entry)
        )
          throw reject("detailedJson.badMapEntry", here);
        const k = decode(entry.k, `${here}.k`);
        const written = JSON.stringify(plain(k));
        if (seen.has(written)) throw reject("detailedJson.duplicateKey", here);
        seen.add(written);
        map.set(k, decode(entry.v, `${here}.v`));
      });
      return map;
    }
    default:
      throw reject("detailedJson.badValue", where);
  }
}
