/**
 * Hard-coded mock props so the example runs fully offline — the widget never
 * fetches; a real host supplies these from its indexer and wallet. Roles are
 * cip-179 numbers (0 DRep, 3 Stakeholder, 4 Keyholder); `specVersion` is the
 * current cip-179 SPEC_VERSION.
 */

import type { TesseraRespondProps } from "cardano-tessera-respond/artifact";

const bytes = (length: number, fill: number): Uint8Array =>
  new Uint8Array(length).fill(fill);

export const definition: TesseraRespondProps["definition"] = {
  specVersion: 5,
  owner: { type: "key", keyHash: bytes(28, 0x00) },
  title: "Svelte host demo survey",
  description:
    "Answer and submit to see the label-17 payload your app would attach to a transaction.",
  eligibleRoles: [0, 3, 4],
  endEpoch: 600,
  submissionMode: { type: "public" },
  questions: [
    {
      type: "singleChoice",
      prompt: "Which upgrade should ship first?",
      required: true,
      options: {
        type: "options",
        labels: ["Scaling", "Governance polish", "Developer tooling"],
      },
    },
    {
      type: "numericRange",
      prompt: "Suggested treasury cut (%)?",
      constraints: { min: 0n, max: 100n, step: 5n },
    },
  ],
};

export const surveyRef: TesseraRespondProps["surveyRef"] = {
  txId: bytes(32, 0x11),
  index: 0,
};

export const responder: TesseraRespondProps["responder"] = {
  0: { type: "key", keyHash: bytes(28, 0xcc) },
  3: { type: "key", keyHash: bytes(28, 0xbb) },
  4: { type: "key", keyHash: bytes(28, 0xaa) },
};

export const TIP_EPOCH = 500;

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
