import type { SurveyBundlePayload } from "./payloads.js";

/**
 * How many times {@link collectSurveyBundle} restarts before giving up. A
 * restart happens when a refresh lands mid-collection; refreshes are minutes
 * apart and a survey is a handful of pages, so more than a couple of restarts
 * means something is wrong rather than merely busy, and a caller waiting on a
 * tally deserves the error instead of a loop.
 */
export const MAX_BUNDLE_RESYNCS = 3;

/**
 * Read a survey's whole bundle from a paged source: page one, then each
 * continuation, responses concatenated and verdicts merged in arrival order.
 *
 * A bundle feeds a tally rather than a scrolling list, where a silently
 * skipped response is a wrong result. A page that reports `resync` was minted
 * against a different snapshot than the pages before it, so the collection is
 * abandoned and restarted rather than stitched. A source that does not page
 * (no `nextCursor` on its answer) returns from the first call, so this is
 * safe to wrap around any bundle read.
 */
export async function collectSurveyBundle(
  fetchPage: (cursor: string | null) => Promise<SurveyBundlePayload>,
): Promise<SurveyBundlePayload> {
  for (let attempt = 0; ; attempt++) {
    const first = await fetchPage(null);
    const responses = [...first.responses];
    const verdicts = { ...first.verdicts };
    let cursor = first.nextCursor ?? null;
    let restart = false;
    while (cursor !== null) {
      const page = await fetchPage(cursor);
      if (page.resync) {
        restart = true;
        break;
      }
      responses.push(...page.responses);
      Object.assign(verdicts, page.verdicts);
      cursor = page.nextCursor ?? null;
    }
    if (!restart)
      return {
        ...first,
        responses,
        ...(first.verdicts !== undefined && { verdicts }),
        nextCursor: null,
      };
    if (attempt >= MAX_BUNDLE_RESYNCS)
      throw new Error(
        `survey bundle kept changing under pagination (${MAX_BUNDLE_RESYNCS} restarts)`,
      );
  }
}
