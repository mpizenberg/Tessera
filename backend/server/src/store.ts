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

import type { ChainTip, GovLink, GovLinkDoc } from "cip-179/domain";

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
   * be re-evaluated when a survey's link set changes: anchors resolve a few per
   * refresh, so a link appears the pass its document is first read. Meaningful
   * only when `proofOk` is non-null.
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

/**
 * The survey keys holding an artifact, split by outcome. `cancelled` ⊆
 * `finalized`: a cancellation artifact (its `tally.cancelled` is set, no
 * per-role tally) appears in both. The cancelled side feeds the list payload's
 * `finalizedCancelled` overlay so Explore keeps showing "Cancelled" after a
 * cancelled survey closes. Mutable sets on purpose: `finalizeClosedSurveys`
 * takes one read as its starting state and folds its own emissions in, so the
 * whole refresh scans `tally_artifact` once.
 */
export interface ArtifactKeys {
  readonly finalized: Set<string>;
  readonly cancelled: Set<string>;
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
  /**
   * Both key sets in one table scan. Cancelled-ness is derived from the stored
   * artifact JSON at query time (`json_extract`) rather than a denormalized
   * column: artifacts are immutable and few, and the JSON stays the single
   * source of truth.
   */
  finalizedArtifactKeys(): Promise<ArtifactKeys>;
}

/**
 * Fetch-once caches behind the snapshot scan (they back `cardano-tessera-koios`'s
 * `ScanCache`). Both are keyed by tx hash, which content-addresses what they
 * hold, so every `put` is insert-or-ignore and no row is ever rewritten.
 *
 * Metadata is the scan's resume state: membership in a snapshot is decided by
 * each run's fresh label-index scan, never by the cache, and a refresh cut
 * short (Worker subrequest cap) keeps the batches it fetched, so repeated
 * over-budget runs converge instead of re-fetching forever.
 *
 * Proof CBOR is the credential-proof evidence behind every owner-proof and
 * response proof. It is the one cache here that is *pruned* — its rows are
 * large and a survey's proof stops being read once its artifact is frozen (see
 * `proofCache.ts`).
 */
export interface ScanCacheStore {
  /** Cached metadata JSON for the cached subset of the requested hashes. */
  cachedTxMetadata(txHashes: readonly string[]): Promise<Map<string, unknown>>;
  /** Persist fetched metadata (insert-or-ignore; values are JSON-safe). */
  putTxMetadata(entries: ReadonlyMap<string, unknown>): Promise<void>;
  /** Cached tx CBOR for the cached subset of the requested hashes. */
  cachedTxProofCbor(txHashes: readonly string[]): Promise<Map<string, string>>;
  /** Persist fetched tx CBOR (insert-or-ignore). */
  putTxProofCbor(entries: ReadonlyMap<string, string>): Promise<void>;
  /**
   * Every banked tx hash. The prune's candidate set, which is what keeps its
   * cost proportional to the cache rather than to the survey archive.
   */
  cachedTxProofHashes(): Promise<readonly string[]>;
  /** Drop cached CBOR no live survey bears on any more. */
  deleteTxProofCbor(txHashes: readonly string[]): Promise<void>;
}

/** One expiration epoch whose governance-link set is final. */
export interface SettledGovEpoch {
  /** Koios `expiration` = the linked survey's `end_epoch` + 1. */
  readonly expiration: number;
  /** Every link the actions expiring at this epoch carry. */
  readonly links: readonly GovLink[];
  /**
   * Action ids whose anchor was still unresolved when patience ran out. They
   * are settled as "not a link" — the only alternative is waiting forever on a
   * dead anchor — and kept so that verdict stays auditable.
   */
  readonly gaveUp: readonly string[];
  readonly settledAt: number;
}

/**
 * Governance-link resolution state (ARCHITECTURE.md §5.2): the per-anchor bank
 * and the per-epoch settlement memo. Both are rebuildable cache — wiping them
 * costs a re-scan, a re-fetch and a re-settle, never a wrong answer.
 *
 * The bank is keyed by anchor hash because that is what the classification
 * actually depends on: anchored content is hash-fixed, so a document verified
 * against its on-chain hash classifies the same way forever, whichever action
 * points at it. A verified *non*-link is banked too (a null doc) — it is just
 * as final as a link, and re-fetching it would be the same work for the same
 * answer.
 *
 * Settling an epoch is what keeps the scan O(active surveys): a settled epoch
 * leaves the query filter for good, and its bank rows are pruned with it.
 */
