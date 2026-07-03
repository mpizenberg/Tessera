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

import { blake2b256Hex, canonicalJson } from "./canonical";
import type { WeightedQuestionTally, WeightedResponder } from "./weightedTally";

/**
 * The counting rules this implementation applies, as data. Change any rule and
 * `rulesetHash()` changes with it — bump `rulesetVersion` whenever that
 * happens. Mirrors §6.2/§6.3 and the CIP-179 credential-proof mechanisms.
 */
export const RULESET_DESCRIPTOR = {
  rulesetVersion: 1,
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
  /** Sealed surveys get no artifact yet (emission deferred) — always false. */
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
 */
export function toArtifactResponders(
  responders: readonly WeightedResponder[],
): ArtifactResponder[] {
  return responders
    .map((r) => ({
      credential: r.credentialKey,
      weight: String(r.weight),
      txHash: r.txHash,
    }))
    .sort((a, b) =>
      a.credential < b.credential ? -1 : a.credential > b.credential ? 1 : 0,
    );
}
