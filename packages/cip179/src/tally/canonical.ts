/**
 * Canonical JSON + content hashing — the byte-level foundation of re-verifiable
 * tally artifacts (`backend/ARCHITECTURE.md` §7). Emitter and verifier both
 * serialize through exactly this code, so "same tally" ⇔ "same bytes" ⇔ "same
 * hash" holds by construction.
 *
 * The serialization is a strict subset of RFC 8785 (JCS): object keys sorted by
 * UTF-16 code units, no whitespace, and **integers only** — floats have no
 * canonical text form we're willing to pin, and lovelace-scale values overflow
 * doubles, so anything fractional or beyond `Number.MAX_SAFE_INTEGER` must be
 * carried as a decimal string by the caller (the artifact model does).
 */

import { blake2b } from "@noble/hashes/blake2.js";

import { bytesToHex } from "../domain/index.js";

/**
 * Serialize a JSON-plain value canonically. Throws on anything without a
 * pinned canonical form: non-integer or unsafe numbers, bigints (serialize as
 * decimal strings), and non-plain objects (Map, Uint8Array, class instances).
 * `undefined` object properties are omitted, as in `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, "$");
}

function canon(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(
          `canonicalJson: non-integer or unsafe number at ${path} (${value}) — carry fractional/big values as decimal strings`,
        );
      }
      return String(value); // String(-0) === "0", so -0 canonicalizes too
    case "bigint":
      throw new Error(
        `canonicalJson: bigint at ${path} — serialize it as a decimal string`,
      );
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => canon(v, `${path}[${i}]`)).join(",")}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`canonicalJson: non-plain object at ${path}`);
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries
        .map(([k, v]) => `${JSON.stringify(k)}:${canon(v, `${path}.${k}`)}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/**
 * blake2b-256 of the UTF-8 bytes of `text`, hex-encoded. Blake2b is the hash
 * family everything on Cardano is built on, so it's available to any tooling
 * that can already talk to the chain.
 */
export function blake2b256Hex(text: string): string {
  return bytesToHex(blake2b(new TextEncoder().encode(text), { dkLen: 32 }));
}
