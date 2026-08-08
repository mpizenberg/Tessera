/**
 * On-chain record shapes — the raw, decoded CIP-179 state a data source
 * surfaces, one entry per transaction payload.
 *
 * These are the input contract for the pure domain layer: any implementation
 * that fetches label-17 state (Koios scan, semantic indexer, …) produces these
 * shapes, and every aggregation — pairing responses to surveys, tallying,
 * lifecycle status, credential proof — is defined over them. How the records
 * are *fetched* is deliberately not part of this package; that seam is
 * application-specific.
 *
 * @module
 */

import type { SurveyDefinition, SurveyResponse, SurveyRef } from "../index.js";

/** Where a record sits in the chain, for ordering and dedup. */
export interface ChainPos {
  /** Transaction hash (hex). */
  readonly txHash: string;
  /** Absolute slot of the containing block. */
  readonly slot: number;
  /**
   * Epoch of the containing block, as reported by the chain indexer — the
   * authoritative input to the deadline rule (`epochNo ≤ end_epoch`), unlike
   * the tip-relative `epochOfSlot` estimate.
   */
  readonly epochNo: number;
}

/** A survey definition as published on-chain. */
export interface SurveyRecord extends ChainPos {
  /** Canonical reference: (this tx, index within its definitions array). */
  readonly ref: SurveyRef;
  readonly definition: SurveyDefinition;
  /**
   * Owner-proof evidence from the *defining* transaction: CIP-179 requires it to
   * prove the `owner` credential (mechanism A only — B is responses-only, so a
   * Plutus-script owner has no proof path at all). Absent or `null` when the
   * source didn't fetch it or couldn't decode it, which is **unknown**, not
   * disproven: a consumer that freezes something (an artifact, a verdict) must
   * postpone instead of reading it as a failed proof.
   */
  readonly proof?: MechanismAProof | null;
}

/** A response as published on-chain. */
export interface ResponseRecord extends ChainPos {
  /** Position within the carrying payload's `responses` array. */
  readonly responseIndex: number;
  /**
   * Position of the transaction within its block (`tx_block_index`), when the
   * source has enriched the record with it (one `/tx_info` round-trip — the
   * serving tier does, the browser's direct Koios scan doesn't). Same-slot
   * responses order by it in {@link import("./dedupe").laterInChain}.
   */
  readonly blockIndex?: number;
  readonly response: SurveyResponse;
}

/**
 * A native script, in a framework-agnostic shape, for evaluating owner-proof of a
 * native-script-credentialed cancellation (CIP-179 mechanism A). Mirrors the
 * Cardano `native_script` CDDL; timelock clauses collapse to `timelock` since
 * they constrain validity intervals (ledger-enforced), not signers.
 */
export type NativeScriptInfo =
  | { readonly kind: "sig"; readonly keyHash: string }
  | { readonly kind: "all"; readonly scripts: readonly NativeScriptInfo[] }
  | { readonly kind: "any"; readonly scripts: readonly NativeScriptInfo[] }
  | {
      readonly kind: "atLeast";
      readonly required: number;
      readonly scripts: readonly NativeScriptInfo[];
    }
  | { readonly kind: "timelock" };

/**
 * What a transaction contains that CIP-179 mechanism A evaluates — its
 * `required_signers` and the native scripts it witnesses — decoded from the
 * tx's CBOR. Whether it proves a given credential is pure domain logic
 * ({@link import("./mechanismA")}); the source's job is only to surface what
 * the tx contains. Definition, cancellation and response transactions all prove
 * credentials from exactly this evidence.
 */
export interface MechanismAProof {
  /** Key hashes in the tx body's `required_signers` (field 14), hex. */
  readonly requiredSigners: readonly string[];
  /** Native scripts in the tx's witness set, keyed by script hash (hex). */
  readonly nativeScripts: readonly {
    readonly scriptHash: string;
    readonly script: NativeScriptInfo;
  }[];
}

/**
 * A governance vote cast by the transaction (one `voting_procedures` entry) —
 * the evidence CIP-179 mechanism B evaluates: a response credential can prove
 * itself by voting on the survey's linked action in the same transaction.
 */
export interface VoteBinding {
  /**
   * Conway voter tag: 0/1 CC hot key/script, 2/3 DRep key/script, 4 SPO.
   * Determines both the credential kind (key vs script) and the role the
   * binding can prove.
   */
  readonly voterTag: number;
  /** The voter's credential hash (hex, 28 bytes). */
  readonly credentialHash: string;
  /** Bech32 CIP-129 ids (`gov_action1…`) of the actions this voter voted on. */
  readonly actionIds: readonly string[];
}

