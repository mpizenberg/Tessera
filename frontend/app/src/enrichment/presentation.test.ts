import { describe, expect, it } from "vitest";
import type { Role, SurveyDefinition } from "cip-179";

import { displayDefinitionFor, presentationUnavailable } from "./presentation";

// --- fixtures ----------------------------------------------------------------

/** A minimal definition; `anchor` (a byte discriminator) makes it external. */
function def(title: string, anchor?: number): SurveyDefinition {
  return {
    specVersion: 5,
    owner: { type: "key", keyHash: Uint8Array.of(0) },
    title,
    description: "",
    eligibleRoles: [3] as Role[],
    endEpoch: 9,
    submissionMode: { type: "public" },
    questions: [],
    ...(anchor !== undefined && {
      contentAnchor: {
        uri: `ipfs://${anchor}`,
        hash: new Uint8Array(32).fill(anchor),
      },
    }),
  };
}

// --- displayDefinitionFor ----------------------------------------------------

describe("displayDefinitionFor", () => {
  it("returns the source unchanged when it is not external", () => {
    const b = def("B"); // no anchor
    // Even holding a ready enrichment for a *previous* external survey A, a
    // non-external B must render B — never A's labels (the reported bug: the
    // resource isn't re-run when the source turns non-external).
    const enrichedA = def("A enriched", 1);
    expect(displayDefinitionFor(b, enrichedA)).toBe(b);
    expect(displayDefinitionFor(undefined, enrichedA)).toBeUndefined();
  });

  it("returns the source while the enrichment is unresolved", () => {
    const a = def("A", 1);
    // Not yet resolved → no enriched value passed → on-chain fallback.
    expect(displayDefinitionFor(a, undefined)).toBe(a);
  });

  it("uses the enrichment only when it matches the current anchor", () => {
    const a = def("A", 1);
    const enrichedA = def("A enriched", 1);
    expect(displayDefinitionFor(a, enrichedA)).toBe(enrichedA);
  });

  it("rejects an enrichment resolved for a different anchor (survey switch)", () => {
    const b = def("B", 2);
    // Across a switch the resource still holds A's ready value until B's fetch
    // settles; A's anchor (1) ≠ B's anchor (2) → fall back to B on-chain.
    const enrichedA = def("A enriched", 1);
    expect(displayDefinitionFor(b, enrichedA)).toBe(b);
  });
});

// --- presentationUnavailable -------------------------------------------------

describe("presentationUnavailable", () => {
  it("is true only for an external survey whose settled fetch errored", () => {
    const a = def("A", 1);
    expect(presentationUnavailable(a, false, true)).toBe(true);
  });

  it("is false for a non-external survey even with a retained error", () => {
    // A previous external survey's error must not leak onto a non-external one.
    expect(presentationUnavailable(def("B"), false, true)).toBe(false);
    expect(presentationUnavailable(undefined, false, true)).toBe(false);
  });

  it("is false while a fetch is still in flight", () => {
    const a = def("A", 1);
    expect(presentationUnavailable(a, true, true)).toBe(false);
    expect(presentationUnavailable(a, true, false)).toBe(false);
  });

  it("is false when the settled fetch succeeded", () => {
    expect(presentationUnavailable(def("A", 1), false, false)).toBe(false);
  });
});
