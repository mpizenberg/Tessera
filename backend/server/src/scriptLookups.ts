/**
 * When a native script is looked up by hash again after a lookup found none.
 *
 * A native-script credential its record's transaction does not carry counts
 * if its script is on chain by the end of the survey's end epoch, so while a
 * survey is open a lookup that found none is only "not yet". Asking again on
 * every refresh would let anyone name made-up hashes in responses to a survey
 * ending far off and buy a Koios request per refresh; asking on a doubling
 * delay, a bounded number of times, covers an indexer running behind or a
 * script published a little later, from minutes to days, at a fixed cost per
 * hash. Past the bound the verdict waits for the survey's end epoch to be
 * final and is looked up once more then (`ProofNeed.final`).
 */

import type { ResolvedNativeScript } from "cardano-tessera-koios";

import type { BankedScriptLookup, ScanCacheStore } from "./store";

/** Lookups that find none before a script is no longer asked for by hash. */
export const MAX_SCRIPT_LOOKUPS = 10;

/**
 * The delay before the first repeat lookup, the refresh cadence; each next
 * one doubles, so the tenth and last comes about a day after the first.
 */
const BACKOFF_BASE_SECONDS = 180;

/** Whether `banked` is a miss whose lookups are used up. */
export const lookupsExhausted = (
  banked: BankedScriptLookup | undefined,
): banked is Extract<BankedScriptLookup, { misses: number }> =>
  banked !== undefined &&
  "misses" in banked &&
  banked.misses >= MAX_SCRIPT_LOOKUPS;

/**
 * Whether a miss is looked up again at `now`: while its lookups last, once
 * its delay has passed.
 */
const due = (
  { misses, checkedAt }: Extract<BankedScriptLookup, { misses: number }>,
  now: number,
) =>
  misses < MAX_SCRIPT_LOOKUPS &&
  now >= checkedAt + BACKOFF_BASE_SECONDS * 2 ** (misses - 1);

/**
 * The banked lookups a scan may reuse, as `ScanCache.scripts` answers them:
 * every script found, and `"none"` for a miss that is not due again at `now`
 * (unix seconds) unless its hash is in `fresh`.
 */
export async function reusableScripts(
  store: Pick<ScanCacheStore, "cachedScriptLookups">,
  hashes: readonly string[],
  fresh: ReadonlySet<string>,
  now: number,
): Promise<Map<string, ResolvedNativeScript | "none">> {
  const out = new Map<string, ResolvedNativeScript | "none">();
  for (const [hash, banked] of await store.cachedScriptLookups(hashes)) {
    if ("found" in banked) out.set(hash, banked.found);
    else if (!fresh.has(hash) && !due(banked, now)) out.set(hash, "none");
  }
  return out;
}
