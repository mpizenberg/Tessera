/**
 * Snapshot cache storage — the repository interface.
 *
 * The read-path snapshot is content the browser used to re-fetch on every load;
 * here it is computed once server-side and cached. Two implementations share
 * this seam and the same single-row SQLite schema (`snapshot_cache`):
 * `store-node.ts` (node:sqlite, local process) and `store-d1.ts` (Cloudflare
 * D1, Worker) — see `backend/ARCHITECTURE.md` §3. `get`/`put` are async because
 * D1 is; the node impl just wraps its synchronous calls. The Phase-2 tally
 * tables (§6.5) join this schema too.
 */

export interface CachedSnapshot {
  /** JSON-safe DTO (`@tessera/core` wire form) of `{ records, tip, govLinks }`. */
  readonly payload: unknown;
  /** Unix seconds when this snapshot was fetched from Koios. */
  readonly fetchedAt: number;
}

export interface SnapshotStore {
  get(): Promise<CachedSnapshot | null>;
  put(snapshot: CachedSnapshot): Promise<void>;
  close(): void;
}

/**
 * One response's §6.3 validation result (rules 1–3), persisted so each
 * (tx, response) is checked once, not per refresh. `blockIndex`/`proofOk` are
 * `null` when their enrichment fetch failed — the row is then incomplete and
 * retried on a later refresh.
 */
export interface ValidatedResponseRow {
  readonly txHash: string;
  readonly responseIndex: number;
  /** Target survey ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** Claimed CIP-179 role. */
  readonly role: number;
  /** Responder identity ("key:<hex>" | "script:<hex>"). */
  readonly credential: string;
  readonly slot: number;
  /** Authoritative epoch of the response tx (rule 1 input, stored raw). */
  readonly epochNo: number;
  /** `tx_block_index` (same-slot ordering), or null = retry. */
  readonly blockIndex: number | null;
  /** Rule 2 (mechanism A/B credential proof), or null = retry. */
  readonly proofOk: boolean | null;
  /** Full codec validation against the on-chain definition. */
  readonly wellFormed: boolean;
  /** Unix seconds of the (latest) validation attempt. */
  readonly checkedAt: number;
}

/** Identity of a validated row: "<txHash>:<responseIndex>". */
export function validationKey(txHash: string, responseIndex: number): string {
  return `${txHash}:${responseIndex}`;
}

/**
 * One credential's snapshotted weight at an epoch (§6.5) — written only once
 * fetched, so existing rows are exactly the finalization resume cursor.
 */
export interface WeightRow {
  readonly epoch: number;
  readonly role: number;
  /** "key:<hex>" | "script:<hex>". */
  readonly credential: string;
  /** Lovelace as a decimal string ("1" per Owner responder). */
  readonly weight: string;
  readonly registered: boolean;
  readonly fetchedAt: number;
}

/** One finalized survey's immutable artifact row. */
export interface ArtifactRow {
  readonly surveyKey: string;
  readonly endEpoch: number;
  readonly artifactHash: string;
  /** Exact JSON text of `{tally, provenance}` — served verbatim. */
  readonly artifact: string;
  readonly createdAt: number;
}

/** Phase-2 tally persistence (ARCHITECTURE.md §6.5), same database. */
export interface TallyStore {
  /**
   * Keys ({@link validationKey}) of rows needing no retry (both enrichments
   * present) — the refresh's "skip these" set.
   */
  completedValidationKeys(): Promise<Set<string>>;
  upsertValidatedResponses(
    rows: readonly ValidatedResponseRow[],
  ): Promise<void>;
  validatedForSurvey(surveyKey: string): Promise<ValidatedResponseRow[]>;

  /** All snapshotted weights for one (epoch, role). */
  weightRows(epoch: number, role: number): Promise<WeightRow[]>;
  upsertWeightRows(rows: readonly WeightRow[]): Promise<void>;
  /** The (epoch, role) electorate total (decimal string), or null = not yet. */
  epochTotal(epoch: number, role: number): Promise<string | null>;
  putEpochTotal(
    epoch: number,
    role: number,
    total: string,
    endpoint: string,
    fetchedAt: number,
  ): Promise<void>;

  artifactBySurvey(surveyKey: string): Promise<ArtifactRow | null>;
  artifactByHash(artifactHash: string): Promise<ArtifactRow | null>;
  /** Insert-or-ignore: an artifact, once written, is immutable. */
  putArtifact(row: ArtifactRow): Promise<void>;
  /** Survey keys that already have an artifact. */
  finalizedSurveyKeys(): Promise<Set<string>>;
}

/** What the backend wires together: snapshot cache + tally persistence. */
export type BackendStore = SnapshotStore & TallyStore;
