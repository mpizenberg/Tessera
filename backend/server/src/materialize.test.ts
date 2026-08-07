/**
 * The snapshot digest is the reconcile-skip's whole correctness argument: two
 * equal digests must mean the stored rows already are this run's rows, and any
 * materialized difference — however small — must change it.
 */

import { describe, expect, it } from "vitest";

import { snapshotDigest } from "./materialize";
import type { ResponseRow, SurveyIndexRow } from "./store";

const survey = (
  surveyKey: string,
  over: Partial<SurveyIndexRow> = {},
): SurveyIndexRow => ({
  surveyKey,
  slot: 100,
  endEpoch: 500,
  sealed: false,
  cancelled: false,
  govLinked: false,
  owner: "key:11",
  haystack: surveyKey,
  record: JSON.stringify({ surveyKey }),
  cancellations: "[]",
  govLinks: "[]",
  responseCount: 0,
  finalizedCancelled: false,
  ...over,
});

const response = (txHash: string, responseIndex = 0): ResponseRow => ({
  txHash,
  responseIndex,
  surveyKey: "aa:0",
  credential: "key:22",
  slot: 10,
  record: JSON.stringify({ txHash, responseIndex }),
});

describe("snapshotDigest", () => {
  it("is insensitive to row order", async () => {
    const surveys = [survey("aa:0"), survey("bb:0")];
    const responses = [response("cc", 1), response("cc", 0), response("dd")];
    expect(await snapshotDigest({ surveys, responses })).toBe(
      await snapshotDigest({
        surveys: [...surveys].reverse(),
        responses: [...responses].reverse(),
      }),
    );
  });

  it("changes with any materialized field", async () => {
    const base = { surveys: [survey("aa:0")], responses: [response("cc")] };
    const baseline = await snapshotDigest(base);
    // The overlay flag is the subtle case: it flips at finalization with no
    // change to any on-chain record, and the digest must still see it.
    expect(
      await snapshotDigest({
        ...base,
        surveys: [survey("aa:0", { finalizedCancelled: true })],
      }),
    ).not.toBe(baseline);
    expect(
      await snapshotDigest({
        ...base,
        responses: [response("cc"), response("dd")],
      }),
    ).not.toBe(baseline);
  });
});
