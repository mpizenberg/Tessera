/**
 * Render a {@link Metadatum} tree as CBOR **diagnostic notation** (RFC 8949 §8) —
 * the human-readable view of what gets serialized on-chain. This is a structural
 * pretty-printer over the metadatum tree, not a CBOR (de)serializer: it never
 * touches bytes, so it stays in the pure layer and doesn't pull in evolution-sdk.
 *
 * Mapping: int → decimal, text → "quoted", bytes → h'hex', array → [ … ],
 * map → { k: v, … }. Arrays and maps are pretty-printed with indentation;
 * empty ones collapse to `[]` / `{}`.
 */

import type { Metadatum } from "cip-179";

import { bytesToHex } from "./hex";

export function metadatumToDiagnostic(m: Metadatum, indent = 0): string {
  const pad = "  ".repeat(indent);
  const padIn = "  ".repeat(indent + 1);

  if (typeof m === "bigint") return m.toString();
  // JSON.stringify gives a double-quoted, backslash-escaped string — the same
  // lexical form CBOR diagnostic notation uses for text strings.
  if (typeof m === "string") return JSON.stringify(m);
  if (m instanceof Uint8Array) return `h'${bytesToHex(m)}'`;

  if (Array.isArray(m)) {
    if (m.length === 0) return "[]";
    const items = m.map((x) => padIn + metadatumToDiagnostic(x, indent + 1));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  // The only remaining variant is a metadatum map.
  const map = m as ReadonlyMap<Metadatum, Metadatum>;
  if (map.size === 0) return "{}";
  const entries: string[] = [];
  for (const [k, v] of map) {
    entries.push(
      `${padIn}${metadatumToDiagnostic(k, indent + 1)}: ${metadatumToDiagnostic(v, indent + 1)}`,
    );
  }
  return `{\n${entries.join(",\n")}\n${pad}}`;
}
