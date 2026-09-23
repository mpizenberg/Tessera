/**
 * When a question that found no answer is asked again: on a doubling delay, a
 * bounded number of times.
 *
 * Shared by the by-hash script lookups (`scriptLookups.ts`) and the governance
 * anchors (`govLinks.ts`): both are asked of an outside source whose silence
 * is only "not yet", about keys anyone can name, so asking on every refresh
 * would let a made-up key buy a request per refresh forever. The doubling
 * delay covers an indexer running behind or a document published a little
 * later, from minutes to days, at a fixed cost per key.
 */

/** The misses banked for one key so far, and when the last was (unix seconds). */
export interface Misses {
  readonly misses: number;
  readonly checkedAt: number;
}

/** Misses before a key is no longer asked about on the backoff. */
export const MAX_MISSES = 10;

/**
 * The delay before the first repeat, the refresh cadence; each next one
 * doubles, so the tenth and last attempt comes about a day after the first.
 */
const BACKOFF_BASE_SECONDS = 180;

/** Whether the attempts are used up. */
export const exhausted = ({ misses }: Misses): boolean => misses >= MAX_MISSES;

/** Whether a key with these misses is asked again at `now` (unix seconds). */
export const due = (m: Misses, now: number): boolean =>
  !exhausted(m) &&
  now >= m.checkedAt + BACKOFF_BASE_SECONDS * 2 ** (m.misses - 1);
