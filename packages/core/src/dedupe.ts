/**
 * Latest-valid-wins response dedupe + the record identity keys it rests on.
 *
 * This is the ONE dedupe rule (CIP-179: at most one counted response per
 * (survey, role, credential), latest wins). It lives in core so the serving
 * tier's per-survey `responseCount` and the client's audit/tally agree by
 * construction — both sides call exactly this code.
 */

import type { Credential, SurveyRef } from "cip-179";

import { bytesToHex } from "./hex";
import type { ResponseRecord } from "./source";

/** Stable string identity for a survey reference: "<txHex>:<index>". */
export function refKey(ref: SurveyRef): string {
  return `${bytesToHex(ref.txId)}:${ref.index}`;
}

/** Stable identity for a responder credential: "key:<hex>" | "script:<hex>". */
export function credentialKey(cred: Credential): string {
  return cred.type === "key"
    ? `key:${bytesToHex(cred.keyHash)}`
    : `script:${bytesToHex(cred.scriptHash)}`;
}

/**
 * Latest-valid-wins: at most one response per (survey, role, credential),
 * keeping the one at the highest slot (ties broken by tx hash for determinism).
 */
export function dedupeResponses(
  responses: readonly ResponseRecord[],
): ResponseRecord[] {
  const best = new Map<string, ResponseRecord>();
  for (const r of responses) {
    const id =
      `${refKey(r.response.surveyRef)}|${r.response.role}|` +
      credentialKey(r.response.credential);
    const prev = best.get(id);
    if (
      !prev ||
      r.slot > prev.slot ||
      (r.slot === prev.slot && r.txHash > prev.txHash)
    ) {
      best.set(id, r);
    }
  }
  return [...best.values()];
}

/**
 * Distinct-responder count per survey key, after {@link dedupeResponses}.
 * Plain object (not Map) so it crosses the JSON wire as-is.
 */
export function responseCounts(
  responses: readonly ResponseRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of dedupeResponses(responses)) {
    const k = refKey(r.response.surveyRef);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
