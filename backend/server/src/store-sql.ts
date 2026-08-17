/**
 * The one {@link BackendStore} implementation: SQLite-dialect SQL over a
 * {@link SqlDriver}. Node and Cloudflare differ only in the driver they supply
 * (`store-node.ts`, `store-d1.ts`), so the schema, the queries and the
 * latest-wins / insert-or-ignore semantics have a single definition and cannot
 * drift between deployments.
 *
 * Every fixed statement lives here, with the method that issues it; SQL whose
 * shape varies with the request — search terms, credential lists, key chunks,
 * the reconciliation program — is composed in `sqlBuilders.ts`.
 */

import type { SurveyListCounts } from "cardano-tessera-core";
import { BINDABLE_ROLES, type GovLink, type GovLinkDoc } from "cip-179/domain";

import type {
  ArtifactKeys,
  ArtifactRow,
  BackendStore,
  CancellationRow,
  CompletedValidation,
  DbGovEpochRow,
  RefreshRunRow,
  RefreshTotals,
  ResponseCountBank,
  ResponseIdentity,
  ResponseRow,
  ScanState,
  SealedRevealRow,
  SettledGovEpoch,
  SlotRange,
  SnapshotMeta,
  SqlDriver,
  SqlQuery,
  SurveyBundleRows,
  SurveyIndexRow,
  SurveyPageQuery,
  UpstreamCalls,
  UpstreamTotals,
  ValidatedLinkCursor,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import {
  govEpochFromDb,
  OPERATIONAL_RETENTION_SECONDS,
  responseIdentityKey,
  tallyBucket,
  UPSTREAM_KINDS,
  upstreamTotalsFrom,
  validationKey,
} from "./store";
import {
  CANCELLATION_ROW_COLUMNS,
  RESPONSE_ROW_COLUMNS,
  SURVEY_ROW_COLUMNS,
  artifactKeysSql,
  cachedByTxHashSql,
  cancellationsBySurveysSql,
  completedValidationsSql,
  markFinalizedCancelledSql,
  ownedCountSql,
  respondedSql,
  responseCountBanksSql,
  responseIdentitiesSql,
  responseTxHashesSql,
  responsesBySurveysSql,
  segmentReconciliationSql,
  settledResponseKeysSql,
  snapshotMetaUpsertSql,
  surveyCountsSql,
  surveyPageSql,
  surveysByKeysSql,
} from "./sqlBuilders";

const query = (sql: string, ...params: unknown[]): SqlQuery => ({
  sql,
  params,
});

/** SQLite has no boolean; a nullable flag round-trips through 0/1/NULL. */
const bit = (value: boolean): number => (value ? 1 : 0);
const nullableBit = (value: boolean | null): number | null =>
  value === null ? null : bit(value);

/** How a `validated_response` row arrives: its booleans are integers. */
export interface DbValidatedRow extends Omit<
  ValidatedResponseRow,
  "proofOk" | "wellFormed"
> {
  proofOk: number | null;
  wellFormed: number;
}

export const validatedFromDb = (r: DbValidatedRow): ValidatedResponseRow => ({
  ...r,
  proofOk: r.proofOk === null ? null : r.proofOk !== 0,
  wellFormed: r.wellFormed !== 0,
});

interface DbRefreshRunRow extends Omit<
  RefreshRunRow,
  "ok" | "govLinksOk" | "incomplete"
> {
  ok: number;
  govLinksOk: number;
  incomplete: number;
}

export const VALIDATED_COLUMNS = `tx_hash AS txHash, response_index AS responseIndex,
       survey_key AS surveyKey, role, credential, slot,
       epoch_no AS epochNo, block_index AS blockIndex,
       proof_ok AS proofOk, linked_action_id AS linkedActionId,
       well_formed AS wellFormed, checked_at AS checkedAt`;

export const ARTIFACT_COLUMNS = `survey_key AS surveyKey, end_epoch AS endEpoch,
       artifact_hash AS artifactHash, artifact, created_at AS createdAt`;

const REFRESH_RUN_COLUMNS = `started_at AS startedAt, duration_ms AS durationMs,
       upstream_requests AS upstreamRequests, koios_calls AS koiosCalls,
       ok, error, gov_links_ok AS govLinksOk, incomplete, surveys, responses,
       payload_bytes AS payloadBytes, validation_backlog AS validationBacklog`;

const BINDABLE = [...BINDABLE_ROLES].sort((a, b) => a - b);

/**
 * The distinct link-set cursors completed verdicts are pinned to, per survey
 * ending at or after the bound. Only bindable roles: no other verdict
 * re-evaluates on a link change, so no other row can put a survey back on the
 * candidate list. Driven from `survey_index_end_epoch` into the per-survey
 * verdict index, so verdicts of surveys below the bound are never read.
 * Binds: (minEndEpoch).
 */
const VALIDATED_LINK_CURSORS = `
  SELECT DISTINCT survey_key AS surveyKey,
         linked_action_id AS linkedActionId
  FROM validated_response
  WHERE survey_key IN (SELECT survey_key FROM survey_index WHERE end_epoch >= ?)
    AND block_index IS NOT NULL AND proof_ok IS NOT NULL
    AND role IN (${BINDABLE.map(() => "?").join(", ")})`;

/**
 * The enrichment-retry predicate, spelled once: it is the WHERE clause of the
 * partial index `validated_response_incomplete`, which SQLite only uses for a
 * query whose own WHERE clause matches it.
 */
const INCOMPLETE = "block_index IS NULL OR proof_ok IS NULL";

/** Surveys with a verdict still awaiting an enrichment retry. */
const INCOMPLETE_VALIDATION_SURVEYS = `
  SELECT DISTINCT survey_key AS surveyKey FROM validated_response
  WHERE ${INCOMPLETE}`;

const SNAPSHOT_META_SELECT = `
  SELECT tip, incomplete, fetched_at AS fetchedAt, list_counts AS listCounts
  FROM snapshot_meta WHERE id = 1`;

/** Stored link slices inside the caller's end-epoch horizon. Binds: (minEndEpoch). */
const SURVEY_GOV_LINKS_SELECT = `
  SELECT survey_key AS surveyKey, gov_links AS govLinks
  FROM survey_index WHERE end_epoch >= ? AND gov_links <> '[]'`;

/** The survey half of a bundle — only the two columns the body carries. */
const SURVEY_BUNDLE_SELECT = `
  SELECT record, cancellations FROM survey_index WHERE survey_key = ?`;

/** Ordered so a bundle body is byte-stable across refreshes. */
const RESPONSES_FOR_SURVEY = `
  SELECT record FROM response WHERE survey_key = ?
  ORDER BY slot, tx_hash, response_index`;

const SCAN_STATE_UPSERT = `
  INSERT INTO scan_state
    (id, cursor_slot, cursor_tx_hash, caught_up, generation, trickle_slot,
     trickle_tx_hash)
  VALUES (1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    cursor_slot = excluded.cursor_slot,
    cursor_tx_hash = excluded.cursor_tx_hash,
    caught_up = excluded.caught_up,
    generation = excluded.generation,
    trickle_slot = excluded.trickle_slot,
    trickle_tx_hash = excluded.trickle_tx_hash`;

const SCAN_STATE_SELECT = `
  SELECT cursor_slot AS cursorSlot, cursor_tx_hash AS cursorTxHash,
         caught_up AS caughtUp, generation,
         trickle_slot AS trickleSlot, trickle_tx_hash AS trickleTxHash
  FROM scan_state WHERE id = 1`;

/** As stored: each cursor is a pair of columns, NULL together. */
interface DbScanStateRow {
  readonly cursorSlot: number | null;
  readonly cursorTxHash: string | null;
  readonly caughtUp: number;
  readonly generation: number;
  readonly trickleSlot: number | null;
  readonly trickleTxHash: string | null;
}

const scanStateFromDb = (r: DbScanStateRow): ScanState => ({
  cursor:
    r.cursorSlot === null || r.cursorTxHash === null
      ? null
      : { slot: r.cursorSlot, txHash: r.cursorTxHash },
  caughtUp: r.caughtUp !== 0,
  generation: r.generation,
  trickle:
    r.trickleSlot === null || r.trickleTxHash === null
      ? null
      : { slot: r.trickleSlot, txHash: r.trickleTxHash },
});

/**
 * The settlement floor, written on its own so an incomplete scan — which must
 * not bank a cursor — can still bank what the governance pass settled. Before
 * the first cursor there is no row, and the update is a no-op: the floor reads
 * 0, which asks about everything.
 */
const SETTLEMENT_FLOOR_UPDATE = `
  UPDATE scan_state SET settlement_floor = ? WHERE id = 1`;

const SETTLEMENT_FLOOR_SELECT = `
  SELECT settlement_floor AS settlementFloor FROM scan_state WHERE id = 1`;

/**
 * The finalization floor, on the same row and by the same rule: written on its
 * own, and 0 before there is a row to write.
 */
const FINALIZATION_FLOOR_UPDATE = `
  UPDATE scan_state SET finalization_floor = ? WHERE id = 1`;

const FINALIZATION_FLOOR_SELECT = `
  SELECT finalization_floor AS finalizationFloor FROM scan_state WHERE id = 1`;

/** The window's stored responses, in scan order. Binds: (fromSlot, toSlot). */
const RESPONSES_IN_SLOT_RANGE = `
  SELECT ${RESPONSE_ROW_COLUMNS} FROM response
  WHERE slot BETWEEN ? AND ?
  ORDER BY slot, tx_hash, response_index`;

/** The window's stored cancellations. Binds: (fromSlot, toSlot). */
const CANCELLATIONS_IN_SLOT_RANGE = `
  SELECT ${CANCELLATION_ROW_COLUMNS} FROM cancellation
  WHERE slot BETWEEN ? AND ?
  ORDER BY slot, tx_hash`;

/**
 * Surveys whose verified-while-open cancellation expired at close (no
 * finalized overlay yet backs it). Binds: (tipEpoch).
 */
const STALE_CANCELLED_SURVEYS = `
  SELECT survey_key AS surveyKey FROM survey_index
  WHERE cancelled = 1 AND finalized_cancelled = 0 AND end_epoch < ?`;

/**
 * The governance pass's input: which end epochs any stored survey has, from
 * the settlement horizon up. Binds: (minEndEpoch).
 */
const SURVEY_END_EPOCHS = `
  SELECT DISTINCT end_epoch AS endEpoch FROM survey_index
  WHERE end_epoch >= ?
  ORDER BY end_epoch`;

/**
 * Finalization's candidate set: closed at the tip, no artifact yet, from its
 * floor up — below which every survey is decided, so neither the rows nor the
 * artifacts down there are worth reading. Binds: (floorEpoch, tipEpoch,
 * floorEpoch).
 */
const UNFINALIZED_CLOSED_SURVEYS = `
  SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index
  WHERE end_epoch >= ? AND end_epoch < ?
    AND survey_key NOT IN (
      SELECT survey_key FROM tally_artifact WHERE end_epoch >= ?)
  ORDER BY survey_key`;

/** Surveys still inside a caller's end-epoch horizon. Binds: (minEndEpoch). */
const SURVEYS_ENDING_AT_OR_AFTER = `
  SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index
  WHERE end_epoch >= ?
  ORDER BY survey_key`;

/** As stored: booleans are 0/1 integers. */
interface DbSurveyRow extends Omit<
  SurveyIndexRow,
  "sealed" | "cancelled" | "govLinked" | "finalizedCancelled"
> {
  readonly sealed: number;
  readonly cancelled: number;
  readonly govLinked: number;
  readonly finalizedCancelled: number;
}

/** A page row additionally carries its computed section bucket. */
interface DbSurveyIndexRow extends DbSurveyRow {
  readonly bucket: number;
}

const surveyRowFromDb = (r: DbSurveyRow): SurveyIndexRow => ({
  ...r,
  sealed: r.sealed !== 0,
  cancelled: r.cancelled !== 0,
  govLinked: r.govLinked !== 0,
  finalizedCancelled: r.finalizedCancelled !== 0,
});

const surveyIndexRowFromDb = (
  r: DbSurveyIndexRow,
): SurveyIndexRow & { bucket: number } => ({
  ...surveyRowFromDb(r),
  bucket: r.bucket,
});

/** Counts come back as SQLite integers already shaped like the counts type. */
const countsFromDb = (r: Record<string, number>): SurveyListCounts => ({
  all: r["all"] ?? 0,
  linked: r["linked"] ?? 0,
  active: r["active"] ?? 0,
  sealed: r["sealed"] ?? 0,
  public: r["public"] ?? 0,
  mine: r["mine"] ?? 0,
});

/**
 * Take the lease for one run: insert it, or steal it iff the incumbent has
 * expired. The `WHERE` makes that an atomic test-and-set — a conflicting row
 * that is still live matches nothing, so the statement affects no rows and
 * `RETURNING` yields none, which is how the loser learns it lost.
 *
 * Binds: (holder, expiresAt, nowSec).
 */
const REFRESH_LEASE_ACQUIRE = `
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
const REFRESH_LEASE_RELEASE =
  "DELETE FROM refresh_lease WHERE id = 1 AND holder = ?";

export function sqlBackendStore(db: SqlDriver): BackendStore {
  /** The first row, or null — every "at most one row" read. */
  const first = async <T>(q: SqlQuery): Promise<T | null> =>
    (await db.all<T>(q))[0] ?? null;

  const write = async (q: SqlQuery): Promise<void> => {
    await db.batchWrite([q]);
  };

  return {
    async completedValidationsForSurveys(
      surveyKeys: readonly string[],
    ): Promise<Map<string, CompletedValidation>> {
      const out = new Map<string, CompletedValidation>();
      if (surveyKeys.length === 0) return out;
      const batches = await db.batchAll<
        { txHash: string; responseIndex: number } & CompletedValidation
      >(completedValidationsSql(surveyKeys));
      for (const rows of batches) {
        for (const r of rows)
          out.set(validationKey(r.txHash, r.responseIndex), {
            linkedActionId: r.linkedActionId,
            slot: r.slot,
            epochNo: r.epochNo,
          });
      }
      return out;
    },
    async validatedLinkCursors(
      minEndEpoch: number,
    ): Promise<ValidatedLinkCursor[]> {
      return db.all<ValidatedLinkCursor>(
        query(VALIDATED_LINK_CURSORS, minEndEpoch, ...BINDABLE),
      );
    },
    async incompleteValidationSurveys(): Promise<string[]> {
      const rows = await db.all<{ surveyKey: string }>(
        query(INCOMPLETE_VALIDATION_SURVEYS),
      );
      return rows.map((r) => r.surveyKey);
    },
    async upsertValidatedResponses(
      rows: readonly ValidatedResponseRow[],
    ): Promise<void> {
      await db.batchWrite(
        rows.map((r) =>
          query(
            `INSERT INTO validated_response
               (tx_hash, response_index, survey_key, role, credential,
                slot, epoch_no, block_index, proof_ok, linked_action_id,
                well_formed, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tx_hash, response_index) DO UPDATE SET
               survey_key = excluded.survey_key,
               role = excluded.role,
               credential = excluded.credential,
               slot = excluded.slot,
               epoch_no = excluded.epoch_no,
               block_index = excluded.block_index,
               proof_ok = excluded.proof_ok,
               linked_action_id = excluded.linked_action_id,
               well_formed = excluded.well_formed,
               checked_at = excluded.checked_at`,
            r.txHash,
            r.responseIndex,
            r.surveyKey,
            r.role,
            r.credential,
            r.slot,
            r.epochNo,
            r.blockIndex,
            nullableBit(r.proofOk),
            r.linkedActionId,
            bit(r.wellFormed),
            r.checkedAt,
          ),
        ),
      );
    },
    async validatedForSurvey(
      surveyKey: string,
    ): Promise<ValidatedResponseRow[]> {
      const rows = await db.all<DbValidatedRow>(
        query(
          `SELECT ${VALIDATED_COLUMNS}
           FROM validated_response WHERE survey_key = ?`,
          surveyKey,
        ),
      );
      return rows.map(validatedFromDb);
    },
    async deleteValidatedResponses(
      keys: readonly { txHash: string; responseIndex: number }[],
    ): Promise<void> {
      await db.batchWrite(
        keys.flatMap((k) => [
          query(
            "DELETE FROM validated_response WHERE tx_hash = ? AND response_index = ?",
            k.txHash,
            k.responseIndex,
          ),
          query(
            "DELETE FROM sealed_reveal WHERE tx_hash = ? AND response_index = ?",
            k.txHash,
            k.responseIndex,
          ),
        ]),
      );
    },
    async sealedReveals(
      surveyKey: string,
    ): Promise<Map<string, string | null>> {
      const rows = await db.all<{
        txHash: string;
        responseIndex: number;
        response: string | null;
      }>(
        query(
          `SELECT s.tx_hash AS txHash, s.response_index AS responseIndex,
                  s.response
           FROM sealed_reveal s
           JOIN validated_response v
             ON v.tx_hash = s.tx_hash AND v.response_index = s.response_index
           WHERE v.survey_key = ?`,
          surveyKey,
        ),
      );
      return new Map(
        rows.map((r) => [validationKey(r.txHash, r.responseIndex), r.response]),
      );
    },
    async putSealedReveals(rows: readonly SealedRevealRow[]): Promise<void> {
      await db.batchWrite(
        rows.map((r) =>
          query(
            `INSERT OR IGNORE INTO sealed_reveal
               (tx_hash, response_index, response)
             VALUES (?, ?, ?)`,
            r.txHash,
            r.responseIndex,
            r.response,
          ),
        ),
      );
    },

    async weightRows(epoch: number, role: number): Promise<WeightRow[]> {
      const rows = await db.all<
        Omit<WeightRow, "registered"> & { registered: number }
      >(
        query(
          `SELECT epoch, role, credential, weight, registered,
                  fetched_at AS fetchedAt
           FROM weight_snapshot WHERE epoch = ? AND role = ?`,
          epoch,
          role,
        ),
      );
      return rows.map((r) => ({ ...r, registered: r.registered !== 0 }));
    },
    async insertWeightRows(rows: readonly WeightRow[]): Promise<void> {
      await db.batchWrite(
        rows.map((r) =>
          query(
            `INSERT OR IGNORE INTO weight_snapshot
               (epoch, role, credential, weight, registered, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            r.epoch,
            r.role,
            r.credential,
            r.weight,
            bit(r.registered),
            r.fetchedAt,
          ),
        ),
      );
    },
    async epochTotal(epoch: number, role: number): Promise<string | null> {
      const row = await first<{ total: string }>(
        query(
          "SELECT total FROM epoch_totals WHERE epoch = ? AND role = ?",
          epoch,
          role,
        ),
      );
      return row?.total ?? null;
    },
    async putEpochTotal(
      epoch: number,
      role: number,
      total: string,
      endpoint: string,
      fetchedAt: number,
    ): Promise<void> {
      await write(
        query(
          `INSERT INTO epoch_totals (epoch, role, total, endpoint, fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(epoch, role) DO UPDATE SET
             total = excluded.total,
             endpoint = excluded.endpoint,
             fetched_at = excluded.fetched_at`,
          epoch,
          role,
          total,
          endpoint,
          fetchedAt,
        ),
      );
    },

    async artifactBySurvey(surveyKey: string): Promise<ArtifactRow | null> {
      return first<ArtifactRow>(
        query(
          `SELECT ${ARTIFACT_COLUMNS} FROM tally_artifact WHERE survey_key = ?`,
          surveyKey,
        ),
      );
    },
    async artifactByHash(artifactHash: string): Promise<ArtifactRow | null> {
      return first<ArtifactRow>(
        query(
          `SELECT ${ARTIFACT_COLUMNS}
           FROM tally_artifact WHERE artifact_hash = ?`,
          artifactHash,
        ),
      );
    },
    async putArtifact(row: ArtifactRow): Promise<void> {
      await write(
        query(
          `INSERT OR IGNORE INTO tally_artifact
             (survey_key, end_epoch, artifact_hash, artifact, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          row.surveyKey,
          row.endEpoch,
          row.artifactHash,
          row.artifact,
          row.createdAt,
        ),
      );
    },
    async artifactKeysFor(
      surveyKeys: readonly string[],
    ): Promise<ArtifactKeys> {
      const keys: ArtifactKeys = { finalized: new Set(), cancelled: new Set() };
      if (surveyKeys.length === 0) return keys;
      const batches = await db.batchAll<{
        surveyKey: string;
        cancelled: number;
      }>(artifactKeysSql(surveyKeys));
      for (const r of batches.flat()) {
        keys.finalized.add(r.surveyKey);
        if (r.cancelled) keys.cancelled.add(r.surveyKey);
      }
      return keys;
    },

    async cachedTxMetadata(
      txHashes: readonly string[],
    ): Promise<Map<string, unknown>> {
      const out = new Map<string, unknown>();
      if (txHashes.length === 0) return out;
      const batches = await db.batchAll<{ txHash: string; metadata: string }>(
        cachedByTxHashSql("tx_metadata_cache", "metadata", txHashes),
      );
      for (const r of batches.flat()) out.set(r.txHash, JSON.parse(r.metadata));
      return out;
    },
    async putTxMetadata(entries: ReadonlyMap<string, unknown>): Promise<void> {
      await db.batchWrite(
        [...entries].map(([hash, metadata]) =>
          query(
            `INSERT OR IGNORE INTO tx_metadata_cache (tx_hash, metadata)
             VALUES (?, ?)`,
            hash,
            JSON.stringify(metadata ?? null),
          ),
        ),
      );
    },

    async cachedTxProofCbor(
      txHashes: readonly string[],
    ): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (txHashes.length === 0) return out;
      const batches = await db.batchAll<{ txHash: string; cbor: string }>(
        cachedByTxHashSql("tx_proof_cache", "cbor", txHashes),
      );
      for (const r of batches.flat()) out.set(r.txHash, r.cbor);
      return out;
    },
    async putTxProofCbor(entries: ReadonlyMap<string, string>): Promise<void> {
      await db.batchWrite(
        [...entries].map(([hash, cbor]) =>
          query(
            "INSERT OR IGNORE INTO tx_proof_cache (tx_hash, cbor) VALUES (?, ?)",
            hash,
            cbor,
          ),
        ),
      );
    },
    async cachedTxProofHashes(): Promise<readonly string[]> {
      const rows = await db.all<{ txHash: string }>(
        query("SELECT tx_hash AS txHash FROM tx_proof_cache"),
      );
      return rows.map((r) => r.txHash);
    },
    async deleteTxProofCbor(txHashes: readonly string[]): Promise<void> {
      await db.batchWrite(
        txHashes.map((hash) =>
          query("DELETE FROM tx_proof_cache WHERE tx_hash = ?", hash),
        ),
      );
    },

    async cachedGovAnchors(
      hashes: readonly string[],
    ): Promise<Map<string, GovLinkDoc | null>> {
      // Full-table read filtered in JS: settlement prunes the bank to the
      // anchors of unsettled epochs, so it stays about the size of the request.
      const wanted = new Set(hashes);
      const rows = await db.all<{ hash: string; link: string }>(
        query("SELECT anchor_hash AS hash, link FROM gov_anchor"),
      );
      const out = new Map<string, GovLinkDoc | null>();
      for (const r of rows) {
        if (wanted.has(r.hash))
          out.set(r.hash, JSON.parse(r.link) as GovLinkDoc | null);
      }
      return out;
    },
    async putGovAnchors(
      entries: ReadonlyMap<string, GovLinkDoc | null>,
    ): Promise<void> {
      await db.batchWrite(
        [...entries].map(([hash, link]) =>
          query(
            "INSERT OR IGNORE INTO gov_anchor (anchor_hash, link) VALUES (?, ?)",
            hash,
            JSON.stringify(link),
          ),
        ),
      );
    },
    async deleteGovAnchors(hashes: readonly string[]): Promise<void> {
      await db.batchWrite(
        hashes.map((hash) =>
          query("DELETE FROM gov_anchor WHERE anchor_hash = ?", hash),
        ),
      );
    },
    async settledGovEpochs(
      expirations: readonly number[],
    ): Promise<Map<number, SettledGovEpoch>> {
      if (expirations.length === 0) return new Map();
      // Read from the lowest expiration asked about: the request is a
      // contiguous-ish horizon, so one bounded read beats chunked `IN (…)`
      // and never touches the settled archive below it.
      const wanted = new Set(expirations);
      const rows = await db.all<DbGovEpochRow>(
        query(
          `SELECT expiration, links, gave_up AS gaveUp, settled_at AS settledAt
           FROM gov_epoch WHERE expiration >= ?`,
          Math.min(...expirations),
        ),
      );
      return new Map(
        rows
          .filter((r) => wanted.has(r.expiration))
          .map((r) => [r.expiration, govEpochFromDb(r)]),
      );
    },
    async putSettledGovEpoch(row: SettledGovEpoch): Promise<void> {
      await write(
        query(
          `INSERT OR IGNORE INTO gov_epoch
             (expiration, links, gave_up, settled_at)
           VALUES (?, ?, ?, ?)`,
          row.expiration,
          JSON.stringify(row.links),
          JSON.stringify(row.gaveUp),
          row.settledAt,
        ),
      );
    },

    async publishSnapshotMeta(meta: SnapshotMeta): Promise<void> {
      await write(snapshotMetaUpsertSql(meta));
    },
    async snapshotMeta(): Promise<SnapshotMeta | null> {
      const row = await first<{
        tip: string;
        incomplete: number;
        fetchedAt: number;
        listCounts: string | null;
      }>(query(SNAPSHOT_META_SELECT));
      if (!row) return null;
      return { ...row, incomplete: row.incomplete !== 0 };
    },
    async surveyGovLinks(minEndEpoch: number): Promise<Map<string, GovLink[]>> {
      const rows = await db.all<{ surveyKey: string; govLinks: string }>(
        query(SURVEY_GOV_LINKS_SELECT, minEndEpoch),
      );
      return new Map(
        rows.map((r) => [r.surveyKey, JSON.parse(r.govLinks) as GovLink[]]),
      );
    },
    async surveyBundle(surveyKey: string): Promise<SurveyBundleRows | null> {
      // Survey and responses are read together: separately, a refresh landing
      // between the two reads would pair one run's survey with the next's
      // responses.
      const [surveys, responses] = await db.batchAll([
        query(SURVEY_BUNDLE_SELECT, surveyKey),
        query(RESPONSES_FOR_SURVEY, surveyKey),
      ]);
      const row = surveys?.[0] as
        | { record: string; cancellations: string }
        | undefined;
      if (!row) return null;
      return {
        ...row,
        responses: ((responses ?? []) as { record: string }[]).map(
          (r) => r.record,
        ),
      };
    },
    async respondedSurveyKeys(
      credentials: readonly string[],
    ): Promise<string[]> {
      if (credentials.length === 0) return [];
      const rows = await db.all<{ surveyKey: string }>(
        respondedSql(credentials),
      );
      return rows.map((r) => r.surveyKey);
    },
    async surveyIndexPage(
      q: SurveyPageQuery,
    ): Promise<(SurveyIndexRow & { bucket: number })[]> {
      const rows = await db.all<DbSurveyIndexRow>(surveyPageSql(q));
      return rows.map(surveyIndexRowFromDb);
    },
    async surveyIndexCounts(
      tipEpoch: number,
      credentials: readonly string[],
      searchTerms: readonly string[],
    ): Promise<SurveyListCounts> {
      const row = await first<Record<string, number>>(
        surveyCountsSql(tipEpoch, credentials, searchTerms),
      );
      return countsFromDb(row ?? {});
    },
    async ownedSurveyCount(credentials: readonly string[]): Promise<number> {
      const row = await first<{ n: number }>(ownedCountSql(credentials));
      return row?.n ?? 0;
    },
    async scanState(): Promise<ScanState | null> {
      const row = await first<DbScanStateRow>(query(SCAN_STATE_SELECT));
      return row === null ? null : scanStateFromDb(row);
    },
    async putScanState(state: ScanState): Promise<void> {
      await write(
        query(
          SCAN_STATE_UPSERT,
          state.cursor?.slot ?? null,
          state.cursor?.txHash ?? null,
          bit(state.caughtUp),
          state.generation,
          state.trickle?.slot ?? null,
          state.trickle?.txHash ?? null,
        ),
      );
    },
    async settlementFloor(): Promise<number> {
      const row = await first<{ settlementFloor: number }>(
        query(SETTLEMENT_FLOOR_SELECT),
      );
      return row?.settlementFloor ?? 0;
    },
    async putSettlementFloor(expiration: number): Promise<void> {
      await write(query(SETTLEMENT_FLOOR_UPDATE, expiration));
    },
    async finalizationFloor(): Promise<number> {
      const row = await first<{ finalizationFloor: number }>(
        query(FINALIZATION_FLOOR_SELECT),
      );
      return row?.finalizationFloor ?? 0;
    },
    async putFinalizationFloor(endEpoch: number): Promise<void> {
      await write(query(FINALIZATION_FLOOR_UPDATE, endEpoch));
    },
    async reconcileSegment(
      range: SlotRange | null,
      surveys: readonly SurveyIndexRow[],
      responses: readonly ResponseRow[],
      cancellations: readonly CancellationRow[],
      banks: readonly ResponseCountBank[],
      meta: SnapshotMeta,
    ): Promise<number> {
      const { program, rowStatements } = segmentReconciliationSql(
        range,
        surveys,
        responses,
        cancellations,
        banks,
        meta,
      );
      const changes = await db.batchWrite(program);
      return changes.slice(0, rowStatements).reduce((n, c) => n + c, 0);
    },
    async surveyRowsByKeys(keys: readonly string[]): Promise<SurveyIndexRow[]> {
      if (keys.length === 0) return [];
      const batches = await db.batchAll<DbSurveyRow>(surveysByKeysSql(keys));
      return batches.flat().map(surveyRowFromDb);
    },
    async responseRowsForSurveys(
      surveyKeys: readonly string[],
    ): Promise<ResponseRow[]> {
      if (surveyKeys.length === 0) return [];
      const batches = await db.batchAll<ResponseRow>(
        responsesBySurveysSql(surveyKeys),
      );
      return batches.flat();
    },
    async responseTxHashesForSurveys(
      surveyKeys: readonly string[],
    ): Promise<string[]> {
      if (surveyKeys.length === 0) return [];
      const batches = await db.batchAll<{ txHash: string }>(
        responseTxHashesSql(surveyKeys),
      );
      return batches.flat().map((r) => r.txHash);
    },
    async responseIdentitiesFrom(
      requests: readonly { surveyKey: string; fromSlot: number }[],
    ): Promise<ResponseIdentity[]> {
      if (requests.length === 0) return [];
      const batches = await db.batchAll<ResponseIdentity>(
        responseIdentitiesSql(requests),
      );
      return batches.flat();
    },
    async settledResponseKeys(
      requests: readonly {
        surveyKey: string;
        belowSlot: number;
        keys: readonly { role: number; credential: string }[];
      }[],
    ): Promise<Map<string, Set<string>>> {
      const out = new Map<string, Set<string>>();
      const asked = requests.filter((r) => r.keys.length > 0);
      if (asked.length === 0) return out;
      const batches = await db.batchAll<{ key: string }>(
        settledResponseKeysSql(asked),
      );
      asked.forEach((request, i) => {
        out.set(
          request.surveyKey,
          new Set(
            (batches[i] ?? []).map((row) => {
              const [role, credential] = JSON.parse(row.key) as [
                number,
                string,
              ];
              return responseIdentityKey(role, credential);
            }),
          ),
        );
      });
      return out;
    },
    async responseCountBanks(
      surveyKeys: readonly string[],
    ): Promise<Map<string, ResponseCountBank>> {
      if (surveyKeys.length === 0) return new Map();
      const batches = await db.batchAll<ResponseCountBank>(
        responseCountBanksSql(surveyKeys),
      );
      return new Map(batches.flat().map((b) => [b.surveyKey, b]));
    },
    async responseRowsInSlotRange(range: SlotRange): Promise<ResponseRow[]> {
      return db.all<ResponseRow>(
        query(RESPONSES_IN_SLOT_RANGE, range.fromSlot, range.toSlot),
      );
    },
    async cancellationRowsForSurveys(
      surveyKeys: readonly string[],
    ): Promise<CancellationRow[]> {
      if (surveyKeys.length === 0) return [];
      const batches = await db.batchAll<CancellationRow>(
        cancellationsBySurveysSql(surveyKeys),
      );
      return batches.flat();
    },
    async cancellationRowsInSlotRange(
      range: SlotRange,
    ): Promise<CancellationRow[]> {
      return db.all<CancellationRow>(
        query(CANCELLATIONS_IN_SLOT_RANGE, range.fromSlot, range.toSlot),
      );
    },
    async staleCancelledSurveyKeys(tipEpoch: number): Promise<string[]> {
      const rows = await db.all<{ surveyKey: string }>(
        query(STALE_CANCELLED_SURVEYS, tipEpoch),
      );
      return rows.map((r) => r.surveyKey);
    },
    async markFinalizedCancelled(
      surveyKeys: readonly string[],
    ): Promise<number> {
      if (surveyKeys.length === 0) return 0;
      const changes = await db.batchWrite(
        markFinalizedCancelledSql(surveyKeys),
      );
      return changes.reduce((n, c) => n + c, 0);
    },
    async surveyEndEpochs(minEndEpoch: number): Promise<number[]> {
      const rows = await db.all<{ endEpoch: number }>(
        query(SURVEY_END_EPOCHS, minEndEpoch),
      );
      return rows.map((r) => r.endEpoch);
    },
    async unfinalizedClosedSurveyRows(
      floorEpoch: number,
      tipEpoch: number,
    ): Promise<SurveyIndexRow[]> {
      const rows = await db.all<DbSurveyRow>(
        query(UNFINALIZED_CLOSED_SURVEYS, floorEpoch, tipEpoch, floorEpoch),
      );
      return rows.map(surveyRowFromDb);
    },
    async surveyRowsEndingAtOrAfter(
      minEndEpoch: number,
    ): Promise<SurveyIndexRow[]> {
      const rows = await db.all<DbSurveyRow>(
        query(SURVEYS_ENDING_AT_OR_AFTER, minEndEpoch),
      );
      return rows.map(surveyRowFromDb);
    },

    async putRefreshRun(row: RefreshRunRow): Promise<void> {
      await db.batchWrite([
        query(
          `INSERT OR REPLACE INTO refresh_run
             (started_at, duration_ms, upstream_requests, koios_calls, ok,
              error, gov_links_ok, incomplete, surveys, responses,
              payload_bytes, validation_backlog)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.startedAt,
          row.durationMs,
          row.upstreamRequests,
          row.koiosCalls,
          bit(row.ok),
          row.error,
          bit(row.govLinksOk),
          bit(row.incomplete),
          row.surveys,
          row.responses,
          row.payloadBytes,
          row.validationBacklog,
        ),
        query(
          "DELETE FROM refresh_run WHERE started_at < ?",
          row.startedAt - OPERATIONAL_RETENTION_SECONDS,
        ),
      ]);
    },
    async lastRefreshRun(): Promise<RefreshRunRow | null> {
      const row = await first<DbRefreshRunRow>(
        query(
          `SELECT ${REFRESH_RUN_COLUMNS} FROM refresh_run
           ORDER BY started_at DESC LIMIT 1`,
        ),
      );
      if (!row) return null;
      return {
        ...row,
        ok: row.ok !== 0,
        govLinksOk: row.govLinksOk !== 0,
        incomplete: row.incomplete !== 0,
      };
    },
    async refreshTotalsSince(sinceUnix: number): Promise<RefreshTotals> {
      const row = await first<RefreshTotals>(
        query(
          `SELECT COUNT(*) AS runs, COALESCE(SUM(ok = 0), 0) AS failures
           FROM refresh_run WHERE started_at >= ?`,
          sinceUnix,
        ),
      );
      return row ?? { runs: 0, failures: 0 };
    },
    async addUpstreamCalls(
      nowSec: number,
      calls: UpstreamCalls,
    ): Promise<void> {
      const bucket = tallyBucket(nowSec);
      await db.batchWrite(
        UPSTREAM_KINDS.filter((kind) => calls[kind]).map((kind) =>
          query(
            `INSERT INTO upstream_tally (bucket, kind, calls) VALUES (?, ?, ?)
             ON CONFLICT (bucket, kind) DO UPDATE
               SET calls = calls + excluded.calls`,
            bucket,
            kind,
            calls[kind],
          ),
        ),
      );
    },
    async upstreamTotalsSince(sinceUnix: number): Promise<UpstreamTotals> {
      return upstreamTotalsFrom(
        await db.all<{ kind: string; calls: number }>(
          query(
            `SELECT kind, SUM(calls) AS calls FROM upstream_tally
             WHERE bucket >= ? GROUP BY kind`,
            tallyBucket(sinceUnix),
          ),
        ),
      );
    },
    async pruneUpstreamTally(beforeUnix: number): Promise<void> {
      await write(
        query(
          "DELETE FROM upstream_tally WHERE bucket < ?",
          tallyBucket(beforeUnix),
        ),
      );
    },
    async incompleteValidationCount(): Promise<number> {
      const row = await first<{ n: number }>(
        query(
          `SELECT COUNT(*) AS n FROM validated_response WHERE ${INCOMPLETE}`,
        ),
      );
      return row?.n ?? 0;
    },

    async acquireRefreshLease(
      nowSec: number,
      ttlSeconds: number,
    ): Promise<string | null> {
      const holder = crypto.randomUUID();
      // An atomic test-and-set: the loser's statement matches no row, so
      // `RETURNING` yields none.
      const rows = await db.all<{ holder: string }>(
        query(REFRESH_LEASE_ACQUIRE, holder, nowSec + ttlSeconds, nowSec),
      );
      return rows.length > 0 ? holder : null;
    },
    async releaseRefreshLease(token: string): Promise<void> {
      await write(query(REFRESH_LEASE_RELEASE, token));
    },

    close() {
      db.close();
    },
  };
}
