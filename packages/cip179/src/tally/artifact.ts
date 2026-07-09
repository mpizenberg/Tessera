/**
 * The content-addressed tally artifact (`backend/ARCHITECTURE.md` §7): the
 * self-describing, re-verifiable final result of a closed survey.
 *
 * Everything under `tally` is what the hash commits to — JSON-plain (numbers
 * are safe integers, weights are decimal strings) and hashed as
 * `blake2b256Hex(canonicalJson(tally))`. `provenance` records *where* the
 * inputs came from (useful, but re-fetchable) and is deliberately outside the
 * hash: a verifier reproduces `tally` from chain data + this ruleset and
 * compares hashes, regardless of which provider it queried.
 *
 * The ruleset itself is pinned the same way: {@link RULESET_DESCRIPTOR} is a
 * canonical description of every counting rule, and its hash is embedded in
 * each tally body — two artifacts hashed under different rules can never
 * compare equal.
 */

import type { AnswerItem } from "../index.js";

import { blake2b256Hex, canonicalJson } from "./canonical.js";
import { fromJsonSafe, toJsonSafe } from "./wire.js";
import type {
  WeightedQuestionTally,
  WeightedResponder,
} from "./weightedTally.js";

/**
 * The counting rules this implementation applies, as data. Change any rule and
 * `rulesetHash()` changes with it — bump `rulesetVersion` whenever that happens
 * (a golden test in `artifact.test.ts` pins the hash, so an unbumped change
 * fails CI). Note the hash commits to this *description*, not to the code it
 * describes: the load-bearing behaviors live in `cip-179`'s `validateResponse`
 * ("validity") and core's `dedupeResponses` ("dedup"), whose files carry a
 * matching RULESET-PINNED-BEHAVIOR note — a semantic change there needs the same
 * version bump even if this descriptor's text is untouched. Mirrors §6.2/§6.3
 * and the CIP-179 credential-proof mechanisms.
 */
export const RULESET_DESCRIPTOR = {
  // v2: responders record (txHash, responseIndex) — the artifact body schema
  // changed, so hashes are incomparable with v1 artifacts.
  // v3: sealed surveys now emit artifacts (the three sealed-* rules below); the
  // body gains `sealed=true`, counted responders commit their revealed answers,
  // and the schema change makes v3 hashes incomparable with v2.
  rulesetVersion: 3,
  cip179SpecVersion: 4,
  /** Roles artifacts cover: 0 DRep, 3 Stakeholder, 4 Keyholder (SPO/CC deferred). */
  coveredRoles: [0, 3, 4],
  /** What one unit of weight measures, per covered role. */
  roleMeasures: {
    "0": "drep_voting_power_at_end_epoch",
    "3": "active_stake_at_end_epoch",
    "4": "count",
  },
  rules: [
    "window: a response is countable iff its transaction's epoch_no <= the survey's end_epoch (inclusive)",
    "validity: a response must pass full CIP-179 codec validation against the on-chain definition (eligible role, in-constraint answers, required questions answered)",
    "credential-proof: mechanism A (credential key in required_signers, or its native script witnessed and satisfied) or mechanism B (a voting_procedures binding by the same credential voting on the linked governance action, with the voter tag's role equal to the claimed role); a present-but-failing binding invalidates the response; mechanism B applies only to governance-linked surveys",
    "dedup: at most one counted response per (survey, role, credential) — the latest in chain order wins, ordered by (slot, tx_block_index, response_index)",
    "membership+weight: role membership and weights are snapshotted at the survey's end_epoch; a credential registered at end_epoch but without stake counts with weight 0; unregistered credentials are excluded",
    "cancellation: a survey is cancelled iff a cancelling transaction at epoch_no <= end_epoch proves the definition's owner credential via mechanism A; the earliest such transaction in chain order (slot, then tx hash) is the one recorded; a cancelled survey's artifact carries no per-role tallies",
    "sealed-reveal: for a sealed survey, decrypt every in-window (rule 1), structurally-valid (rule 2), credential-proven (rule 3) response with the definition-pinned round's BLS-verified drand beacon, then decode the plaintext as the CBOR answers array (trailing zero padding to padding_size is ignored) and re-validate those answers against the definition; a response that fails to decrypt, decode, or re-validate is excluded",
    "sealed-dedup: latest-in-chain dedup (rule 4) runs only over sealed responses whose decrypted answers re-validated; undecryptable/invalid responses are excluded and never supersede an earlier valid one; excluded responses are not committed to the artifact",
    "sealed-artifact: a sealed survey's tally carries sealed=true (cancellations included); each counted responder commits its revealed answers in JSON-safe wire form (bytes→hex, bigint→decimal string, Map→tagged pairs); only drand quicknet (chain hash 52db9ba7...c84e971) is supported — a non-quicknet sealed survey gets no artifact",
  ],
} as const;

