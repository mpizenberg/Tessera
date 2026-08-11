/**
 * The one {@link BackendStore} implementation: SQLite-dialect SQL over a
 * {@link SqlDriver}. Node and Cloudflare differ only in the driver they supply
 * (`store-node.ts`, `store-d1.ts`), so the schema, the queries and the
 * latest-wins / insert-or-ignore semantics have a single definition and cannot
 * drift between deployments.
 *
 * The snapshot and survey-index SQL lives in `snapshotSql.ts` because its arity
 * varies with the request; the fixed statements here sit with the method that
 * issues them.
 */

import type { SurveyListCounts } from "cardano-tessera-core";
import type { GovLink, GovLinkDoc } from "cip-179/domain";

import type {
  ArtifactKeys,
  ArtifactRow,
  BackendStore,
  CancellationRow,
  CompletedValidation,
  DbGovEpochRow,
  RefreshRunRow,
  RefreshTotals,
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
  REFRESH_LEASE_ACQUIRE,
  REFRESH_LEASE_RELEASE,
  OPERATIONAL_RETENTION_SECONDS,
  tallyBucket,
  UPSTREAM_KINDS,
  upstreamTotalsFrom,
  validationKey,
} from "./store";
import {
  CANCELLATIONS_IN_SLOT_RANGE,
  FINALIZATION_FLOOR_SELECT,
  FINALIZATION_FLOOR_UPDATE,
  INCOMPLETE_VALIDATION_SURVEYS,
  RESPONSES_FOR_SURVEY,
  RESPONSES_IN_SLOT_RANGE,
  SCAN_STATE_SELECT,
  SETTLEMENT_FLOOR_SELECT,
  SETTLEMENT_FLOOR_UPDATE,
  SNAPSHOT_META_SELECT,
  STALE_CANCELLED_SURVEYS,
  SURVEY_BUNDLE_SELECT,
  SURVEY_END_EPOCHS,
  SURVEY_GOV_LINKS_SELECT,
  SURVEYS_ENDING_AT_OR_AFTER,
  UNFINALIZED_CLOSED_SURVEYS,
  VALIDATED_LINK_CURSORS,
  cancellationsBySurveysSql,
  completedValidationsSql,
  countsFromDb,
  markFinalizedCancelledSql,
  ownedCountSql,
  respondedSql,
  responsesBySurveysSql,
  scanStateFromDb,
  scanStateUpsertSql,
  segmentReconciliationSql,
  snapshotMetaUpsertSql,
  snapshotReconciliationSql,
  surveyCountsSql,
  surveyIndexRowFromDb,
  surveyPageSql,
  surveyRowFromDb,
  surveysByKeysSql,
  type DbScanStateRow,
  type DbSurveyIndexRow,
  type DbSurveyRow,
} from "./snapshotSql";

/** Bound parameters per keyed read — D1 rejects a statement with more. */
const SQL_PARAM_CHUNK = 100;

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
    async validatedLinkCursors(): Promise<ValidatedLinkCursor[]> {
      return db.all<ValidatedLinkCursor>(VALIDATED_LINK_CURSORS);
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
    async finalizedArtifactKeys(): Promise<ArtifactKeys> {
      // `json_extract` returns SQL NULL both when the path is absent and when
      // the value is JSON null, so `IS NOT NULL` is exactly "finalized as
      // cancelled".
      const rows = await db.all<{ surveyKey: string; cancelled: number }>(
        query(
          `SELECT survey_key AS surveyKey,
                  json_extract(artifact, '$.tally.cancelled') IS NOT NULL
                    AS cancelled
           FROM tally_artifact`,
        ),
      );
      return {
        finalized: new Set(rows.map((r) => r.surveyKey)),
        cancelled: new Set(
          rows.filter((r) => r.cancelled).map((r) => r.surveyKey),
        ),
      };
    },

    async cachedTxMetadata(
      txHashes: readonly string[],
    ): Promise<Map<string, unknown>> {
      // One full-table read filtered in JS: the table is the same order of
      // magnitude as the scan itself, and chunked `IN (…)` reads would cost one
      // query per SQL_PARAM_CHUNK hashes against the very request budget this
      // cache exists to protect.
      const wanted = new Set(txHashes);
      const rows = await db.all<{ txHash: string; metadata: string }>(
        query("SELECT tx_hash AS txHash, metadata FROM tx_metadata_cache"),
      );
      const out = new Map<string, unknown>();
      for (const r of rows) {
        if (wanted.has(r.txHash)) out.set(r.txHash, JSON.parse(r.metadata));
      }
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
      // Keyed reads rather than the full-table read its metadata twin does:
      // these rows carry whole transactions, and pruning holds the table at the
      // live working set, so this is one query in practice.
      const out = new Map<string, string>();
      for (let i = 0; i < txHashes.length; i += SQL_PARAM_CHUNK) {
        const chunk = txHashes.slice(i, i + SQL_PARAM_CHUNK);
        const rows = await db.all<{ txHash: string; cbor: string }>(
          query(
            `SELECT tx_hash AS txHash, cbor FROM tx_proof_cache
             WHERE tx_hash IN (${chunk.map(() => "?").join(", ")})`,
            ...chunk,
          ),
        );
        for (const r of rows) out.set(r.txHash, r.cbor);
      }
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
      // Full-table read filtered in JS, like the metadata cache: settlement
      // prunes the bank to the anchors of unsettled epochs, so it stays about
      // the size of the request.
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

    async reconcileSnapshot(
      surveys: readonly SurveyIndexRow[],
      responses: readonly ResponseRow[],
      cancellations: readonly CancellationRow[],
      meta: SnapshotMeta,
    ): Promise<void> {
      // One transaction: row diffs and their freshness envelope become visible
      // together, or the previous generation remains intact.
      await db.batchWrite(
        snapshotReconciliationSql(surveys, responses, cancellations, meta),
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
      await write(scanStateUpsertSql(state));
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
      meta: SnapshotMeta,
    ): Promise<number> {
      const changes = await db.batchWrite(
        segmentReconciliationSql(
          range,
          surveys,
          responses,
          cancellations,
          meta,
        ),
      );
      // The final statement is the envelope upsert, which changes every run.
      return changes.slice(0, -1).reduce((n, c) => n + c, 0);
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
          `SELECT COUNT(*) AS n FROM validated_response
           WHERE block_index IS NULL OR proof_ok IS NULL`,
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
