/**
 * Pure response audit: from the raw on-chain responses targeting one survey,
 * derive the *counted* set (valid + latest-wins) and a breakdown of the
 * exclusions provable from on-chain data alone.
 *
 * Detectable client-side (no indexer):
 *  - after-deadline — the record's `epochNo` (authoritative, from the chain
 *                     index) is past the survey's `end_epoch` (invalid window).
 *  - invalid        — fails codec validation against the on-chain definition
 *                     (out-of-constraint answer, duplicate/OOB indices,
 *                     ineligible role, missing required answer). On-chain data
 *                     is attacker-controllable, so a response can decode cleanly
 *                     yet violate the survey's rules — those must not be tallied.
 *  - superseded     — an earlier response for the same (role, credential),
 *                     replaced by a later valid one (latest-wins).
 *
 * Needs ledger state (NOT here — indexer-side): role *membership* re-checked at
 * the end_epoch snapshot (distinct from role *eligibility*, which is on-chain
 * and checked above), credential-proof failures. Those are deliberately absent
 * from this breakdown; the UI says so. Keeping the audit honest about what it
 * can and can't see avoids implying a completeness it doesn't have.
 */

import {
  validateResponse,
  type SurveyDefinition,
  type SurveyResponse,
} from "cip-179";

import type { ResponseRecord } from "./source";
import { dedupeResponses, epochOfSlot } from "./survey";

// `epochOfSlot` lives in ./survey (shared with cancellation-deadline logic and
// UI countdowns); re-exported here so existing importers (and tests) keep
// their path. The deadline rule itself no longer estimates: it reads the
// record's authoritative `epochNo`.
export { epochOfSlot };

export type ExclusionKey =
  | "after-deadline"
  | "invalid"
  | "superseded"
  | "undecryptable";

/**
 * Whether a response may be counted against its survey: it passes the codec's
 * full {@link validateResponse} (correct submission mode, eligible role,
 * in-constraint answers with no duplicate/out-of-range indices, required
 * questions answered). This is the *same* validator the responder runs before
 * submitting — applied here to *others'* on-chain responses, which an attacker
 * can craft to decode cleanly yet break the survey's constraints (over-budget
 * points allocations, duplicate multi-select indices, out-of-range ratings).
 *
 * Sealed responses can only be checked structurally until their drand round
 * publishes; `validateResponse` passes them on mode + non-empty ciphertext, so
 * a sealed response stays counted (for participation) and its decrypted answers
 * are re-validated at reveal time.
 */
export function responseIsCountable(
  definition: SurveyDefinition,
  response: SurveyResponse,
): boolean {
  return validateResponse(definition, response).length === 0;
}

/** A single excluded response, tagged with why it wasn't counted. */
export interface ExcludedRecord {
  readonly key: ExclusionKey;
  readonly record: ResponseRecord;
}

export interface ResponseAudit {
  /** Valid, deduped responses — the set to tally. */
  readonly counted: ResponseRecord[];
  /**
   * The excluded records, each tagged with its reason — the single source of
   * truth for the exclusion breakdown. A UI groups these by key for a count
   * summary and per-response drill-down (CSV export). `undecryptable` is not
   * produced here (it's only knowable after reveal — appended UI-side).
   */
  readonly excludedRecords: readonly ExcludedRecord[];
}

/**
 * Audit the raw responses for one survey. Responses past the deadline are
 * dropped first (the invalid window), then those that fail codec validation
 * (out-of-constraint, ineligible role, …) as `invalid`; latest-valid-wins then
 * picks one per (role, credential) and the leftovers are `superseded`. Excluding
 * invalid responses *before* dedup is essential: otherwise a malformed later
 * response could suppress a valid earlier one. The `counted` set is exactly what
 * should be tallied, so a UI showing both stays consistent.
 */
