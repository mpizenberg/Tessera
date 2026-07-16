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
  BINDABLE_ROLES,
  credentialKey,
  refKey,
  responseCredentialProof,
  scriptCredentialHash,
  type Cip179Records,
  type GovLink,
  type UnresolvedGovAction,
} from "cip-179/domain";
import type { KoiosDataSource } from "@tessera/koios";

import type { TallyStore, ValidatedResponseRow } from "./store";
import { validationKey } from "./store";

/**
 * Validate the snapshot's responses that were never (fully) validated before,
 * plus any whose survey's governance link changed since their last verdict, and
 * persist the results. Responses referencing a survey outside the snapshot are
 * skipped entirely (no row) — they can't be tallied anyway.
 *
 * A bindable role's *negative* verdict is never frozen while a link it might
 * depend on is unknown (finding 6). Two flavours of "unknown", both left as a
 * null `proofOk` and retried rather than coerced into "unproven":
 *  - `govLinksReliable` is false — this refresh's whole gov-links fetch failed,
 *    so *every* link is unknown; every bindable negative waits.
 *  - `unresolved` lists epoch-aligned actions whose anchor couldn't be resolved
 *    (a successful fetch can still carry unresolved anchors). A bindable
 *    response that cast a qualifying vote on one of those actions could still
 *    turn out proven, so only *it* waits — scoping the uncertainty to the
 *    responses that actually voted on the unresolved action, not every survey
 *    sharing the epoch.
 * Mechanism B only ever *adds* proof (a non-qualifying vote never invalidates),
 * so a mechanism-A pass is final regardless; a survey's link set changing still
 * re-validates completed bindable verdicts (an unresolved anchor later resolving
 * into a link shows up as such a change).
 */
export async function validateNewResponses(
  store: TallyStore,
  records: Cip179Records,
  govLinks: readonly GovLink[],
  source: Pick<KoiosDataSource, "txBlockIndices" | "txProofs">,
  govLinksReliable = true,
  unresolved: readonly UnresolvedGovAction[] = [],
): Promise<void> {
  const defByKey = new Map(
    records.surveys.map((s) => [refKey(s.ref), s.definition]),
  );
  // A survey is governance-linked only by actions whose expiry epoch equals its
  // end_epoch (the CIP invariant, same rule the app applies). A survey MAY be
  // linked by several actions (CIP-179 v5), so index a list per key.
  const linksByKey = new Map<string, GovLink[]>();
  for (const link of govLinks) {
    const def = defByKey.get(link.surveyKey);
    if (def && link.endEpoch === def.endEpoch) {
      const list = linksByKey.get(link.surveyKey);
      if (list) list.push(link);
      else linksByKey.set(link.surveyKey, [link]);
    }
  }
  // Canonical cursor for a survey's epoch-aligned resolved link set
  // (order-insensitive): the stored value a completed verdict is pinned to. When
  // a previously-unresolved anchor resolves into a link the set grows, this
  // string changes, and the bindable-role verdicts pinned to it are re-evaluated
  // (mechanism B only adds proof, so the change can only turn one proven).
  const linkSetKey = (key: string): string | null => {
    const list = linksByKey.get(key);
    if (!list || list.length === 0) return null;
    return list
      .map((l) => l.actionId)
      .sort()
      .join(",");
  };
  // Epoch-aligned *unresolved* action ids per end epoch — the actions whose
  // anchor couldn't be resolved this refresh, so we can't yet tell if they link
  // a survey ending at that epoch. A bindable response that voted on one of
  // these can't have its negative frozen (finding 6).
  const unresolvedByEpoch = new Map<number, string[]>();
  for (const u of unresolved) {
    const list = unresolvedByEpoch.get(u.endEpoch);
    if (list) list.push(u.actionId);
    else unresolvedByEpoch.set(u.endEpoch, [u.actionId]);
  }

  const completed = await store.completedValidations();
  const candidates = records.responses.filter((r) => {
    // Resolve the survey first: a response whose ref isn't in this snapshot
    // (nonexistent survey, or one older than the scan floor) can never be
    // validated or tallied, so it must not contribute to the `/tx_cbor` +
    // `/tx_info` fetch set below. Filtering it *after* building `txHashes`
    // would tax every future refresh with its Koios subrequests forever — a
    // cheap griefing vector, since one tx fee buys a permanent per-refresh
    // cost (finding 4). If its survey later enters the snapshot, the response
    // is still uncompleted and re-enters here, so nothing is lost by dropping.
    if (!defByKey.has(refKey(r.response.surveyRef))) return false;
    const key = validationKey(r.txHash, r.responseIndex);
    if (!completed.has(key)) return true; // never validated / enrichment pending
    if (!govLinksReliable) return false; // can't re-evaluate links this refresh
    if (!BINDABLE_ROLES.has(r.response.role)) return false; // link-independent
    // Re-validate when the survey's current link set differs from the one this
    // verdict was pinned to (a link appeared, changed, or was removed).
    const currentLinks = linkSetKey(refKey(r.response.surveyRef));
    return currentLinks !== completed.get(key);
  });
  if (candidates.length === 0) return;

  const txHashes = [...new Set(candidates.map((r) => r.txHash))];
  // A script-credentialed response's native script may not be attached to its
  // tx (mechanism A permits chain resolution); tell `txProofs` which script hash
  // to resolve by hash for each response tx (finding 7).
  const neededScripts = new Map<string, string[]>();
  for (const r of candidates) {
    const scriptHash = scriptCredentialHash(r.response.credential);
    if (!scriptHash) continue;
    const list = neededScripts.get(r.txHash);
    if (list) list.push(scriptHash);
    else neededScripts.set(r.txHash, [scriptHash]);
  }
  const [blockIndices, proofs] = await Promise.all([
    source.txBlockIndices(txHashes),
    source.txProofs(txHashes, neededScripts),
  ]);

  const checkedAt = Math.floor(Date.now() / 1000);
  const rows: ValidatedResponseRow[] = [];
  for (const r of candidates) {
    const surveyKey = refKey(r.response.surveyRef);
    const def = defByKey.get(surveyKey);
    if (!def) continue; // unknown survey — nothing to validate against
    const proof = proofs.get(r.txHash) ?? null;
    const linkedActionIds = (linksByKey.get(surveyKey) ?? []).map(
      (l) => l.actionId,
    );
    const unresolvedActionIds = unresolvedByEpoch.get(def.endEpoch) ?? [];
    // A null proof is enrichment-pending (the tx CBOR wasn't fetched yet) →
    // retry, not a final "unproven". Otherwise the three-valued verdict decides:
    //  - proven → true;
    //  - unknown (voted on an unresolved epoch-aligned action) → null, retry;
    //  - unproven → false, EXCEPT a bindable role's negative when the whole
    //    gov-links fetch failed (every link then unknown) → null, retry.
    // Mechanism B only ever adds proof, so a pass is always final (finding 6).
    let proofOk: boolean | null;
    if (proof === null) {
      proofOk = null;
    } else {
      const verdict = responseCredentialProof(
        r.response,
        proof,
        linkedActionIds,
        unresolvedActionIds,
      );
      proofOk =
        verdict === "proven"
          ? true
          : verdict === "unknown"
            ? null
            : !govLinksReliable && BINDABLE_ROLES.has(r.response.role)
              ? null
              : false;
    }
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
      linkedActionId: linkSetKey(surveyKey),
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
