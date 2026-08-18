/**
 * Snapshot storage — the repository interface and the driver port under it.
 *
 * The read-path snapshot is content the browser used to re-fetch on every load;
 * here it is computed once server-side and stored, materialized as the rows the
 * serving routes read directly (`materialize.ts` turns a scan into them). The
 * tally tables (ARCHITECTURE.md §6.2) join the same schema.
 *
 * {@link BackendStore} has one implementation (`store-sql.ts`) over one SQLite
 * schema (`migrations/*.sql`); what a runtime supplies is a {@link SqlDriver} —
 * `store-node.ts` (node:sqlite, local process) or `store-d1.ts` (Cloudflare D1,
 * Worker). That is the "thin swappable storage adapter" of §3. Every method is
 * async because D1 is; the node driver wraps its synchronous calls.
 */

import type { ResponseCursor } from "cardano-tessera-core";
import type { ChainTip, GovLink, GovLinkDoc } from "cip-179/domain";

/** One SQL statement (SQLite dialect) and its positional bindings. */
export interface SqlQuery {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * Everything a runtime has to provide for {@link BackendStore} to work: run
 * SQL, and group statements so a multi-statement operation is one transaction
 * (and, on a remote database, one round trip).
 *
 * Reads and writes are separate methods because that is what the two runtimes
 * offer: `node:sqlite` returns rows from `all()` and change counts from `run()`
 * and cannot return both for one statement.
 */
export interface SqlDriver {
  /** One query's rows. */
  all<T>(query: SqlQuery): Promise<T[]>;
  /** Several reads together; rows per query, in argument order. */
  batchAll<T>(queries: readonly SqlQuery[]): Promise<T[][]>;
  /** Several writes as one transaction; rows changed per query, in order. */
  batchWrite(queries: readonly SqlQuery[]): Promise<number[]>;
  close(): void;
}

/**
 * One response's validation result (TALLY-SPEC.md §3), persisted so each
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
 * One credential's snapshotted weight at an epoch (§6.2) — written only once
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
 * One sealed response's reveal outcome (§6.2) — written as each ciphertext is
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
 * Survey keys holding an artifact, split by outcome. `cancelled` ⊆
 * `finalized`: a cancellation artifact (its `tally.cancelled` is set, no
 * per-role tally) appears in both. The cancelled side feeds the list payload's
 * `finalizedCancelled` overlay so Explore keeps showing "Cancelled" after a
 * cancelled survey closes. Mutable sets on purpose: `finalizeClosedSurveys`
 * folds its emissions into the pair it returns.
 */
export interface ArtifactKeys {
  readonly finalized: Set<string>;
  readonly cancelled: Set<string>;
}

/**
 * One survey's stored link-set cursor, as pinned by a completed bindable-role
 * verdict: the survey may carry several distinct cursors when its verdicts
 * were completed under different link sets.
 */
export interface ValidatedLinkCursor {
  readonly surveyKey: string;
  readonly linkedActionId: string | null;
}

/**
 * What a completed verdict was decided against, so a refresh can tell whether
 * it still holds: the canonical epoch-aligned link set (`linkedActionId`) and
 * the chain position the response occupied when it was judged.
 */
export interface CompletedValidation {
  readonly linkedActionId: string | null;
  readonly slot: number;
  readonly epochNo: number;
}

/** Tally persistence (ARCHITECTURE.md §6.2), same database. */
export interface TallyStore {
  /**
   * The given transactions' rows needing no enrichment retry (both
   * `blockIndex` and `proofOk` present), keyed by {@link validationKey}. A
   * refresh skips these unless what they were decided against has moved
   * since. Keyed by transaction so validation reads only the verdicts of the
   * responses in front of it — never a whole survey's, however many it has.
   */
  completedValidationsForTxs(
    txHashes: readonly string[],
  ): Promise<Map<string, CompletedValidation>>;
  /**
   * Distinct link-set cursors pinned by completed bindable-role verdicts of
   * the surveys ending at or after `minEndEpoch` — the input to "which
   * surveys' link sets changed since their verdicts". Callers pass the
   * finalization floor: a survey below it finalized against a link set that
   * had already settled, so no verdict down there can be re-evaluated, and
   * the read stays bounded by the undecided surveys rather than by history.
   */
  validatedLinkCursors(minEndEpoch: number): Promise<ValidatedLinkCursor[]>;
  /**
   * Surveys with at least one verdict still awaiting an enrichment retry.
   * Their stored responses re-enter validation even when the scan's input no
   * longer carries them.
   */
  incompleteValidationSurveys(): Promise<string[]>;
  upsertValidatedResponses(
    rows: readonly ValidatedResponseRow[],
  ): Promise<void>;
  /**
   * The survey's verdict rows, or only those recorded for `txHashes` when given
   * — the bundle route narrows to the page it is serving, so its verdict read
   * is bounded by the page and not by the survey's participation.
   */
  validatedForSurvey(
    surveyKey: string,
    txHashes?: readonly string[],
  ): Promise<ValidatedResponseRow[]>;
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
   * The key sets restricted to `surveyKeys` — a keyed read, so a caller's cost
   * is the surveys it asks about, never the artifact archive. Cancelled-ness
   * is derived from the stored artifact JSON at query time (`json_extract`)
   * rather than a denormalized column: artifacts are immutable, and the JSON
   * stays the single source of truth.
   */
  artifactKeysFor(surveyKeys: readonly string[]): Promise<ArtifactKeys>;
  /**
   * Bank the finalization floor (read back by {@link SnapshotStore.scanState}).
   * Only a complete, caught-up pass computes one: while the scan is still
   * integrating, a survey below the floor may not have all its responses yet.
   */
  putFinalizationFloor(endEpoch: number): Promise<void>;
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
   * The banked tx hashes that no live survey bears on: not a definition, a
   * cancellation or a response of any of `liveSurveyKeys` — the prune's drop
   * set, decided in the database by one seek per banked hash against each of
   * the three tables, so the cost is the cache's size plus the live set's,
   * never the archive's.
   */
  unclaimedTxProofHashes(
    liveSurveyKeys: readonly string[],
  ): Promise<readonly string[]>;
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
 * leaves the query filter for good, its bank rows are pruned with it, and the
 * settlement floor rises past it so no later pass reads it back out.
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
  /**
   * Bank the settlement floor (read back by {@link SnapshotStore.scanState}).
   * Written only once the refresh that computed it has reconciled its rows: a
   * floor that ran ahead of the rows would freeze a survey's links at whatever
   * its row happened to hold.
   */
  putSettlementFloor(expiration: number): Promise<void>;
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
 * endpoint reports. `surveys`/`responses`/`payloadBytes` describe what the
 * run's segment integrated, not the whole corpus (counting the corpus per
 * refresh is exactly the cost the windowed scan removes). Failed runs carry
 * `ok: false` plus the error text; their
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
  /**
   * The stored snapshot's `incomplete` flag: a record the listing promised
   * never arrived, or the walker is still catching up to the tip. Either way
   * nothing finalized this run.
   */
  readonly incomplete: boolean;
  readonly surveys: number;
  readonly responses: number;
  /** Wire JSON across the rows this run upserted — the growth metric. */
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
 * parse-and-concatenate; the other columns are what the queries over this
 * table select on — a survey's responses, a credential's answered surveys,
 * and the (role, credential) identity key a survey's responder count is a
 * distinct count of.
 */
export interface ResponseRow {
  readonly txHash: string;
  /** Position within the carrying payload's `responses` array. */
  readonly responseIndex: number;
  /** Target survey ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** Claimed CIP-179 role. */
  readonly role: number;
  /** Responder identity ("key:<hex>" | "script:<hex>"). */
  readonly credential: string;
  readonly slot: number;
  /** Wire JSON of the `ResponseRecord`. */
  readonly record: string;
}

/** A stored response's coordinates and identity, without its record. */
export type StoredResponse = Omit<ResponseRow, "record">;

/**
 * A response's identity key and chain position, without its record — what a
 * responder count reads. `role` and `credential` together are the key CIP-179
 * counts at most one response per; `slot` is where the row sits relative to a
 * survey's banked settled count.
 */
export interface ResponseIdentity {
  readonly surveyKey: string;
  readonly role: number;
  readonly credential: string;
  readonly slot: number;
}

/** The (role, credential) identity key as one string: "<role>|<credential>". */
export const responseIdentityKey = (role: number, credential: string): string =>
  `${role}|${credential}`;

/**
 * A survey's banked settled responder count: `settledCount` distinct
 * (role, credential) keys among its response rows with slot below
 * `belowSlot`. Frozen because those rows lie below the settlement window and
 * cannot move; usable by an integration only when every response row it may
 * add, replace or delete lies at or above `belowSlot`.
 */
export interface ResponseCountBank {
  readonly surveyKey: string;
  readonly settledCount: number;
  readonly belowSlot: number;
}

/**
 * One on-chain cancellation, as a slot-addressed row — what the segment sweep
 * detects rollbacks against. The `record` column holds the wire JSON of the
 * `CancellationRecord` (owner-proof evidence included when it was attached);
 * the per-survey `cancellations` projection on {@link SurveyIndexRow} is
 * rebuilt from these rows whenever the survey is touched.
 */
export interface CancellationRow {
  readonly txHash: string;
  /** Target survey ("<txHex>:<index>"). */
  readonly surveyKey: string;
  readonly slot: number;
  /** Wire JSON of the `CancellationRecord`. */
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
  /**
   * One page of the responses targeting it, in storage order (slot, carrying
   * transaction, index within it) — coordinates included, because the page's
   * last row is the next cursor.
   */
  readonly responses: ResponseRow[];
  /** Wire JSON of the `GovLink[]` discovered for it, `"[]"` when none. */
  readonly govLinks: string;
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
   * Wire JSON of the banked {@link BankedListCounts}, or null when unknown
   * (stored before the counts existed) — the list route then falls back to
   * the live aggregate until the next refresh publishes.
   */
  readonly listCounts: string | null;
}

/**
 * The chip counts that depend on neither the caller's credentials nor a
 * search — every chip but `mine`. The refresh banks them with the envelope,
 * so a no-search list request reads them from the envelope it already holds
 * instead of aggregating the whole `survey_index`; they are recomputed (one
 * SQL aggregate) only on a refresh that changed rows or crossed an epoch
 * boundary, since `active`/`sealed`/`public` move at epoch turnover even
 * when the rows do not.
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
 * generation rewind). `caughtUp` records how the next run resumes: true means
 * the last walk was exhausted at the tip (re-derive the settlement margin
 * below `cursor`); false means it was budget-capped (continue strictly after
 * the cursor pair). `generation` is the derivation generation the stored rows
 * were built under; deployed code carrying a different one must rewind the
 * cursor rather than trust them. `trickle` is where the drift-healing rescan
 * is in its rotation over the settled prefix.
 */
export interface ScanState {
  readonly cursor: ScanCursor | null;
  readonly caughtUp: boolean;
  readonly generation: number;
  readonly trickle: ScanCursor | null;
}

/**
 * The scan row as banked: the walker (null before the first windowed run) and
 * the two frontiers that ride the same row and are written on their own. The
 * settlement floor is the lowest expiration epoch not yet settled — everything
 * below it is decided for good, so the governance pass never asks about it
 * again. The finalization floor is the lowest end epoch still holding a survey
 * finalization expects to decide — below it every closed survey has emitted
 * its artifact or been judged permanently untalliable. Both read 0 before
 * anything is banked, which asks about everything once.
 */
export interface BankedScan {
  readonly walker: ScanState | null;
  readonly settlementFloor: number;
  readonly finalizationFloor: number;
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
   * Republish only the envelope, leaving the materialized rows untouched —
   * how the refresh lands recomputed banked counts after the segment
   * reconcile already published this run's freshness.
   */
  publishSnapshotMeta(meta: SnapshotMeta): Promise<void>;
  /** The envelope, or null before the first refresh — the readiness signal. */
  snapshotMeta(): Promise<SnapshotMeta | null>;
  /**
   * The stored governance links of the surveys ending at or after
   * `minEndEpoch`, keyed by survey (rows whose link slice is non-empty) —
   * the link-set change detection's stored side. Bounded because only an
   * unsettled epoch's links can change: below the settlement floor a row's
   * slice IS the frozen truth, so there is nothing to compare it against.
   */
  surveyGovLinks(minEndEpoch: number): Promise<Map<string, GovLink[]>>;
  /**
   * One survey's bundle slice, or null if the snapshot doesn't have it. The
   * responses are ALL of them, raw and undeduped — client-side audit and
   * re-tally need the whole set — ordered by (slot, txHash, responseIndex) so
   * a body is byte-stable between refreshes. Survey and responses are read
   * together: separately, a refresh landing between the two reads would pair
   * one run's survey with the next run's responses.
   */
  /**
   * One survey's row plus a page of its responses, read together: separately, a
   * refresh landing between the two reads would pair one run's survey with the
   * next's responses. `page.cursor` is exclusive; `page.limit` bounds the read,
   * so no request costs a survey's whole participation.
   */
  surveyBundle(
    surveyKey: string,
    page: { cursor: ResponseCursor | null; limit: number },
  ): Promise<SurveyBundleRows | null>;
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
  /** The banked scan row, whole — one read serves the walker and both floors. */
  scanState(): Promise<BankedScan>;
  /**
   * Bank the walker state, whole. Written only after the segment it describes
   * has been reconciled: a banked cursor past unreconciled slots would settle
   * a gap in for good, while a reconciled segment with an unbanked cursor
   * only costs an idempotent re-walk.
   */
  putScanState(state: ScanState): Promise<void>;
  /**
   * Atomically reconcile one slot segment: upsert the given survey
   * projections (in-window and touched-outside alike), upsert the response
   * and cancellation rows, and delete rows whose slot lies in `range` but
   * whose key the arguments don't carry — a row the segment listing didn't
   * see has rolled back. Rows outside `range` are never deletion candidates,
   * so settled history survives however little the segment covers; a null
   * `range` (an incomplete scan — a listed tx may be missing its record)
   * upserts without sweeping anything. Writes the recounted surveys' banks
   * and publishes `meta` in the same transaction. Returns the number of rows
   * the reconcile actually changed (the envelope and banks excluded, since
   * freshness moves every run) — the banked list counts' recompute trigger.
   */
  reconcileSegment(
    range: SlotRange | null,
    surveys: readonly SurveyIndexRow[],
    responses: readonly ResponseRow[],
    cancellations: readonly CancellationRow[],
    banks: readonly ResponseCountBank[],
    meta: SnapshotMeta,
  ): Promise<number>;
  /** The stored projections of `keys`, in key order; unknown keys are absent. */
  surveyRowsByKeys(keys: readonly string[]): Promise<SurveyIndexRow[]>;
  /**
   * Every stored response of the given surveys, records included — what
   * finalization tallies and validation revives. Not a count input: a
   * survey's responder count reads identities from the index.
   */
  responseRowsForSurveys(surveyKeys: readonly string[]): Promise<ResponseRow[]>;