export interface GovLinkStore {
  /** Banked classifications for the cached subset of the requested hashes. */
  cachedGovAnchors(
    hashes: readonly string[],
  ): Promise<Map<string, GovLinkDoc | null>>;
  /** Bank verified classifications (insert-or-ignore: a row is terminal). */
  putGovAnchors(entries: ReadonlyMap<string, GovLinkDoc | null>): Promise<void>;
  /** Drop banked anchors no unsettled epoch needs any more. */
  deleteGovAnchors(hashes: readonly string[]): Promise<void>;
  /** The settled epochs among `expirations` (absent = still unsettled). */
  settledGovEpochs(
    expirations: readonly number[],
  ): Promise<Map<number, SettledGovEpoch>>;
  /** Record an epoch as settled (insert-or-ignore: settlement is once and final). */
  putSettledGovEpoch(row: SettledGovEpoch): Promise<void>;
}

/** A `gov_epoch` row as stored: both collections arrive as JSON text. */
export interface DbGovEpochRow {
  readonly expiration: number;
  readonly links: string;
  readonly gaveUp: string;
  readonly settledAt: number;
}

export const govEpochFromDb = (r: DbGovEpochRow): SettledGovEpoch => ({
  expiration: r.expiration,
  links: JSON.parse(r.links) as GovLink[],
  gaveUp: JSON.parse(r.gaveUp) as string[],
  settledAt: r.settledAt,
});

/**
 * One refresh run's operational stats (`refresh_run`) — what the health
 * endpoint reports. Failed runs carry `ok: false` plus the error text; their
 * `incomplete`/`surveys`/`responses`/`payloadBytes` are 0 (nothing was stored).
 */
export interface RefreshRunRow {
  /** Unix seconds when the run started (primary key; latest-wins on collision). */
  readonly startedAt: number;
  readonly durationMs: number;
  /**
   * Every upstream HTTP request the run issued, whatever the host — the number
   * the Worker's per-invocation subrequest cap actually bounds.
   */
  readonly upstreamRequests: number;
  /**
   * The Koios share of {@link upstreamRequests}. No budget is per-run for
   * Koios (its quota is daily, tracked in `upstream_tally`), but when a run
   * trips the subrequest cap this is what says whether paging or anchor
   * fetches spent it.
   */
  readonly koiosCalls: number;
  readonly ok: boolean;
  /** Failure message when `ok` is false, else null. */
  readonly error: string | null;
  /**
   * No governance-links failure was observed in this run. False means the scan
   * came back unusable, so the published snapshot carries the *previous* run's
   * links and no artifact was minted — a state the run's own `ok` can't show.
   */
  readonly govLinksOk: boolean;
  /** The stored snapshot's `incomplete` flag (scan paging cap hit). */
  readonly incomplete: boolean;
  readonly surveys: number;
  readonly responses: number;
  /** Total wire JSON stored across the materialized rows — the growth metric. */
  readonly payloadBytes: number;
  /**
   * Validated rows still awaiting an enrichment retry when the run recorded
   * itself — what `/api/health` serves without re-counting the table. Null
   * when the count failed or the row predates it; health then counts live.
   */
  readonly validationBacklog: number | null;
}

/** Keep operational history (runs, tally buckets) this long. */
export const OPERATIONAL_RETENTION_SECONDS = 7 * 86_400;

/** Outcomes over a window of refresh runs. */
export interface RefreshTotals {
  readonly runs: number;
  readonly failures: number;
}

/**
 * Which budget an upstream request was spent from. The three are metered
 * separately because they are three quotas: the operator's Koios account, the
 * segregated comfort account behind `/api/tx_status` (review finding 15), and
 * whatever hosts serve governance anchor documents.
 */
export type UpstreamKind = "koios" | "koios-passthrough" | "anchor";

export const UPSTREAM_KINDS: readonly UpstreamKind[] = [
  "koios",
  "koios-passthrough",
  "anchor",
];

/** Calls to add to the tally; an absent kind adds nothing. */
export type UpstreamCalls = Readonly<Partial<Record<UpstreamKind, number>>>;

/** Calls per kind over some window; every kind present, zero when unspent. */
export type UpstreamTotals = Readonly<Record<UpstreamKind, number>>;

/**
 * Width of one `upstream_tally` bucket, seconds. Bucketing doesn't change how
 * many writes the tally costs (one upsert per call either way), so this is only
 * about how sharply the 24 h window can start and end.
 */
export const TALLY_BUCKET_SECONDS = 300;

export const tallyBucket = (nowSec: number): number =>
  nowSec - (nowSec % TALLY_BUCKET_SECONDS);

/** A fresh per-kind counter. Every kind present, so a reader never sees a hole. */
export const zeroUpstream = (): Record<UpstreamKind, number> => ({
  koios: 0,
  "koios-passthrough": 0,
  anchor: 0,
});

