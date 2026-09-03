/**
 * The mock responder — what a real host derives from a connected wallet — and
 * a printer for the emitted payload. Roles are cip-179 numbers (0 DRep,
 * 3 Stakeholder, 4 Keyholder).
 */

import type { TesseraRespondProps } from "cardano-tessera-respond-react";

const bytes = (length: number, fill: number): Uint8Array =>
  new Uint8Array(length).fill(fill);

export const responder: TesseraRespondProps["responder"] = {
  0: { type: "key", keyHash: bytes(28, 0xcc) },
  3: { type: "key", keyHash: bytes(28, 0xbb) },
  4: { type: "key", keyHash: bytes(28, 0xaa) },
};

/** JSON with the payload's bigints, byte strings, and Maps made printable. */
export function show(value: unknown): string {
  const plain = (v: unknown): unknown => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Uint8Array)
      return `0x${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (v instanceof Map)
      return Object.fromEntries(
        [...v.entries()].map(([k, x]) => [String(plain(k)), plain(x)]),
      );
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, plain(x)]),
      );
    return v;
  };
  return JSON.stringify(plain(value), null, 2);
}
