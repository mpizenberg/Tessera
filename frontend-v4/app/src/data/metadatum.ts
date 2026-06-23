/**
 * Adapter: Koios JSON metadata → generic CIP-179 `Metadatum` tree.
 *
 * Koios returns CBOR transaction metadata already decoded to JSON, using these
 * conventions (mirrored from the elm-cardano reference implementation):
 *
 *   CBOR int   → JSON number
 *   CBOR text  → JSON string
 *   CBOR bytes → JSON string prefixed with "0x"
 *   CBOR array → JSON array
 *   CBOR map   → JSON object (keys stringified)
 *
 * Known lossiness of this JSON form (not of CIP-179 itself):
 *   - JSON numbers lose precision above 2^53; CIP-179 integer *keys* are tiny
 *     (0–8) so they are safe, but large numeric *values* could be affected.
 *   - A text value that genuinely starts with "0x" is indistinguishable from
 *     bytes. CIP-179 titles/prompts realistically never do.
 *
 * Switching the data source to a CBOR-native indexer later removes both
 * caveats — which is exactly why the `DataSource` seam exists.
 */

import type { Metadatum } from "cip-179";

/** A Koios JSON metadata value (one label's payload). */
export type KoiosJson =
  | number
  | string
  | KoiosJson[]
  | { [key: string]: KoiosJson };

const HEX_RE = /^[0-9a-fA-F]*$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    // Not valid hex after the "0x" — treat the original as text instead.
    return new TextEncoder().encode("0x" + hex);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A Koios string: "0x…" → bytes, otherwise text. */
function stringToMetadatum(s: string): Metadatum {
  return s.startsWith("0x") ? hexToBytes(s.slice(2)) : s;
}

/** A Koios object key: integer if numeric, else the string heuristic. */
function keyToMetadatum(k: string): Metadatum {
  return /^-?\d+$/.test(k) ? BigInt(k) : stringToMetadatum(k);
}

/**
 * Cardano caps tx metadata nesting far below this; the bound just stops a
 * hand-crafted, pathologically deep payload from overflowing the stack here
 * (this input is fully attacker-controlled — anyone can post label-17 metadata).
 */
const MAX_DEPTH = 64;

/** Convert one Koios JSON metadata value into a `Metadatum` tree. */
export function koiosJsonToMetadatum(json: KoiosJson, depth = 0): Metadatum {
  if (depth > MAX_DEPTH) throw new Error("metadata nesting too deep");
  if (typeof json === "number") return BigInt(Math.trunc(json));
  if (typeof json === "string") return stringToMetadatum(json);
  if (Array.isArray(json))
    return json.map((v) => koiosJsonToMetadatum(v, depth + 1));
  const entries = Object.entries(json).map(
    ([k, v]) =>
      [keyToMetadatum(k), koiosJsonToMetadatum(v, depth + 1)] as const,
  );
  return new Map<Metadatum, Metadatum>(entries);
}
