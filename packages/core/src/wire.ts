/**
 * JSON-safe wire codec for decoded CIP-179 records.
 *
 * The decoded domain types (from `cip-179`) carry `Uint8Array`, `bigint`, and —
 * inside custom answers — `Map`, none of which survive `JSON.stringify`
 * losslessly (`stringify` throws on BigInt and drops typed-array structure;
 * `parse` coerces big numbers to lossy doubles). This codec maps any such value
 * to/from a tagged JSON-safe form, so a snapshot can cross HTTP and SQLite and be
 * reconstructed byte-for-byte.
 *
 * Conventions mirror the artifact format (`backend/ARCHITECTURE.md` §7): bytes →
 * hex, big integers → decimal strings. Each tag is an object with a single
 * `$`-prefixed key. Decoded CIP-179 data never produces such an object itself
 * (its map keys are integers or plain strings, its values are the primitives
 * above), so the tags are unambiguous.
 */

import { bytesToHex, hexToBytes } from "./hex";

/** Recursively replace bytes/bigint/Map with tagged JSON-safe equivalents. */
export function toJsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Map) {
    return {
      $map: [...value.entries()].map(([k, v]) => [
        toJsonSafe(k),
        toJsonSafe(v),
      ]),
    };
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
