/**
 * Incremental response validation (TALLY-SPEC.md §3 rules 1–3), run at the
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
  type GovLink,
  type ResponseRecord,
  type SurveyRecord,
  type UnresolvedGovAction,
} from "cip-179/domain";
import { fromJsonSafe } from "cip-179/tally";
import type { KoiosDataSource } from "cardano-tessera-koios";

import type { SnapshotStore, TallyStore, ValidatedResponseRow } from "./store";
import { validationKey } from "./store";

/** What validation reads and writes: verdict state, plus stored rows. */
export type ValidateStore = TallyStore &
  Pick<SnapshotStore, "responseRowsForSurveys" | "surveyRowsByKeys">;

/**
 * Validate the scan's responses that were never (fully) validated before, plus
 * any whose survey's governance link changed since their last verdict, and
 * persist the results. Responses referencing an unknown survey are skipped
 * entirely (no row) — they can't be tallied anyway.
 *
 * The input need not carry the whole corpus: stored verdicts that fell out of
 * date without a new response arriving — a bindable verdict pinned to a link
 * set that has since changed, or a verdict still awaiting an enrichment retry
 * — put their survey back on the candidate list, and its responses are revived
 * from the stored rows. Segment integration runs before this pass, so the
 * stored rows are authoritative for both halves of what a verdict is built
 * against: the survey's definition and its governance links (a survey with no
 * row anywhere has rolled back and must not be validated against). Completed
 * verdicts are then read keyed by exactly the candidate surveys, so
 * validation's reads scale with what this refresh touches rather than with
 * every verdict ever recorded.
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
  store: ValidateStore,
  responses: readonly ResponseRecord[],
  source: Pick<KoiosDataSource, "txBlockIndices" | "txProofs">,
  govLinksReliable = true,
  unresolved: readonly UnresolvedGovAction[] = [],
): Promise<void> {
  // Every survey this pass could have to judge: the input responses' targets,
  // plus the surveys whose verdicts need another look. Their definitions and
  // link slices both come from their stored rows — integration has already
  // written this refresh's links there, so the row is the current answer and
  // a survey with no row has rolled back.
  const cursors = await store.validatedLinkCursors();
  const retrySurveys = await store.incompleteValidationSurveys();
  const surveyRows = await store.surveyRowsByKeys([
    ...new Set([
      ...responses.map((r) => refKey(r.response.surveyRef)),
      ...cursors.map((c) => c.surveyKey),
      ...retrySurveys,
    ]),
  ]);
  const defByKey = new Map<string, SurveyRecord["definition"]>();
  // A survey is governance-linked only by actions whose expiry epoch equals its
  // end_epoch (the CIP invariant, same rule the app applies) — its row carries
  // every action naming it, aligned or not. A survey MAY be linked by several
  // actions (CIP-179 v5), so index a list per key.
  const linksByKey = new Map<string, GovLink[]>();
  for (const row of surveyRows) {
    const record = fromJsonSafe(JSON.parse(row.record)) as SurveyRecord;
    defByKey.set(row.surveyKey, record.definition);
    const aligned = (JSON.parse(row.govLinks) as GovLink[]).filter(
      (l) => l.endEpoch === record.definition.endEpoch,
    );
    if (aligned.length > 0) linksByKey.set(row.surveyKey, aligned);
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

  // The rows ARE this refresh's link truth, so a cursor that disagrees with
  // one is a genuine change to re-evaluate — and a refresh whose gov-links
  // fetch failed re-projected nothing, so nothing disagrees.
  const staleCursors = cursors.filter(
    (c) => c.linkedActionId !== linkSetKey(c.surveyKey),
  );
  const revivalKeys = [
    ...new Set([...staleCursors.map((c) => c.surveyKey), ...retrySurveys]),
  ];
  const inputKeys = new Set(
    responses.map((r) => validationKey(r.txHash, r.responseIndex)),
  );
  const revived = (await store.responseRowsForSurveys(revivalKeys))
    .map((row) => fromJsonSafe(JSON.parse(row.record)) as ResponseRecord)
    .filter((r) => !inputKeys.has(validationKey(r.txHash, r.responseIndex)));
  const pool = [...responses, ...revived];

  const completed = await store.completedValidationsForSurveys(
    [...new Set(pool.map((r) => refKey(r.response.surveyRef)))].filter((key) =>
      defByKey.has(key),
    ),
  );
  const candidates = pool.filter((r) => {
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
    const verdict = completed.get(key);
    if (!verdict) return true; // never validated / enrichment pending
    // A rolled-back response that re-landed elsewhere carries the same
    // (txHash, responseIndex) but a new chain position, and the verdict holds
    // the old one: its `epochNo` decides the on-time rule and its slot and
    // block index decide the dedup winner. Re-judging also re-reads the block
    // index, which moved with the transaction.
    if (verdict.slot !== r.slot || verdict.epochNo !== r.epochNo) return true;
    if (!BINDABLE_ROLES.has(r.response.role)) return false; // link-independent
    // Re-validate when the survey's current link set differs from the one this
    // verdict was pinned to (a link appeared, changed, or was removed).
    const currentLinks = linkSetKey(refKey(r.response.surveyRef));
    return currentLinks !== verdict.linkedActionId;
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