export const upstreamTotalsFrom = (
  rows: Iterable<{ readonly kind: string; readonly calls: number }>,
): UpstreamTotals => {
  const totals = zeroUpstream();
  for (const { kind, calls } of rows) {
    if (kind in totals) totals[kind as UpstreamKind] += calls;
  }
  return totals;
};

/** Every kind together — what a per-invocation subrequest cap actually bounds. */
export const sumUpstream = (totals: UpstreamTotals): number =>
  UPSTREAM_KINDS.reduce((n, kind) => n + totals[kind], 0);

/** Operational-metrics persistence behind `/api/health` (health footer). */
export interface HealthStore {
  /**
   * Record one run (latest-wins on a same-second collision) and prune rows
   * older than {@link OPERATIONAL_RETENTION_SECONDS} before it.
   */
  putRefreshRun(row: RefreshRunRow): Promise<void>;
  /** The most recent run, or null before the first one. */
  lastRefreshRun(): Promise<RefreshRunRow | null>;
  /** Aggregates over runs with `startedAt >= sinceUnix`. */
  refreshTotalsSince(sinceUnix: number): Promise<RefreshTotals>;
  /**
   * Add `calls` to the bucket containing `nowSec`. The serving path calls this
   * once per request that reached upstream, so it stays a single write and
   * never prunes.
   */
  addUpstreamCalls(nowSec: number, calls: UpstreamCalls): Promise<void>;
  /** Per-kind totals over buckets at or after `sinceUnix`. */
  upstreamTotalsSince(sinceUnix: number): Promise<UpstreamTotals>;
  /** Drop tally buckets before `beforeUnix` — the refresh's job, not serving's. */
  pruneUpstreamTally(beforeUnix: number): Promise<void>;
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
 * columns mirror the shared pagination semantics in `cardano-tessera-core`'s
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
  /**
   * `snapshotDigest` of the materialized rows this envelope was published
   * with, or null when unknown (stored before digests existed). The refresh
   * compares the next run's digest against it to skip the row reconcile on an
   * unchanged corpus; null never matches, so unknown reconciles fully.
   */
  readonly payloadDigest: string | null;
  /**
   * Wire JSON of the banked {@link BankedListCounts}, or null when unknown
   * (stored before the counts existed) — the list route then falls back to
   * the live aggregate until the next refresh publishes.
   */
  readonly listCounts: string | null;
}

/**
 * The chip counts that depend on neither the caller's credentials nor a
 * search — every chip but `mine`. The refresh computes them over the rows it
 * materializes and banks them with the envelope, so a no-search list request
 * reads them from the envelope it already holds instead of aggregating the
 * whole `survey_index`. They ride the envelope, not the digest gate:
 * `active`/`sealed`/`public` move at epoch turnover even when the rows do
 * not, and the envelope lands every run.
 */
export type BankedListCounts = Omit<
  import("cardano-tessera-core").SurveyListCounts,
  "mine"
>;

export const snapshotListCounts = (
  meta: SnapshotMeta,
): BankedListCounts | null =>
  meta.listCounts === null
    ? null
    : (JSON.parse(meta.listCounts) as BankedListCounts);

/**
 * The tip a stored snapshot published. Every field of a `ChainTip` is a plain
 * number, so the wire form round-trips through `JSON.parse` unwrapped — no
 * `fromJsonSafe` pass, and the value is usable as banked state rather than only
 * as body text.
 */
export const snapshotTip = (meta: SnapshotMeta): ChainTip =>
  JSON.parse(meta.tip) as ChainTip;

/** A resume point in the ascending `(slot, txHash)` scan order. */
export interface ScanCursor {
  readonly slot: number;
  readonly txHash: string;
}

/** An inclusive slot interval — the scope of one segment integration. */
export interface SlotRange {
  readonly fromSlot: number;
  readonly toSlot: number;
}

/**
 * Banked state of the windowed segment walker. `cursor` is the last chain
 * position whose slot segment is fully integrated into the materialized rows
 * — null means "walk from the config floor" (first windowed run, or a
 * generation rewind). `generation` is the derivation generation the stored
 * rows were built under; deployed code carrying a different one must rewind
 * the cursor rather than trust them. `trickle` is where the drift-healing
 * rescan is in its rotation over the settled prefix.
 */
export interface ScanState {
  readonly cursor: ScanCursor | null;
  readonly generation: number;
  readonly trickle: ScanCursor | null;
}

