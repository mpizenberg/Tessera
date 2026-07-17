/**
 * Latest-valid-wins response dedupe + the record identity keys it rests on.
 *
 * This is the ONE dedupe rule (CIP-179: at most one counted response per
 * (survey, role, credential), latest wins). It lives in core so the serving
 * tier's per-survey `responseCount` and the client's audit/tally agree by
 * construction — both sides call exactly this code.
 *
 * RULESET-PINNED BEHAVIOR: the dedup rule and its chain-order tie-break are part
 * of `RULESET_DESCRIPTOR` (see `artifact.ts`), which is hashed into every tally
 * artifact. Any change to *which* response wins — the identity key, the
 * (slot, tx_block_index, response_index) ordering, or the "valid before latest"
 * discipline — is a semantic ruleset change: bump `rulesetVersion` and update
 * the golden hash in `artifact.test.ts` in the same commit, or historical
 * artifacts silently become unreproducible (MISMATCH, read as tampering).
 *
 * Sealed surveys run this same dedupe, but only *after* reveal-time validation
 * (the `sealed-dedup` rule, in `audit.ts`'s `auditRevealedResponses`): an
 * undecryptable/invalid later ballot must never supersede a valid earlier one.
 */

import type { Credential, SurveyRef } from "../index.js";

import { bytesToHex, hexToBytes } from "./hex.js";
import type { ResponseRecord } from "./records.js";

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

/** Inverse of {@link credentialKey}. Throws on a malformed key. */
export function parseCredentialKey(key: string): Credential {
  const sep = key.indexOf(":");
  const kind = key.slice(0, sep);
  const hash = hexToBytes(key.slice(sep + 1));
  if (kind === "key") return { type: "key", keyHash: hash };
  if (kind === "script") return { type: "script", scriptHash: hash };
  throw new Error(`malformed credential key: ${key}`);
}

/**
 * The fields the §6.3 chain order reads. `ResponseRecord` satisfies it, as do
 * the serving tier's persisted validation rows (whose missing `blockIndex` is
 * `null` rather than absent).
 */
export interface ChainOrderKey {
  readonly slot: number;
  readonly blockIndex?: number | null;
  readonly responseIndex: number;
}

/**
 * Chain order for responses (§6.3): by slot, then position of the tx within
 * its block (`tx_block_index`, −1 when the source didn't enrich it — a
 * one-refresh transient on the serving tier), then position within the
 * payload's responses array. Returns true iff `a` is strictly later than `b`.
 * This is THE ordering "latest wins" refers to — tally emitters and verifiers
 * must agree on it, so it's pinned in the artifact ruleset descriptor.
 */
export function laterInChain(a: ChainOrderKey, b: ChainOrderKey): boolean {
  if (a.slot !== b.slot) return a.slot > b.slot;
  const ab = a.blockIndex ?? -1;
  const bb = b.blockIndex ?? -1;
  if (ab !== bb) return ab > bb;
  return a.responseIndex > b.responseIndex;
}

/**
 * Chain order for cancellations (the ruleset `cancellation` rule): earliest
 * first, by slot then tx hash. The emitter and verifier both walk cancellations
 * in this order to pick the earliest owner-proven one as the recorded winner, and
 * that `txHash` is hashed into the artifact — so, like {@link laterInChain}, this
 * comparator is ruleset-pinned and must not diverge between the two. (tx hashes
 * are unique, so the `0` tie-break is never exercised in practice.)
 */
export function byCancellationChainOrder(
  a: { readonly slot: number; readonly txHash: string },
  b: { readonly slot: number; readonly txHash: string },
): number {
  return (
    a.slot - b.slot || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0)
  );
}

/**
 * Latest-valid-wins: at most one response per (survey, role, credential),
 * keeping the {@link laterInChain}-greatest one.
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
    if (!prev || laterInChain(r, prev)) best.set(id, r);
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
