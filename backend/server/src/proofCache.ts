/**
 * Eviction for the tx-CBOR cache (`tx_proof_cache`).
 *
 * The cache holds whole transactions, so unlike its metadata twin it cannot be
 * allowed to grow forever. What keeps it bounded is that a proof stops being
 * read once nothing can still be decided from it: the scan asks only about open
 * surveys, and finalization asks once, on the way to freezing an artifact.
 *
 * The set to drop is *re-derived from the records in hand* each refresh — no
 * stamp column, no clock, no read of the table's keys — the same shape as the
 * governance-anchor prune in `govLinks.ts`. Over-deleting only ever costs a
 * re-fetch, so the policy may be as blunt as it likes; under-deleting is the
 * permanent mistake.
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
 * Drop cached CBOR for transactions no *live* survey bears on — a survey with
 * no artifact yet whose end epoch is within {@link PROOF_GRACE_EPOCHS} of the
 * tip. A transaction serving both a live and a dead survey stays: batches are
 * one row, and the live survey still needs it.
 *
 * Skipped on an incomplete snapshot: the records are then missing txs we cannot
 * identify, so the live set is under-derived. Harmless to delete anyway, but an
 * incomplete run is precisely the one whose request budget is already spent.
 *
 * Unlike anchor settlement this is not one-shot — the same droppable set is
 * re-derived every refresh, so a run that dies before pruning loses nothing.
 * A transaction that no record mentions any more (a rolled-back tx) is never
 * derived as droppable and stays; that entry is inert, never served, exactly as
 * a stale metadata entry is.
 */
export async function pruneTxProofCache(
  store: { deleteTxProofCbor(txHashes: readonly string[]): Promise<void> },
  records: Cip179Records,
  tip: ChainTip,
  finalized: ReadonlySet<string>,
): Promise<void> {
  if (records.incomplete) return;

  const live = new Set<string>();
  const dead = new Set<string>();
  for (const s of records.surveys) {
    const key = refKey(s.ref);
    (!finalized.has(key) &&
    tip.epoch <= s.definition.endEpoch + PROOF_GRACE_EPOCHS
      ? live
      : dead
    ).add(key);
  }

  const keep = new Set<string>();
  const droppable = new Set<string>();
  const sort = (surveyKey: string, txHash: string): void => {
    if (live.has(surveyKey)) keep.add(txHash);
    else if (dead.has(surveyKey)) droppable.add(txHash);
    // A record whose survey isn't in this snapshot decides nothing either way.
  };
  for (const s of records.surveys) sort(refKey(s.ref), s.txHash);
  for (const c of records.cancellations) sort(refKey(c.target), c.txHash);
  for (const r of records.responses)
    sort(refKey(r.response.surveyRef), r.txHash);

  const hashes = [...droppable].filter((h) => !keep.has(h));
  if (hashes.length === 0) return;
  await store.deleteTxProofCbor(hashes);
  console.log(`tx proof cache: pruned ${hashes.length} transaction(s)`);
}
