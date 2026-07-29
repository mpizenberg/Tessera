/**
 * Snapshot storage — the repository interface.
 *
 * The read-path snapshot is content the browser used to re-fetch on every load;
 * here it is computed once server-side and stored, materialized as the rows the
 * serving routes read directly (`materialize.ts` turns a scan into them). Two
 * implementations share this seam and the same SQLite schema: `store-node.ts`
 * (node:sqlite, local process) and `store-d1.ts` (Cloudflare D1, Worker) — see
 * `backend/ARCHITECTURE.md` §3. Every method is async because D1 is; the node
 * impl just wraps its synchronous calls. The Phase-2 tally tables (§6.5) join
 * this schema too.
 */

import type { GovLink } from "cip-179/domain";

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
   * Canonical cursor for the epoch-aligned governance-action set this row's
   * `proofOk` was evaluated against: the sorted, comma-joined action ids (bech32
   * CIP-129 `gov_action1…`), or null for a standalone survey. A single linking
   * action stores just that id (the common case). Persisted so the verdict can
   * be re-evaluated when a survey's link set changes (Koios resolves anchors
   * lazily; a link can appear, change, or be removed after the first
   * validation). Meaningful only when `proofOk` is non-null.
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

/**
 * One sealed response's reveal outcome (§6.5) — written as each ciphertext is
 * decrypted, so existing rows are exactly the reveal resume cursor.
 */
export interface SealedRevealRow {
  readonly txHash: string;
  readonly responseIndex: number;
  /**
   * Wire JSON (`toJsonSafe`) of the decrypted `SurveyResponse`, or null when the
   * ciphertext did not decrypt or did not decode. Both outcomes are final: the
   * beacon is immutable, so a re-attempt can only reach the same one.
   */
  readonly response: string | null;
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
   * as a map from {@link validationKey} to the `linkedActionId` cursor (the
   * canonical epoch-aligned link set) the verdict was evaluated against. A
   * refresh skips these unless the survey's current link set differs from the
   * stored one (then the verdict is re-evaluated).
   */
  completedValidations(): Promise<Map<string, string | null>>;
  upsertValidatedResponses(
    rows: readonly ValidatedResponseRow[],
  ): Promise<void>;
  validatedForSurvey(surveyKey: string): Promise<ValidatedResponseRow[]>;
  /**
   * Prune validated rows — and any reveal outcome recorded for them — by
   * (txHash, responseIndex). Used at finalization when a counted response has
   * vanished from a *complete* snapshot (reorged out): the scan floor means it
   * can't age back in and the row is never otherwise pruned, so leaving it would
   * postpone the survey forever. If the tx later re-appears it is simply
   * re-validated and re-revealed.
   */
  deleteValidatedResponses(
    keys: readonly { txHash: string; responseIndex: number }[],
  ): Promise<void>;

  /**
   * Reveal outcomes recorded for one survey's responses, keyed by
   * {@link validationKey}. Presence is "already attempted"; the value is the
   * decrypted response's wire JSON, or null for an undecryptable ciphertext.
   */
  sealedReveals(surveyKey: string): Promise<Map<string, string | null>>;
  /**
   * Insert-or-ignore: a reveal outcome is written once and never revised. It is
   * derived from an immutable beacon and an immutable ciphertext, and an
   * artifact may already have been emitted from it.
   */
  putSealedReveals(rows: readonly SealedRevealRow[]): Promise<void>;

