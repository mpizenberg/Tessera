import { describe, expect, it } from "vitest";

import { MAX_BUNDLE_RESYNCS, collectSurveyBundle } from "./bundle.js";
import type { SurveyBundlePayload } from "./payloads.js";

describe("collectSurveyBundle", () => {
  /** A page carrying `records` as its responses, keyed by their tx hash. */
  const page = (
    records: readonly string[],
    nextCursor: string | null | undefined,
    resync = false,
  ): SurveyBundlePayload =>
    ({
      survey: { txHash: "aa" },
      responses: records,
      cancellations: [],
      tip: { epoch: 10, slot: 1050, epochSlot: 50, time: 1_000_000 },
      verdicts: Object.fromEntries(records.map((r) => [r, true])),
      ...(nextCursor !== undefined && { nextCursor }),
      ...(resync && { resync: true }),
    }) as unknown as SurveyBundlePayload;

  it("returns an unpaged answer from the first call", async () => {
    let calls = 0;
    const bundle = await collectSurveyBundle(async () => {
      calls++;
      return page(["r1", "r2"], undefined);
    });
    expect(calls).toBe(1);
    expect(bundle.responses).toEqual(["r1", "r2"]);
  });

  it("concatenates pages in arrival order and merges their verdicts", async () => {
    const pages = [page(["r1"], "c1"), page(["r2"], "c2"), page(["r3"], null)];
    const seen: (string | null)[] = [];
    const bundle = await collectSurveyBundle(async (cursor) => {
      seen.push(cursor);
      return pages[seen.length - 1]!;
    });
    expect(seen).toEqual([null, "c1", "c2"]);
    expect(bundle.responses).toEqual(["r1", "r2", "r3"]);
    expect(bundle.verdicts).toEqual({ r1: true, r2: true, r3: true });
    // The collected bundle is complete, so it carries no continuation of its own.
    expect(bundle.nextCursor).toBeNull();
  });

  it("restarts rather than stitching two snapshots together", async () => {
    // The second page of the first attempt reports a moved snapshot; the retry
    // must discard the first page too, not append to it.
    const attempts = [
      [page(["stale1"], "c1"), page(["stale2"], null, true)],
      [page(["fresh1"], "c1"), page(["fresh2"], null)],
    ];
    let attempt = -1;
    let index = 0;
    const bundle = await collectSurveyBundle(async (cursor) => {
      if (cursor === null) {
        attempt++;
        index = 0;
      }
      return attempts[attempt]![index++]!;
    });
    expect(bundle.responses).toEqual(["fresh1", "fresh2"]);
  });

  it("gives up after a bounded number of restarts", async () => {
    let calls = 0;
    await expect(
      collectSurveyBundle(async (cursor) => {
        calls++;
        return cursor === null ? page(["r1"], "c1") : page(["r2"], null, true);
      }),
    ).rejects.toThrow(/kept changing/);
    // One first page + one flagged page per attempt.
    expect(calls).toBe(2 * (MAX_BUNDLE_RESYNCS + 1));
  });
});
