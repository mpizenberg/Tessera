/**
 * Incremental response validation (ARCHITECTURE.md §6.3 rules 1–3), run at the
 * end of every snapshot refresh:
 *
 *  - rule 1 (window) needs no fetch — the scan already carries each record's
 *    authoritative `epoch_no`, stored raw so the deadline stays a pure
 *    comparison at tally time;
 *  - rule 2 (credential proof) costs one `/tx_cbor` read per response tx;
 *  - rule 3's same-slot ordering input costs one `/tx_info` read per tx.
 *
 * Both fetches happen only for (txHash, responseIndex) keys never completed
 * before, so the steady state is zero extra subrequests per refresh; a failed
 * enrichment leaves NULLs in the row and is retried next refresh. Best-effort
 * by design: a validation hiccup must never sink the snapshot refresh.
 */

import { validateResponse } from "cip-179";

import {
  credentialKey,
  refKey,
  responseCredentialProven,
  type Cip179Records,
  type GovLink,
} from "@tessera/core";
import type { KoiosDataSource } from "@tessera/koios";

import type { TallyStore, ValidatedResponseRow } from "./store";
import { validationKey } from "./store";

/**
 * Validate the snapshot's responses that were never (fully) validated before,
 * and persist the results. Responses referencing a survey outside the snapshot
 * are skipped entirely (no row) — they can't be tallied anyway.
 */
export async function validateNewResponses(
  store: TallyStore,
  records: Cip179Records,
  govLinks: readonly GovLink[],
  source: Pick<KoiosDataSource, "txBlockIndices" | "txProofs">,
): Promise<void> {
  const completed = await store.completedValidationKeys();
  const candidates = records.responses.filter(
    (r) => !completed.has(validationKey(r.txHash, r.responseIndex)),
  );
  if (candidates.length === 0) return;

  const defByKey = new Map(
    records.surveys.map((s) => [refKey(s.ref), s.definition]),
  );
  // A survey is governance-linked only when the action's voting end epoch
  // equals its end_epoch (the CIP invariant, same rule the app applies).
  const linkByKey = new Map<string, string>();
  for (const link of govLinks) {
    const def = defByKey.get(link.surveyKey);
    if (def && link.endEpoch === def.endEpoch) {
      linkByKey.set(link.surveyKey, link.actionId);
    }
  }

  const txHashes = [...new Set(candidates.map((r) => r.txHash))];
  const [blockIndices, proofs] = await Promise.all([
    source.txBlockIndices(txHashes),
    source.txProofs(txHashes),
  ]);

  const checkedAt = Math.floor(Date.now() / 1000);
  const rows: ValidatedResponseRow[] = [];
  for (const r of candidates) {
    const surveyKey = refKey(r.response.surveyRef);
    const def = defByKey.get(surveyKey);
    if (!def) continue; // unknown survey — nothing to validate against
    const proof = proofs.get(r.txHash) ?? null;
    rows.push({
      txHash: r.txHash,
      responseIndex: r.responseIndex,
      surveyKey,
      role: r.response.role,
      credential: credentialKey(r.response.credential),
      slot: r.slot,
      epochNo: r.epochNo,
      blockIndex: blockIndices.get(r.txHash) ?? null,
      proofOk: proof
        ? responseCredentialProven(
            r.response,
            proof,
            linkByKey.get(surveyKey) ?? null,
          )
        : null,
      wellFormed: validateResponse(def, r.response).length === 0,
      checkedAt,
    });
  }

  await store.upsertValidatedResponses(rows);
  const retry = rows.filter(
    (r) => r.blockIndex === null || r.proofOk === null,
  ).length;
  console.log(
    `validated ${rows.length} new responses` +
      (retry ? ` (${retry} incomplete, will retry)` : ""),
  );
}
