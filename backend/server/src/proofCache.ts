/**
 * Eviction for the tx-CBOR cache (`tx_proof_cache`).
 *
 * The cache holds whole transactions, so unlike its metadata twin it cannot be
 * allowed to grow forever. What keeps it bounded is that a proof stops being
 * read once nothing can still be decided from it: the scan asks only about open
 * surveys, and finalization asks once, on the way to freezing an artifact.
 *
 * The sweep runs over *the cache's own keys*, keeping those a live survey still
 * bears on. Deriving the drop set from the records instead would size each run
 * by the survey archive rather than by the cache — re-deleting the same
 * long-dead hashes every refresh, forever, to maintain a table the size of the
 * open set. Over-deleting only ever costs a re-fetch, so the policy may be as
 * blunt as it likes; under-deleting is the permanent mistake.
 */

import { refKey, type ChainTip, type Cip179Records } from "cip-179/domain";

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
 * row, and the live survey still needs it. A transaction no record mentions any
 * more (a rolled-back tx) is kept by nothing, so the sweep collects it too.
 *
 * Skipped on an incomplete snapshot: the records are then missing txs we cannot
 * identify, so the keep set is under-derived and the sweep would drop entries
 * this refresh simply failed to hear about.
 *
 * Unlike anchor settlement this is not one-shot — the keep set is re-derived
 * every refresh, so a run that dies before pruning loses nothing.
 */
export async function pruneTxProofCache(
  store: {
    cachedTxProofHashes(): Promise<readonly string[]>;
    deleteTxProofCbor(txHashes: readonly string[]): Promise<void>;
  },
  records: Cip179Records,
  tip: ChainTip,
  finalized: ReadonlySet<string>,
): Promise<void> {
  if (records.incomplete) return;

  const live = new Set<string>();
  for (const s of records.surveys) {
    const key = refKey(s.ref);
    if (
      !finalized.has(key) &&
      tip.epoch <= s.definition.endEpoch + PROOF_GRACE_EPOCHS
    )
      live.add(key);
  }

  const keep = new Set<string>();
  const keepIfLive = (surveyKey: string, txHash: string): void => {
    if (live.has(surveyKey)) keep.add(txHash);
  };
  for (const s of records.surveys) keepIfLive(refKey(s.ref), s.txHash);
  for (const c of records.cancellations) keepIfLive(refKey(c.target), c.txHash);
  for (const r of records.responses)
    keepIfLive(refKey(r.response.surveyRef), r.txHash);

  const hashes = (await store.cachedTxProofHashes()).filter(
    (h) => !keep.has(h),
  );
  if (hashes.length === 0) return;
  await store.deleteTxProofCbor(hashes);
  console.log(`tx proof cache: pruned ${hashes.length} transaction(s)`);
}
