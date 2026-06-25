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

/** Where a record sits in the chain, for ordering and dedup. */
export interface ChainPos {
  /** Transaction hash (hex). */
  readonly txHash: string;
  /** Absolute slot of the containing block. */
  readonly slot: number;
}

/** A survey definition as published on-chain. */
export interface SurveyRecord extends ChainPos {
  /** Canonical reference: (this tx, index within its definitions array). */
  readonly ref: SurveyRef;
  readonly definition: SurveyDefinition;
}

/** A response as published on-chain. */
export interface ResponseRecord extends ChainPos {
  readonly response: SurveyResponse;
}

/** A cancellation as published on-chain (references the cancelled survey). */
export interface CancellationRecord extends ChainPos {
  readonly target: SurveyRef;
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

export interface DataSource {
  /** Current chain tip (epoch + slot). */
  chainTip(): Promise<ChainTip>;
  /**
   * Fetch every CIP-179 (label 17) record currently known.
   *
   * Koios returns the lot in two round-trips; an indexer may stream or
   * paginate. Either way the result is the full snapshot the UI renders from.
   */
  fetchAll(): Promise<Cip179Records>;
  /**
   * Discover governance Info Actions whose anchor links to a survey, scanning
   * only actions created at or after `sinceUnix` (typically the oldest active
   * survey's creation time — older actions can't link to a live survey).
   * Best-effort enrichment: a failure here must not sink the main snapshot
   * (callers default to no links). An indexer would serve this far more cheaply.
   */
  fetchGovernanceLinks(sinceUnix: number): Promise<GovLink[]>;
  /**
   * Block-inclusion status for a set of just-submitted transactions, keyed by
   * tx hash. The value is the number of confirmations, or `null` when the tx is
   * not yet in a block (the chain indexer can't see the mempool). Used only to
   * flip a "pending" indicator to "confirmed" — never to drive the snapshot.
   */
  txStatus(txHashes: readonly string[]): Promise<Map<string, number | null>>;
}