/** blake2b-256 of the canonical {@link RULESET_DESCRIPTOR}. */
export function rulesetHash(): string {
  return blake2b256Hex(canonicalJson(RULESET_DESCRIPTOR));
}

/** One counted responder as committed in the artifact (weight in lovelace). */
export interface ArtifactResponder {
  /** "key:<hex>" | "script:<hex>" — same identity the dedup rule uses. */
  readonly credential: string;
  /** Decimal string; "1" per responder for the count-only Keyholder role. */
  readonly weight: string;
  /** Tx that carried the counted response. */
  readonly txHash: string;
  /**
   * Index of the response within that tx's label-17 payload. With `txHash`,
   * the full on-chain coordinate of the exact response dedup counted — a tx
   * can carry several responses, so the hash alone is ambiguous.
   */
  readonly responseIndex: number;
  /**
   * The responder's revealed answers, present **iff** the survey is sealed — a
   * `toJsonSafe`-encoded `AnswerItem[]` (the `sealed-artifact` rule's wire form).
   * Sealed answers live only in the ciphertext, so a verifier cannot rejoin them
   * from the on-chain response the way public tallies do; committing them here
   * makes a sealed tally reproducible. Decode with {@link responderAnswers}.
   */
  readonly answers?: unknown;
}

/** JSON-plain mirror of {@link WeightedQuestionTally} (bigints → strings). */
export type ArtifactQuestion =
  | {
      readonly kind: "options";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      readonly optionWeights: readonly string[];
      readonly optionCounts: readonly number[];
      readonly answeredCount: number;
      readonly answeredWeight: string;
    }
  | {
      readonly kind: "numeric";
      readonly weightedSum: string;
      readonly answeredWeight: string;
      readonly answeredCount: number;
      readonly values: readonly {
        readonly value: string;
        readonly weight: string;
        readonly count: number;
      }[];
    }
  | {
      readonly kind: "perOption";
      readonly unit: "points" | "rating";
      readonly perOption: readonly {
        readonly weightedSum: string;
        readonly answeredWeight: string;
        readonly count: number;
      }[];
      readonly levelWeights?: readonly (readonly string[])[];
      readonly answeredCount: number;
      readonly answeredWeight: string;
    }
  | {
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: string;
    };

/** One covered role's weighted result. */
export interface ArtifactRoleTally {
  /** CIP-179 role tag (0 DRep, 3 Stakeholder, 4 Keyholder). */
  readonly role: number;
  /**
   * The role's electorate total at end_epoch (decimal lovelace) — turnout's
   * denominator. `null` for count-only roles (Keyholder), where responder count
   * is the only meaningful total.
   */
  readonly total: string | null;
  /** Counted responders, sorted by credential identity. */
  readonly responders: readonly ArtifactResponder[];
  /** Weighted aggregates, one per question in definition order. */
  readonly questions: readonly ArtifactQuestion[];
}

/** The hashed part: everything the result *is*, nothing about where from. */
export interface TallyBody {
  /** {@link rulesetHash} of the rules this tally was computed under. */
  readonly rulesetHash: string;
  readonly network: string;
  readonly survey: {
    /** Defining tx hash (hex) + index within its definitions array. */
    readonly txId: string;
    readonly index: number;
    readonly endEpoch: number;
  };
  /**
   * True iff the survey's definition submission mode is `sealed` — i.e. answers
   * were timelock-encrypted and revealed after the drand round (the
   * `sealed-artifact` rule). Set on cancellation artifacts too. A hash-committed
   * value, so it is the same on the emitter and any re-verifier.
   */
  readonly sealed: boolean;
  /** Present iff the survey was cancelled in-window; `perRole` is then empty. */
  readonly cancelled?: {
    readonly txHash: string;
    readonly slot: number;
    readonly epoch: number;
  };
  /** Sorted by role ascending. */
  readonly perRole: readonly ArtifactRoleTally[];
}

