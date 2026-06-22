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
}

/** All label-17 records, partitioned by payload type. */
export interface Cip179Records {
  readonly surveys: readonly SurveyRecord[];
  readonly responses: readonly ResponseRecord[];
  readonly cancellations: readonly CancellationRecord[];
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
}