  /** All snapshotted weights for one (epoch, role). */
  weightRows(epoch: number, role: number): Promise<WeightRow[]>;
  /**
   * Insert-or-ignore: a snapshotted weight is written once and never revised.
   * An artifact may already have been emitted from it, and a later re-read of
   * the same past epoch can only reintroduce the possibility of disagreement.
   */
  insertWeightRows(rows: readonly WeightRow[]): Promise<void>;
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

/**
 * One refresh run's operational stats (`refresh_run`) — what the health
 * endpoint reports. Failed runs carry `ok: false` plus the error text; their
 * `incomplete`/`surveys`/`responses`/`payloadBytes` are 0 (nothing was stored).
 */
export interface RefreshRunRow {
  /** Unix seconds when the run started (primary key; latest-wins on collision). */
  readonly startedAt: number;
  readonly durationMs: number;
  /** Koios HTTP requests issued by this run (scan + validation + finalization). */
  readonly koiosCalls: number;
  readonly ok: boolean;
  /** Failure message when `ok` is false, else null. */
  readonly error: string | null;
  /** The stored snapshot's `incomplete` flag (scan paging cap hit). */
  readonly incomplete: boolean;
  readonly surveys: number;
  readonly responses: number;
  /** Total wire JSON stored across the materialized rows — the growth metric. */
  readonly payloadBytes: number;
}

/** Keep refresh-run rows this long; older ones are pruned on each insert. */
export const REFRESH_RUN_RETENTION_SECONDS = 7 * 86_400;

/** Aggregates over a window of refresh runs (the daily-quota view). */
export interface RefreshTotals {
  readonly runs: number;
  readonly failures: number;
  readonly koiosCalls: number;
}

/** Operational-metrics persistence behind `/api/health` (health footer). */
export interface HealthStore {
  /**
   * Record one run (latest-wins on a same-second collision) and prune rows
   * older than {@link REFRESH_RUN_RETENTION_SECONDS} before it.
   */
  putRefreshRun(row: RefreshRunRow): Promise<void>;
  /** The most recent run, or null before the first one. */
  lastRefreshRun(): Promise<RefreshRunRow | null>;
  /** Aggregates over runs with `startedAt >= sinceUnix`. */
  refreshTotalsSince(sinceUnix: number): Promise<RefreshTotals>;
  /**
   * Validated-response rows still awaiting an enrichment retry (`blockIndex`
   * or `proofOk` null) — a persistently nonzero backlog means something is
   * wedged upstream.
   */
  incompleteValidationCount(): Promise<number>;
}

/**
 * How long a refresh holds the lease. Correctness needs only that this exceeds
 * a real run's duration (seconds); the remaining margin is what it costs to
 * recover from a run killed mid-flight, which never releases — refreshes then
 * pause until it expires.
 */
export const REFRESH_LEASE_SECONDS = 600;

/**
 * Take the lease for one run: insert it, or steal it iff the incumbent has
 * expired. The `WHERE` makes that an atomic test-and-set — a conflicting row
 * that is still live matches nothing, so the statement affects no rows and
 * `RETURNING` yields none, which is how the loser learns it lost.
 *
 * Binds: (holder, expiresAt, nowSec).
 */
export const REFRESH_LEASE_ACQUIRE = `
  INSERT INTO refresh_lease (id, holder, expires_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    holder = excluded.holder,
    expires_at = excluded.expires_at
    WHERE refresh_lease.expires_at <= ?
  RETURNING holder
`;

/**
 * Release by token, so a run that overran its TTL and was superseded cannot
 * free the lease its successor now holds. Binds: (holder).
 */
export const REFRESH_LEASE_RELEASE =
  "DELETE FROM refresh_lease WHERE id = 1 AND holder = ?";

/**
 * Single-writer guard over the refresh. Neither runtime serializes its own
 * scheduler, and concurrent runs are worse than wasteful: the slower one
 * finishes last and writes its older scan over the newer snapshot, stamped with
 * the newer `fetchedAt`.
 */
export interface RefreshLeaseStore {
  /**
   * Hold the lease until `nowSec + ttlSeconds`, returning an opaque token, or
   * null if another run holds an unexpired one. Exactly one of two racing
   * callers gets a token.
   */
  acquireRefreshLease(
    nowSec: number,
    ttlSeconds: number,
  ): Promise<string | null>;
  /** Give up a lease. A token that no longer holds it is a no-op. */
  releaseRefreshLease(token: string): Promise<void>;
}

/**
 * One materialized row of the paged Explore list (`survey_index`), written by
 * the refresh from the aggregated snapshot. The `record`/`cancellations`/
 * `govLinks` columns hold each survey's slice of the wire payload as JSON
 * text, so a page body is assembled by parse-and-concatenate. The flag
 * columns mirror the shared pagination semantics in `@tessera/core`'s
 * `page.ts` (`pageSurveyList` is the executable spec the SQL follows).
 */
export interface SurveyIndexRow {
  /** "<txHex>:<index>". */
  readonly surveyKey: string;
  readonly slot: number;
  readonly endEpoch: number;
  readonly sealed: boolean;
  /** Owner-verified cancellation, including the finalized-artifact overlay. */
  readonly cancelled: boolean;
  /** Has an epoch-aligned (verified) governance link. */
  readonly govLinked: boolean;
  /** `credentialKey` of the definition's owner (the `mine` filter's key). */
  readonly owner: string;
  /** Lowercased searchable on-chain text. */
  readonly haystack: string;
  /** Wire JSON of the `SurveyRecord`. */
  readonly record: string;
  /** Wire JSON of the `CancellationRecord[]` targeting this survey. */
  readonly cancellations: string;
  /** Wire JSON of the `GovLink[]` naming this survey (aligned or not). */
  readonly govLinks: string;
  readonly responseCount: number;
  /** The tally artifact finalized this survey as cancelled (overlay flag). */
  readonly finalizedCancelled: boolean;
}

/**
 * One on-chain response, materialized for serving. The `record` column holds
 * the wire JSON of the `ResponseRecord`, so a bundle body is assembled by
 * parse-and-concatenate; the other columns are what the two queries over this
 * table select on — a survey's responses, and a credential's answered surveys.
 */
export interface ResponseRow {
  readonly txHash: string;
  /** Position within the carrying payload's `responses` array. */
  readonly responseIndex: number;
  /** Target survey ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** Responder identity ("key:<hex>" | "script:<hex>"). */
  readonly credential: string;
  readonly slot: number;
  /** Wire JSON of the `ResponseRecord`. */
  readonly record: string;
}

/**
 * One survey's serving slice, as stored: wire JSON text throughout, so the
 * bundle body is assembled by parse-and-concatenate.
 */
export interface SurveyBundleRows {
  /** Wire JSON of the `SurveyRecord`. */
  readonly record: string;
  /** Wire JSON of the `CancellationRecord[]` targeting it. */
  readonly cancellations: string;
  /** Wire JSON of each `ResponseRecord` targeting it. */
  readonly responses: string[];
}

/** The page-independent envelope stored alongside the materialized rows. */
export interface SnapshotMeta {
  /** Wire JSON of the snapshot's `ChainTip`. */
  readonly tip: string;
  readonly incomplete: boolean;
  /**
   * Unix seconds when the producing scan started — the instant {@link tip} was
   * read, so the envelope describes one point in time rather than straddling
   * the run. Versions every snapshot-derived route's ETag; the refresh lease
   * serializes runs, so successive snapshots always carry distinct values.
   */
  readonly fetchedAt: number;
}

/** A page query against the survey index (see `@tessera/core` `page.ts`). */
export interface SurveyPageQuery {
  /** The snapshot tip's epoch — the open/closed boundary. */
  readonly tipEpoch: number;
  readonly filter: import("@tessera/core").SurveyListFilter;
  /** `credentialKey` strings the `mine` filter matches owners against. */
  readonly credentials: readonly string[];
  /** Lowercased AND search terms. */
  readonly searchTerms: readonly string[];
  readonly cursor: import("@tessera/core").SurveyCursor | null;
  /** Rows to return; callers pass limit+1 to detect a next page. */
  readonly limit: number;
}

/**
 * The materialized snapshot every serving route reads: survey rows, response
 * rows, and the envelope shared by both.
 */
export interface SnapshotStore {
  /**
   * Atomically replace every materialized row and the envelope. Wholesale
   * replacement, not merge: a record can leave the snapshot (reorged out, or
   * aged past the scan's floor), and a run's rows must never be served mixed
   * with the previous run's.
   */
  replaceSnapshot(
    surveys: readonly SurveyIndexRow[],
    responses: readonly ResponseRow[],
    meta: SnapshotMeta,
  ): Promise<void>;
  /** The envelope, or null before the first refresh — the readiness signal. */
  snapshotMeta(): Promise<SnapshotMeta | null>;
  /**
   * Every governance link in the stored snapshot, re-parsed from the survey
   * rows. This is what a refresh whose gov-links fetch failed publishes instead
   * of an empty list: the links are stale by up to one refresh interval, but
   * "unknown" displayed as "none" blanks them everywhere until the next good
   * run. Display only — a stale link must never reach a verdict or an artifact.
   */
  snapshotGovLinks(): Promise<GovLink[]>;
  /**
   * One survey's bundle slice, or null if the snapshot doesn't have it. The
   * responses are ALL of them, raw and undeduped — client-side audit and
   * re-tally need the whole set — ordered by (slot, txHash, responseIndex) so
   * a body is byte-stable between refreshes. Survey and responses are read
   * together: separately, a refresh landing between the two reads would pair
   * one run's survey with the next run's responses.
   */
  surveyBundle(surveyKey: string): Promise<SurveyBundleRows | null>;
  /**
   * Survey keys any of `credentials` responded to (`credentialKey` form). Raw
   * membership, no dedupe or validity filter — this feeds "surveys I answered".
   */
  respondedSurveyKeys(credentials: readonly string[]): Promise<string[]>;
  /**
   * One page in (bucket ASC, slot DESC, key ASC) order, where bucket is
   * 0 gov-linked / 1 open / 2 closed computed against `tipEpoch`. Each row
   * carries its computed bucket (the cursor needs it).
   */
  surveyIndexPage(
    q: SurveyPageQuery,
  ): Promise<(SurveyIndexRow & { bucket: number })[]>;
  /** Global chip counts over the search-matching set. */
  surveyIndexCounts(
    tipEpoch: number,
    credentials: readonly string[],
    searchTerms: readonly string[],
  ): Promise<import("@tessera/core").SurveyListCounts>;
  close(): void;
}

/** What the backend wires together: snapshot + tally + scan + health. */
export type BackendStore = SnapshotStore &
  TallyStore &
  ScanCacheStore &
  HealthStore &
  RefreshLeaseStore;
