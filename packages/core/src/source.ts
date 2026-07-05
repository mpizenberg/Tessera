/**
 * The data-source seam.
 *
 * Everything the UI needs to *read* CIP-179 state flows through `DataSource`.
 * The first implementation talks to Koios directly (`koios.ts`); a future
 * semantic indexer backend can implement the same interface and drop in with
 * no change to the domain or UI layers.
 *
 * Implementations return raw, decoded on-chain records (one per transaction
 * payload entry) plus chain position. All aggregation — pairing responses to
 * surveys, tallying, lifecycle status — happens in the pure `domain/` layer,
 * never here.
 */

import type { SurveyDefinition, SurveyResponse, SurveyRef } from "cip-179";

import type { TallyArtifact } from "./artifact";

/** Where a record sits in the chain, for ordering and dedup. */
export interface ChainPos {
  /** Transaction hash (hex). */
  readonly txHash: string;
  /** Absolute slot of the containing block. */
  readonly slot: number;
  /**
   * Epoch of the containing block, as reported by the chain indexer — the
   * authoritative input to the §6.3 deadline rule (`epochNo ≤ end_epoch`),
   * unlike the tip-relative `epochOfSlot` estimate.
   */
  readonly epochNo: number;
}

/** A survey definition as published on-chain. */
export interface SurveyRecord extends ChainPos {
  /** Canonical reference: (this tx, index within its definitions array). */
  readonly ref: SurveyRef;
  readonly definition: SurveyDefinition;
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
 * Evidence proving (or not) that a cancelling transaction authorized the
 * cancellation — decoded from the cancelling tx's CBOR. The owner-credential
 * check is pure domain logic ({@link import("./cancellation")}); the
 * source's job is only to surface what the tx contains.
 */
export interface CancellationProof {
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
 * {@link CancellationProof} part) plus mechanism B evidence (governance vote
 * bindings) — decoded from the transaction's CBOR by the data source.
 */
export interface TxProof extends CancellationProof {
  readonly votes: readonly VoteBinding[];
}

/** A cancellation as published on-chain (references the cancelled survey). */
export interface CancellationRecord extends ChainPos {
  readonly target: SurveyRef;
  /**
   * Owner-proof evidence from the cancelling transaction, or `null` if it
   * couldn't be fetched/decoded (then the cancellation is treated as unverified).
   */
  readonly proof: CancellationProof | null;
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
 * A governance Info Action that advertises a survey (CIP-179 linkage,
 * canonicalized Action → Survey). Discovered from the action's anchor metadata;
 * epoch-alignment with the survey is checked in the domain layer.
 */
export interface GovLink {
  /** Survey ref the action links to ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** Bech32 governance action id of the linking Info Action. */
  readonly actionId: string;
  /** The action's voting end epoch (must equal the survey's `end_epoch`). */
  readonly endEpoch: number;
  /** Action title from CIP-108 governance metadata, if present. */
  readonly title: string | null;
}

/**
 * Everything the survey *list* page (Explore) renders from — one bounded
 * payload regardless of participation volume. Responses are the only unbounded
 * record set, and the list only needs their per-survey count, so they're
 * pre-deduped (the core `dedupeResponses` rule) into `responseCounts` at the
 * source. Cancellations ride raw (they're tiny) so owner-proof verification
 * stays client-side.
 */
export interface SurveyListPayload {
  readonly surveys: readonly SurveyRecord[];
  readonly cancellations: readonly CancellationRecord[];
  readonly govLinks: readonly GovLink[];
  readonly tip: ChainTip;
  /** Distinct responders per survey key ("<txHex>:<index>"), latest-valid-wins. */
  readonly responseCounts: Record<string, number>;
  /**
   * Survey keys the serving tier finalized as **cancelled** (their tally
   * artifact records an owner-proven, in-window cancellation and no per-role
   * tally). Client-side proof verification can't reach this state: the scan
   * keeps `proof: null` for cancellations of closed surveys, so without this
   * overlay a cancelled-then-closed survey would display as plain "Ended".
   * Trusting it adds nothing new — the same server already supplies the whole
   * record set, and the claim stays auditable against the served artifact.
   * Absent in direct-Koios mode (no artifacts exist there).
   */
  readonly finalizedCancelled?: readonly string[];
  /** Mirrors {@link Cip179Records.incomplete} for the scan behind this list. */
  readonly incomplete?: boolean;
  /**
   * Global per-filter totals over the search-matching set — present on paged
   * responses ({@link import("./page").pageSurveyList} / the serving tier's
   * paged route), absent on a full unpaged payload.
   */
  readonly counts?: import("./page").SurveyListCounts;
  /**
   * Continuation for the next page (opaque keyset cursor), `null` when this
   * page is the last. Absent on a full unpaged payload.
   */
  readonly nextCursor?: string | null;
}

/**
 * Operational health of a serving-tier backend (`GET /api/health`) — what the
 * app's thin health footer renders. Wire-plain by design (no bytes/bigints),
 * so it round-trips as ordinary JSON. Only the indexer path produces it; the
 * direct-Koios path has no refresh loop to report on.
 */
export interface BackendHealth {
  readonly network: string;
  /** Freshness of the served snapshot, or null before the first refresh. */
  readonly snapshot: {
    readonly fetchedAt: number;
    readonly ageSeconds: number;
  } | null;
  /** The most recent refresh run's stats, or null before the first run. */
  readonly lastRefresh: {
    readonly startedAt: number;
    readonly durationMs: number;
    /** Koios HTTP requests the run issued (scan + validation + finalization). */
    readonly koiosCalls: number;
    readonly ok: boolean;
    /** Failure message when `ok` is false, else null. */
    readonly error: string | null;
    /** The scan hit its paging cap — the snapshot is a prefix, not the whole. */
    readonly incomplete: boolean;
    readonly surveys: number;
    readonly responses: number;
    /** Serialized snapshot size — the single-blob storage row's growth metric. */
    readonly payloadBytes: number;
  } | null;
  /** Rolling totals over the last 24 hours of refresh runs. */
  readonly last24h: {
    readonly runs: number;
    readonly failures: number;
    readonly koiosCalls: number;
  };
  /** Validated responses still awaiting an enrichment retry. */
  readonly validationBacklog: number;
  /** Configured budgets the counts above are compared against. */
  readonly limits: {
    /** Per-refresh Koios call budget (Worker subrequest cap by default). */
    readonly koiosCallsPerRefresh: number;
    /** Daily Koios quota when the operator configured one, else null. */
    readonly koiosCallsPerDay: number | null;
  };
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

/**
 * The seam the UI reads through — one method per page-shaped read, so a
 * serving-tier implementation maps each onto one bounded HTTP route. Full-scan
 * reads (`fetchAll`, `chainTip`, `fetchGovernanceLinks`) are deliberately NOT
 * part of the seam: they live on `KoiosDataSource` concretely, where the
 * serving tier's refresh (and the Koios implementation of the methods below)
 * still need them.
 */
export interface DataSource {
  /**
   * The Explore-list payload: every survey with per-survey response counts,
   * plus tip / governance links / raw cancellations. See {@link SurveyListPayload}.
   */
  surveyList(): Promise<SurveyListPayload>;
  /**
   * One page of the Explore list ({@link import("./page").SurveyListParams}):
   * filtered, searched, and keyset-paginated server-side, with global chip
   * counts and a `nextCursor` continuation. Optional: the serving-tier
   * implementation answers from its materialized survey index; the direct
   * Koios path leaves it undefined and the app pages the full `surveyList()`
   * payload in memory with {@link import("./page").pageSurveyList} instead.
   */
  surveyListPage?(
    params: import("./page").SurveyListParams,
  ): Promise<SurveyListPayload>;
  /**
   * The self-contained per-survey slice (detail/respond pages, verifiers).
   * Rejects when the ref matches no known survey.
   */
  surveyBundle(ref: SurveyRef): Promise<SurveyBundle>;
  /**
   * Survey keys ("<txHex>:<index>") having at least one response from any of
   * the given credentials, each in the `credentialKey` form
   * ("key:<hex>" | "script:<hex>"). Raw responses, no dedupe/validity filter —
   * this feeds Explore's "surveys I answered" flags, where any attempt counts.
   * Empty input resolves to [] without a fetch.
   */
  respondedKeys(credentialKeys: readonly string[]): Promise<string[]>;
  /**
   * Block-inclusion status for a set of just-submitted transactions, keyed by
   * tx hash. The value is the number of confirmations, or `null` when the tx is
   * not yet in a block (the chain indexer can't see the mempool). Used only to
   * flip a "pending" indicator to "confirmed" — never to drive the survey list.
   */
  txStatus(txHashes: readonly string[]): Promise<Map<string, number | null>>;
  /**
   * The survey's final tally artifact ({@link import("./artifact").TallyArtifact}),
   * or `null` when none exists (survey still open, not yet finalized, or the
   * source can't produce artifacts — the direct Koios path never does; the UI
   * then falls back to the raw client-side tally).
   */
  artifact(ref: SurveyRef): Promise<TallyArtifact | null>;
  /**
   * Operational health of the backing service ({@link BackendHealth}), for the
   * app's health footer. Optional: only the serving-tier implementation has a
   * refresh loop to report on — the direct Koios path leaves it undefined and
   * the footer simply doesn't render.
   */
  health?(): Promise<BackendHealth>;
}
