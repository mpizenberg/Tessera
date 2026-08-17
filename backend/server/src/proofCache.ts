/**
 * Eviction for the tx-CBOR cache (`tx_proof_cache`).
 *
 * The cache holds whole transactions, so unlike its metadata twin it cannot be
 * allowed to grow forever. What keeps it bounded is that a proof stops being
 * read once nothing can still be decided from it: the scan asks only about open
 * surveys, and finalization asks once, on the way to freezing an artifact.
 *
 * The sweep runs over *the cache's own keys*, keeping those a live survey still
 * bears on. The live surveys come from the stored rows within the end-epoch
 * horizon, and whether a banked hash is theirs is decided in the database, one
 * seek per hash — bounded by the open set and the cache, not by the survey
 * archive or by how many responses a live survey has, so the sweep never
 * re-deletes long-dead hashes refresh after refresh nor re-reads a busy
 * survey's responses to keep them. Over-deleting only ever costs a re-fetch,
 * so the policy may be as blunt as it likes; under-deleting is the permanent
 * mistake.
 */

import type { ChainTip } from "cip-179/domain";

import type { ScanCacheStore, SnapshotStore, TallyStore } from "./store";

/**
 * Epochs past a survey's end after which its proofs are dropped regardless of
 * whether an artifact was ever produced. The artifact is the normal exit — a
 * survey finalizes the epoch after it closes — but some surveys never get one
 * (a spec-invalid definition is untalliable, so finalization drops it before
 * any artifact work), and those would otherwise pin their transactions forever.
 */
const PROOF_GRACE_EPOCHS = 5;

/**
 * Drop every banked transaction no *live* survey bears on — a survey with no
 * artifact yet whose end epoch is within {@link PROOF_GRACE_EPOCHS} of the tip.
 * A transaction serving both a live and a dead survey stays: batches are one
 * row, and the live survey still needs it. A transaction no stored row mentions
 * any more (a rolled-back tx) is kept by nothing, so the sweep collects it too.
 *
 * Skipped on an incomplete scan: the stored rows are then missing txs we cannot
 * identify, so the keep set is under-derived and the sweep would drop entries
 * this refresh simply failed to hear about.
 *
 * Unlike anchor settlement this is not one-shot — the keep set is re-derived
 * every refresh, so a run that dies before pruning loses nothing.
 */
export async function pruneTxProofCache(
  store: Pick<SnapshotStore, "surveyKeysEndingAtOrAfter"> &
    Pick<TallyStore, "artifactKeysFor"> &
    Pick<ScanCacheStore, "unclaimedTxProofHashes" | "deleteTxProofCbor">,
  incomplete: boolean,
  tip: ChainTip,
): Promise<void> {
  if (incomplete) return;

  const recent = await store.surveyKeysEndingAtOrAfter(
    tip.epoch - PROOF_GRACE_EPOCHS,
  );
  const { finalized } = await store.artifactKeysFor(recent);
  const hashes = await store.unclaimedTxProofHashes(
    recent.filter((key) => !finalized.has(key)),
  );
  if (hashes.length === 0) return;
  await store.deleteTxProofCbor(hashes);
  console.log(`tx proof cache: pruned ${hashes.length} transaction(s)`);
}
