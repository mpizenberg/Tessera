/**
 * Eviction for the tx-CBOR cache (`tx_proof_cache`).
 *
 * The cache holds whole transactions, so unlike its metadata twin it cannot be
 * allowed to grow forever. What keeps it bounded is that a proof stops being
 * read once nothing can still be decided from it: the scan asks only about open
 * surveys, and finalization asks once, on the way to freezing an artifact.
 *
 * The sweep runs over *the cache's own keys*, keeping those a live survey still
 * bears on. The live surveys and their transactions come from the stored rows,
 * read within the end-epoch horizon — bounded by the open set, not by the
 * survey archive, so the sweep never re-deletes long-dead hashes refresh after
 * refresh. Over-deleting only ever costs a re-fetch, so the policy may be as
 * blunt as it likes; under-deleting is the permanent mistake.
 */

import type { ChainTip } from "cip-179/domain";

import type { SnapshotStore } from "./store";

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
  store: Pick<
    SnapshotStore,
    "surveyRowsEndingAtOrAfter" | "responseRowsForSurveys"
  > & {
    cachedTxProofHashes(): Promise<readonly string[]>;
    deleteTxProofCbor(txHashes: readonly string[]): Promise<void>;
  },
  incomplete: boolean,
  tip: ChainTip,
  finalized: ReadonlySet<string>,
): Promise<void> {
  if (incomplete) return;

  const live = (
    await store.surveyRowsEndingAtOrAfter(tip.epoch - PROOF_GRACE_EPOCHS)
  ).filter((r) => !finalized.has(r.surveyKey));

  // The wire JSON keeps every tx hash as a plain hex string, so the keep set
  // is read without reviving the full records.
  const keep = new Set<string>();
  for (const row of live) {
    keep.add((JSON.parse(row.record) as { txHash: string }).txHash);
    for (const c of JSON.parse(row.cancellations) as { txHash: string }[]) {
      keep.add(c.txHash);
    }
  }
  for (const r of await store.responseRowsForSurveys(
    live.map((row) => row.surveyKey),
  )) {
    keep.add(r.txHash);
  }

  const hashes = (await store.cachedTxProofHashes()).filter(
    (h) => !keep.has(h),
  );
  if (hashes.length === 0) return;
  await store.deleteTxProofCbor(hashes);
  console.log(`tx proof cache: pruned ${hashes.length} transaction(s)`);
}
