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

import { Role, validateResponse } from "cip-179";

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
 * Roles that carry a Conway voter tag and so *can* be proven via a governance
 * vote binding (mechanism B) — the only roles whose verdict depends on the
 * survey's gov links. Stakeholder/Keyholder can never bind, so their proof is
 * link-independent and safe to freeze even when the gov-links fetch failed.
 */
const BINDABLE_ROLES: ReadonlySet<number> = new Set([
  Role.CC,
  Role.DRep,
  Role.SPO,
]);

/**
 * Validate the snapshot's responses that were never (fully) validated before,
 * plus any whose survey's governance link changed since their last verdict, and
 * persist the results. Responses referencing a survey outside the snapshot are
 * skipped entirely (no row) — they can't be tallied anyway.
 *
 * `govLinksReliable` is false when this refresh's gov-links fetch failed (an
 * empty list then means "unknown", not "none"). In that case a link-dependent
 * verdict cannot be trusted — a hidden link would make mechanism A the wrong
 * mechanism — so bindable-role verdicts are left null and retried, and no row
 * is re-validated on an apparent link change.
 */
export async function validateNewResponses(
  store: TallyStore,
  records: Cip179Records,
  govLinks: readonly GovLink[],
  source: Pick<KoiosDataSource, "txBlockIndices" | "txProofs">,
  govLinksReliable = true,
): Promise<void> {
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

  const completed = await store.completedValidations();
  const candidates = records.responses.filter((r) => {
    const key = validationKey(r.txHash, r.responseIndex);
    if (!completed.has(key)) return true; // never validated / enrichment pending
    if (!govLinksReliable) return false; // can't re-evaluate links this refresh
    if (!BINDABLE_ROLES.has(r.response.role)) return false; // link-independent
    // Re-validate when the survey's current link differs from the one this
    // verdict was pinned to (a link appeared, changed, or was removed).
    const currentLink = linkByKey.get(refKey(r.response.surveyRef)) ?? null;
    return currentLink !== completed.get(key);
  });
  if (candidates.length === 0) return;

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
    const link = linkByKey.get(surveyKey) ?? null;
    // With links unknown this refresh, a bindable role's verdict can't be
    // trusted (a hidden binding might override mechanism A) — leave it to retry.
    const proofOk =
      !govLinksReliable && BINDABLE_ROLES.has(r.response.role)
        ? null
        : proof
          ? responseCredentialProven(r.response, proof, link)
          : null;
    rows.push({
      txHash: r.txHash,
      responseIndex: r.responseIndex,
      surveyKey,
      role: r.response.role,
      credential: credentialKey(r.response.credential),
      slot: r.slot,
      epochNo: r.epochNo,
      blockIndex: blockIndices.get(r.txHash) ?? null,
      proofOk,
      linkedActionId: link,
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