/** A page query against the survey index (see `cardano-tessera-core` `page.ts`). */
export interface SurveyPageQuery {
  /** The snapshot tip's epoch — the open/closed boundary. */
  readonly tipEpoch: number;
  readonly filter: import("cardano-tessera-core").SurveyListFilter;
  /** `credentialKey` strings the `mine` filter matches owners against. */
  readonly credentials: readonly string[];
  /** Lowercased AND search terms. */
  readonly searchTerms: readonly string[];
  readonly cursor: import("cardano-tessera-core").SurveyCursor | null;
  /** Rows to return; callers pass limit+1 to detect a next page. */
  readonly limit: number;
}

/**
 * The materialized snapshot every serving route reads: survey rows, response
 * rows, and the envelope shared by both.
 */
export interface SnapshotStore {
  /**
   * Atomically reconcile the authoritative scan with the materialized rows and
   * publish its envelope. New immutable responses are inserted, changed survey
   * projections are updated, and absent records are deleted; readers see either
   * the complete previous generation or the complete new one.
   */
  reconcileSnapshot(
    surveys: readonly SurveyIndexRow[],
    responses: readonly ResponseRow[],
    meta: SnapshotMeta,
  ): Promise<void>;
  /**
   * Republish only the envelope, leaving the materialized rows untouched —
   * the fast path when `meta.payloadDigest` matches the stored one, i.e. the
   * rows are already exactly what this refresh materialized and only
   * freshness (tip, fetchedAt) moves.
   */
  publishSnapshotMeta(meta: SnapshotMeta): Promise<void>;
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
  ): Promise<import("cardano-tessera-core").SurveyListCounts>;
  /**
   * Surveys owned by any of `credentials` — the `mine` chip, the one count
   * the banked {@link BankedListCounts} cannot carry. O(owned) via the
   * `survey_index_owner` index.
   */
  ownedSurveyCount(credentials: readonly string[]): Promise<number>;
  /** The banked walker state, or null before the first windowed run. */
  scanState(): Promise<ScanState | null>;
  /**
   * Bank the walker state, whole. Written only after the segment it describes
   * has been reconciled: a banked cursor past unreconciled slots would settle
   * a gap in for good, while a reconciled segment with an unbanked cursor
   * only costs an idempotent re-walk.
   */
  putScanState(state: ScanState): Promise<void>;
  /**
   * Atomically reconcile one slot segment: upsert the given survey
   * projections (in-window and touched-outside alike), insert the immutable
   * responses, and delete rows whose slot lies in `range` but whose key the
   * arguments don't carry — a row the segment listing didn't see has rolled
   * back. Rows outside `range` are never deletion candidates, so settled
   * history survives however little the segment covers. Publishes `meta`
   * in the same transaction, like {@link reconcileSnapshot}.
   */
  reconcileSegment(
    range: SlotRange,
    surveys: readonly SurveyIndexRow[],
    responses: readonly ResponseRow[],
    meta: SnapshotMeta,
  ): Promise<void>;
  /** The stored projections of `keys`, in key order; unknown keys are absent. */
  surveyRowsByKeys(keys: readonly string[]): Promise<SurveyIndexRow[]>;
  /**
   * Every stored response of the given surveys — the recount input for a
   * touched survey: per-survey aggregates are re-derived over these merged
   * with the segment's own listing, never maintained by deltas.
   */
  responseRowsForSurveys(surveyKeys: readonly string[]): Promise<ResponseRow[]>;
  /**
   * The stored responses with slot in `range` — the pre-sweep window state.
   * Read before {@link reconcileSegment}: a row here that the segment listing
   * lacks is about to be swept, and its survey needs a recount.
   */
  responseRowsInSlotRange(range: SlotRange): Promise<ResponseRow[]>;
  /**
   * Distinct `end_epoch` values across the stored surveys, ascending — the
   * governance-link scan's input (its per-epoch settlement memo then decides
   * which of them still need asking about).
   */
  surveyEndEpochs(): Promise<number[]>;
  /**
   * Stored surveys with `end_epoch` before `tipEpoch` and no row in
   * `tally_artifact` — finalization's candidate set, in key order. Bounded by
   * construction: recent closers plus the slow-growing residue that never
   * produces an artifact (spec-invalid definitions, unsupported drand chains).
   */
  unfinalizedClosedSurveyRows(tipEpoch: number): Promise<SurveyIndexRow[]>;
  /**
   * Stored surveys with `end_epoch >= minEndEpoch`, in key order — the open
   * set plus however many epochs of recent closers the caller's horizon
   * covers (the proof-cache prune's live candidates).
   */
  surveyRowsEndingAtOrAfter(minEndEpoch: number): Promise<SurveyIndexRow[]>;
  close(): void;
}

/** What the backend wires together: snapshot + tally + scan + links + health. */
export type BackendStore = SnapshotStore &
  TallyStore &
  ScanCacheStore &
  GovLinkStore &
  HealthStore &
  RefreshLeaseStore;