  /**
   * The identity keys of the given surveys' stored responses at or above each
   * survey's own `fromSlot`, in no particular order — a recount's stored
   * half. Read from the identity index, so no record is touched; `fromSlot`
   * 0 reads a survey whole, a banked survey reads only its window.
   */
  responseIdentitiesFrom(
    requests: readonly { surveyKey: string; fromSlot: number }[],
  ): Promise<ResponseIdentity[]>;
  /**
   * For each survey, which of the given identity keys already appear among
   * its stored responses below `belowSlot` — the probe that tells a window
   * key apart from a new responder against a banked settled count. One index
   * seek per key.
   */
  settledResponseKeys(
    requests: readonly {
      surveyKey: string;
      belowSlot: number;
      keys: readonly { role: number; credential: string }[];
    }[],
  ): Promise<Map<string, Set<string>>>;
  /** The banked settled counts of the given surveys; a survey never banked is absent. */
  responseCountBanks(
    surveyKeys: readonly string[],
  ): Promise<Map<string, ResponseCountBank>>;
  /**
   * The stored responses with slot in `range`, records excluded — the
   * pre-sweep window state. Read before {@link reconcileSegment}: a row here
   * that the segment listing lacks is about to be swept, and its survey needs
   * a recount; a row whose slot differs from the listing's has moved.
   */
  responsesInSlotRange(range: SlotRange): Promise<StoredResponse[]>;
  /**
   * Every stored cancellation of the given surveys — a touched survey's
   * `cancellations` projection is rebuilt over these merged with the
   * segment's own listing.
   */
  cancellationRowsForSurveys(
    surveyKeys: readonly string[],
  ): Promise<CancellationRow[]>;
  /** The stored cancellations with slot in `range` — see {@link responseRowsInSlotRange}. */
  cancellationRowsInSlotRange(range: SlotRange): Promise<CancellationRow[]>;
  /**
   * Surveys whose verified-while-open cancellation just expired: `cancelled`
   * set, no finalized-cancelled overlay, and closed at `tipEpoch`. Client-side
   * cancellation verification only holds while a survey is open, so these
   * rows' projections are stale the moment their epoch turns — they go back
   * on the touched list. Empty in steady state.
   */
  staleCancelledSurveyKeys(tipEpoch: number): Promise<string[]>;
  /**
   * Stamp the finalized-cancelled overlay (and the `cancelled` flag it
   * implies) onto the given surveys' rows where not already set, returning
   * how many rows flipped. Idempotent — called every refresh with every
   * cancelled artifact's key, it applies this pass's finalizations and heals
   * drift in one statement.
   */
  markFinalizedCancelled(surveyKeys: readonly string[]): Promise<number>;
  /**
   * Distinct `end_epoch` values at or after `minEndEpoch` across the stored
   * surveys, ascending — the governance-link pass's input. The bound is the
   * settlement floor minus one: an epoch below it is settled, its links are
   * frozen into the rows, and asking again could only return the same answer.
   */
  surveyEndEpochs(minEndEpoch: number): Promise<number[]>;
  /**
   * Stored surveys ending in `[floorEpoch, tipEpoch)` with no row in
   * `tally_artifact` — finalization's candidate set, in key order. The floor is
   * what bounds it: below it every survey is decided, so neither its row nor
   * its artifact is read at all.
   */
  unfinalizedClosedSurveyRows(
    floorEpoch: number,
    tipEpoch: number,
  ): Promise<SurveyIndexRow[]>;
  /**
   * Keys of the stored surveys with `end_epoch >= minEndEpoch` — the open set
   * plus however many epochs of recent closers the caller's horizon covers
   * (the proof-cache prune's live candidates).
   */
  surveyKeysEndingAtOrAfter(minEndEpoch: number): Promise<string[]>;
  close(): void;
}

/** What the backend wires together: snapshot + tally + scan + links + health. */
export type BackendStore = SnapshotStore &
  TallyStore &
  ScanCacheStore &
  GovLinkStore &
  HealthStore &
  RefreshLeaseStore;
