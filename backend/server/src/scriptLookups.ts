/**
 * When a native script is looked up by hash again after a lookup found none.
 *
 * A native-script credential its record's transaction does not carry counts
 * if its script is on chain by the end of the survey's end epoch, so while a
 * survey is open a lookup that found none is only "not yet", and is asked
 * again on the shared backoff (`backoff.ts`). Past the bound the verdict waits
 * for the survey's end epoch to be final and is looked up once more then
 * (`ProofNeed.final`).
 */

import type { ResolvedNativeScript } from "cardano-tessera-koios";

import { due, exhausted, type Misses } from "./backoff";
import type { BankedScriptLookup, ScanCacheStore } from "./store";

/** Whether `banked` is a miss whose lookups are used up. */
export const lookupsExhausted = (
  banked: BankedScriptLookup | undefined,
): banked is Misses =>
  banked !== undefined && "misses" in banked && exhausted(banked);

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