/**
 * Everything a transaction contains that can prove a CIP-179 credential:
 * mechanism A evidence (required signers + native scripts, the
 * {@link MechanismAProof} part) plus mechanism B evidence (governance vote
 * bindings) — decoded from the transaction's CBOR by the data source.
 */
export interface TxProof extends MechanismAProof {
  readonly votes: readonly VoteBinding[];
}

/** A cancellation as published on-chain (references the cancelled survey). */
export interface CancellationRecord extends ChainPos {
  readonly target: SurveyRef;
  /**
   * Owner-proof evidence from the cancelling transaction, or `null` if it
   * couldn't be fetched/decoded (then the cancellation is treated as unverified).
   */
  readonly proof: MechanismAProof | null;
}

/** Current chain position, for epoch-dependent lifecycle status. */
export interface ChainTip {
  readonly epoch: number;
  readonly slot: number;
  /** Unix time (seconds) of the tip block — anchors slot/epoch → wall-clock. */
  readonly time: number;
  /**
   * Slot offset within the current epoch (0-based). Post-Shelley slots are 1s,
   * so `time - epochSlot` is the unix start of the current epoch — used to
   * project a future epoch boundary exactly.
   */
  readonly epochSlot: number;
  /**
   * The live `gov_action_lifetime` protocol parameter (epochs a governance
   * action stays open for voting). An Info Action submitted in epoch `e` closes
   * at `e + govActionLifetime`; used to auto-fill a linked survey's `end_epoch`
   * so it matches (CIP-179 epoch-alignment). Best-effort: 0 if the param lookup
   * failed (it only feeds the optional governance-link helper).
   */
  readonly govActionLifetime: number;
}

/** All label-17 records, partitioned by payload type. */
export interface Cip179Records {
  readonly surveys: readonly SurveyRecord[];
  readonly responses: readonly ResponseRecord[];
  readonly cancellations: readonly CancellationRecord[];
  /**
   * True when the source could not fetch every matching record (e.g. a paging
   * cap was hit), so the partition above is a *prefix* of on-chain state, not
   * the whole. The UI surfaces this as "results may be incomplete" rather than
   * presenting an undercounted snapshot as authoritative. Absent/false = full.
   */
  readonly incomplete?: boolean;
}

/**
 * A governance action that advertises a survey (CIP-179 linkage, canonicalized
 * Action → Survey). Any governance action kind may carry the link (CIP-179 v5);
 * discovered from the action's anchor metadata, and a single survey MAY be
 * linked by several actions. Epoch-alignment with the survey is checked in the
 * domain layer.
 */
export interface GovLink {
  /** Survey ref the action links to ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** Bech32 governance action id of the linking action. */
  readonly actionId: string;
  /** The action's expiry epoch (must equal the survey's `end_epoch`). */
  readonly endEpoch: number;
  /** Action title from CIP-108 governance metadata, if present. */
  readonly title: string | null;
}

/**
 * A governance action whose anchor document could not be read — not fetched, or
 * not resolved by the indexer asked — so whether it links a survey is
 * **unknown**, not "no link".
 * Distinguishing the two is what lets a consumer surface an unresolved anchor
 * instead of silently deciding "not linked" (finding 6).
 *
 * The action's `endEpoch` is on-chain (available even when the off-chain anchor
 * isn't), so it scopes the uncertainty by the epoch-alignment rule: an
 * unresolved anchor only clouds surveys ending at this epoch — and, of those,
 * only responses that actually cast a role-matching vote on this action — rather
 * than every survey.
 */
export interface UnresolvedGovAction {
  /** Bech32 governance action id (on-chain, always available). */
  readonly actionId: string;
  /** The action's expiry epoch (`expiration - 1`); a survey it could link ends here. */
  readonly endEpoch: number;
}

/**
 * The result of scanning governance actions for survey links: the resolved
 * links, plus the epoch-aligned actions whose anchor couldn't be resolved. The
 * two are kept apart so a consumer can treat an *unresolvable* anchor as unknown
 * (retry / postpone / report indeterminate) instead of coercing it into the
 * substantive verdict "this survey has no links" (finding 6).
 */
export interface GovLinkScan {
  readonly links: readonly GovLink[];
  readonly unresolved: readonly UnresolvedGovAction[];
}

/**
 * The self-contained slice for one survey: its definition record, ALL of its
 * responses (sealed ciphertexts included — client-side audit/tally/reveal need
 * the raw set), the cancellations targeting it, and the tip that anchors
 * epoch-dependent checks. A published result re-verifies from exactly this
 * bundle; a verifier never needs a full snapshot.
 */
export interface SurveyBundle {
  readonly survey: SurveyRecord;
  readonly responses: readonly ResponseRecord[];
  readonly cancellations: readonly CancellationRecord[];
  readonly tip: ChainTip;
}
