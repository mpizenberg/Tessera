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
  /**
   * The governance action (bech32 CIP-129 `gov_action1…`) this row's `proofOk`
   * was evaluated against — mechanism B's linking action, or null for a
   * standalone survey. Persisted so the verdict can be re-evaluated when a
   * survey's link set changes (Koios resolves anchors lazily; a link can appear
   * after the first validation). Meaningful only when `proofOk` is non-null.
   */
  readonly linkedActionId: string | null;
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
  /** Lovelace as a decimal string ("1" per Keyholder responder). */
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
   * Rows needing no enrichment retry (both `blockIndex` and `proofOk` present),
   * as a map from {@link validationKey} to the `linkedActionId` the verdict was
   * evaluated against. A refresh skips these unless the survey's current link
   * differs from the stored one (then the verdict is re-evaluated).
   */
  completedValidations(): Promise<Map<string, string | null>>;
  upsertValidatedResponses(
    rows: readonly ValidatedResponseRow[],
  ): Promise<void>;
  validatedForSurvey(surveyKey: string): Promise<ValidatedResponseRow[]>;
  /**
   * Prune validated rows by (txHash, responseIndex). Used at finalization when a
   * counted response has vanished from a *complete* snapshot (reorged out): the
   * scan floor means it can't age back in and the row is never otherwise pruned,
   * so leaving it would postpone the survey forever. If the tx later re-appears
   * it is simply re-validated (the row is uncompleted again).
   */
  deleteValidatedResponses(
    keys: readonly { txHash: string; responseIndex: number }[],
  ): Promise<void>;

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
  /**
   * Survey keys whose artifact finalized the survey as **cancelled** (its
   * `tally.cancelled` is set — no per-role tally). Feeds the list payload's
   * `finalizedCancelled` overlay so Explore keeps showing "Cancelled" after a
   * cancelled survey closes. Derived from the stored artifact JSON at query
   * time (`json_extract`) rather than a denormalized column: artifacts are
   * immutable and few, and the JSON stays the single source of truth.
   */
  finalizedCancelledKeys(): Promise<Set<string>>;
}

/**
 * Fetch-once cache of label-17 tx metadata — the snapshot scan's resume state
 * (backs `@tessera/koios`'s `TxMetadataCache`). A tx's metadata is immutable
 * (content-addressed by its hash), so `put` is insert-or-ignore and the table
 * only grows with new on-chain activity; membership in a snapshot is decided
 * by each run's fresh label-index scan, never by this cache. What it buys:
 * a refresh cut short (Worker subrequest cap) keeps the batches it fetched, so
 * repeated over-budget runs converge instead of re-fetching forever.
 */
export interface ScanCacheStore {
  /** Cached metadata JSON for the cached subset of the requested hashes. */
  cachedTxMetadata(txHashes: readonly string[]): Promise<Map<string, unknown>>;
  /** Persist fetched metadata (insert-or-ignore; values are JSON-safe). */
  putTxMetadata(entries: ReadonlyMap<string, unknown>): Promise<void>;
}

/** What the backend wires together: snapshot cache + tally + scan persistence. */
export type BackendStore = SnapshotStore & TallyStore & ScanCacheStore;