/** The full served artifact: the hashed tally + unhashed provenance. */
export interface TallyArtifact {
  readonly tally: TallyBody;
  readonly provenance: {
    readonly source: {
      /** e.g. "koios". */
      readonly provider: string;
      readonly baseUrl: string;
    };
    /** Unix seconds when the weight snapshot completed. */
    readonly fetchedAt: number;
    /** Which endpoint supplied each role's weights/membership. */
    readonly byRole: readonly {
      readonly role: number;
      readonly endpoint: string;
    }[];
    /**
     * Present iff the survey is sealed: the drand chain + round the answers were
     * revealed with, and the beacon itself. Deliberately **outside** the hash —
     * the tally's on-chain definition already pins `(chainHash, round)`, and the
     * beacon is independently fetchable and BLS-verifiable, so an offline auditor
     * can re-derive the reveal without trusting this record.
     */
    readonly sealedReveal?: {
      /** Drand chain hash (hex) the round belongs to (quicknet). */
      readonly chainHash: string;
      /** Drand round whose beacon decrypts the responses. */
      readonly round: number;
      /** The beacon used, as returned by drand (re-verifiable against `round`). */
      readonly beacon: {
        readonly round: number;
        readonly randomness: string;
        readonly signature: string;
      };
    };
  };
}

/** blake2b-256 of the canonical tally body — the artifact's content address. */
export function artifactHash(tally: TallyBody): string {
  return blake2b256Hex(canonicalJson(tally));
}

/** Convert weighted tallies to their JSON-plain artifact form. */
export function toArtifactQuestions(
  tallies: readonly WeightedQuestionTally[],
): ArtifactQuestion[] {
  return tallies.map((t): ArtifactQuestion => {
    switch (t.kind) {
      case "options":
        return {
          kind: "options",
          unit: t.unit,
          optionWeights: t.optionWeights.map(String),
          optionCounts: [...t.optionCounts],
          answeredCount: t.answeredCount,
          answeredWeight: String(t.answeredWeight),
        };
      case "numeric":
        return {
          kind: "numeric",
          weightedSum: String(t.weightedSum),
          answeredWeight: String(t.answeredWeight),
          answeredCount: t.answeredCount,
          values: t.values.map((v) => ({
            value: String(v.value),
            weight: String(v.weight),
            count: v.count,
          })),
        };
      case "perOption":
        return {
          kind: "perOption",
          unit: t.unit,
          perOption: t.perOption.map((o) => ({
            weightedSum: String(o.weightedSum),
            answeredWeight: String(o.answeredWeight),
            count: o.count,
          })),
          ...(t.levelWeights !== undefined && {
            levelWeights: t.levelWeights.map((row) => row.map(String)),
          }),
          answeredCount: t.answeredCount,
          answeredWeight: String(t.answeredWeight),
        };
      case "custom":
        return {
          kind: "custom",
          answeredCount: t.answeredCount,
          answeredWeight: String(t.answeredWeight),
        };
    }
  });
}

/**
 * Convert counted responders to their committed artifact form — sorted by
 * credential identity, the determinism rule the hash depends on.
 *
 * For sealed surveys pass `{ revealedAnswers: true }`: each responder then also
 * commits its decrypted answers (`toJsonSafe(AnswerItem[])`, the `sealed-artifact`
 * wire form), taken from the already-revealed public response. Public tallies
 * omit `answers` — a verifier rejoins those from the on-chain response instead.
 */
export function toArtifactResponders(
  responders: readonly WeightedResponder[],
  opts?: { revealedAnswers?: boolean },
): ArtifactResponder[] {
  return responders
    .map((r): ArtifactResponder => {
      const base = {
        credential: r.credentialKey,
        weight: String(r.weight),
        txHash: r.txHash,
        responseIndex: r.responseIndex,
      };
      if (!opts?.revealedAnswers) return base;
      // By contract the response is already revealed to its public form here;
      // commit the answers array in JSON-safe wire form.
      const answers =
        r.response.answers.type === "public" ? r.response.answers.answers : [];
      return { ...base, answers: toJsonSafe(answers) };
    })
    .sort((a, b) =>
      a.credential < b.credential ? -1 : a.credential > b.credential ? 1 : 0,
    );
}

/**
 * Decode a sealed responder's committed answers back to `AnswerItem[]` — the
 * inverse of the `toJsonSafe` encoding {@link toArtifactResponders} writes under
 * `{ revealedAnswers: true }`. Returns `null` for a public/legacy responder that
 * committed no answers.
 */
export function responderAnswers(r: ArtifactResponder): AnswerItem[] | null {
  if (r.answers === undefined) return null;
  return fromJsonSafe(r.answers) as AnswerItem[];
}
