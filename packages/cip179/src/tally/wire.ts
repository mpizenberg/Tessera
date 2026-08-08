/**
 * JSON-safe wire codec for decoded CIP-179 records.
 *
 * The decoded domain types (from `cip-179`) carry `Uint8Array`, `bigint`, and —
 * inside custom answers — `Map`, none of which survive `JSON.stringify`
 * losslessly (`stringify` throws on BigInt and drops typed-array structure;
 * `parse` coerces big numbers to lossy doubles). This codec maps any such value
 * to/from a tagged JSON-safe form, so a snapshot can cross HTTP and SQLite and be
 * reconstructed as an equal value — with map entry order normalized, see below.
 *
 * Conventions mirror the artifact format (`backend/TALLY-SPEC.md` §5): bytes →
 * hex, big integers → decimal strings. Each tag is an object with a single
 * `$`-prefixed key. Decoded CIP-179 data never produces such an object itself
 * (its map keys are integers or plain strings, its values are the primitives
 * above), so the tags are unambiguous.
 *
 * RULESET-PINNED-BEHAVIOR: `$map` entries are sorted by the canonical JSON of
 * the tagged key. A sealed artifact commits a custom answer's map this way, and
 * the entry order a CBOR decoder reports is its own business — sorting is what
 * lets an independent verifier reproduce the hash whatever codec it injects.
 * The `sealed-artifact` rule in `RULESET_DESCRIPTOR` states it; changing the
 * order is a ruleset change.
 */

import { bytesToHex, hexToBytes } from "../domain/index.js";
import { canonicalJson } from "./canonical.js";

/** Recursively replace bytes/bigint/Map with tagged JSON-safe equivalents. */
export function toJsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Map) {
    // Tagging first makes every key canonicalJson-safe (no raw bigint/bytes),
    // and sorting on that text is what keeps a sealed artifact independent of
    // the decoder that produced the map.
    const keyed = [...value.entries()].map(([k, v]) => {
      const pair: [unknown, unknown] = [toJsonSafe(k), toJsonSafe(v)];
      return { order: canonicalJson(pair[0]), pair };
    });
    keyed.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    return { $map: keyed.map((e) => e.pair) };
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // Skip `undefined` (optional fields) — JSON omits them anyway; keeping them
    // out means a decode round-trip yields the same "absent" shape.
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value; // string | number | boolean | null
}

/** Inverse of {@link toJsonSafe}: rebuild bytes/bigint/Map from their tags. */
export function fromJsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromJsonSafe);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["$bytes"] === "string") return hexToBytes(obj["$bytes"]);
    if (typeof obj["$bigint"] === "string") return BigInt(obj["$bigint"]);
    if (Array.isArray(obj["$map"])) {
      return new Map(
        (obj["$map"] as [unknown, unknown][]).map(([k, v]) => [
          fromJsonSafe(k),
          fromJsonSafe(v),
        ]),
      );
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = fromJsonSafe(v);
    return out;
  }
  return value;
}