export function auditResponses(
  raw: readonly ResponseRecord[],
  definition: SurveyDefinition,
): ResponseAudit {
  const endEpoch = definition.endEpoch;
  const onTime: ResponseRecord[] = [];
  const excludedRecords: ExcludedRecord[] = [];
  for (const r of raw) {
    if (r.epochNo > endEpoch) {
      excludedRecords.push({ key: "after-deadline", record: r });
    } else if (!responseIsCountable(definition, r.response)) {
      excludedRecords.push({ key: "invalid", record: r });
    } else {
      onTime.push(r);
    }
  }
  const counted = dedupeResponses(onTime);
  // `counted` holds references drawn from `onTime`; the leftovers are exactly
  // the superseded responses (an earlier entry beaten by a later latest-wins).
  // Appended after the late ones, so the breakdown reads deadline-then-superseded.
  const countedSet = new Set(counted);
  for (const r of onTime)
    if (!countedSet.has(r))
      excludedRecords.push({ key: "superseded", record: r });

  return { counted, excludedRecords };
}

/** The classified outcome of revealing one survey's sealed responses. */
export interface RevealedAudit {
  /** Valid decrypted responses, after latest-valid-wins dedup — the tally set. */
  readonly counted: ResponseRecord[];
  /** Valid decrypted responses beaten by a later valid one (post-reveal dedup). */
  readonly superseded: ResponseRecord[];
  /** Decrypted cleanly but violate the survey's constraints. */
  readonly invalid: ResponseRecord[];
  /** Didn't decrypt or didn't decode (Tessera can't always tell which). */
  readonly failed: ResponseRecord[];
}

/**
 * The sealed-reveal counterpart to {@link auditResponses}. Given the in-window
 * sealed responses (structurally valid, **pre-dedup**) and their decrypted
 * public forms (`revealed[i]` aligns with `inWindow[i]`; `null` = decrypt/decode
 * failed), classify each and dedup *only the valid decoded set*.
 *
 * Running dedup **after** reveal-time validation is essential for sealed surveys
 * (finding 2): while sealed, a ciphertext can only be checked structurally, so
 * dedup-before-reveal would let an invalid or undecryptable later ballot
 * suppress a valid earlier one for the same (role, credential) — which would
 * then never be revealed or counted, silently disenfranchising the responder.
 * Here the superseded set is drawn only from responses proven valid at reveal.
 * Decoded responses carry their decrypted public answers back onto the record.
 *
 * RULESET-PINNED BEHAVIOR: this is exactly the `sealed-reveal` + `sealed-dedup`
 * rules in `RULESET_DESCRIPTOR` (see `artifact.ts`) — reveal-then-validate, then
 * dedup only the valid decoded set. The emitter and any independent verifier both
 * count a sealed survey through this function, so a change to *which* revealed
 * responses are counted (the validate-before-dedup discipline, the exclusion of
 * undecryptable/invalid ballots) is a semantic ruleset change: bump
 * `rulesetVersion` and update the golden hash in `artifact.test.ts` in the same
 * commit, or sealed artifacts silently stop reproducing (MISMATCH read as tampering).
 */
export function auditRevealedResponses(
  inWindow: readonly ResponseRecord[],
  revealed: readonly (SurveyResponse | null)[],
  definition: SurveyDefinition,
): RevealedAudit {
  // The decrypted responses are plaintext (`public`) now, so validate them
  // against the survey's answer constraints but NOT its sealed submission-mode
  // gate — `validateResponse` would otherwise reject every revealed answer for a
  // sealed survey with "requires a sealed response". Everything else (roles,
  // indices, required questions) is unchanged.
  const answerDef: SurveyDefinition =
    definition.submissionMode.type === "sealed"
      ? { ...definition, submissionMode: { type: "public" } }
      : definition;
  const decoded: ResponseRecord[] = [];
  const invalid: ResponseRecord[] = [];
  const failed: ResponseRecord[] = [];
  inWindow.forEach((r, i) => {
    const pub = revealed[i] ?? null;
    if (pub === null) {
      failed.push(r);
    } else if (!responseIsCountable(answerDef, pub)) {
      // Keep the decoded response so a per-response audit shows what it claimed.
      invalid.push({ ...r, response: pub });
    } else {
      decoded.push({ ...r, response: pub });
    }
  });
  const counted = dedupeResponses(decoded);
  const countedSet = new Set(counted);
  const superseded = decoded.filter((r) => !countedSet.has(r));
  return { counted, superseded, invalid, failed };
}
