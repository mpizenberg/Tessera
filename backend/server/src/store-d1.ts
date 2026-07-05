/**
 * {@link BackendStore} over Cloudflare D1 for the Worker. Same schema as
 * `store-node.ts`, but created by the checked-in `migrations/*.sql` (applied
 * with `wrangler d1 migrations apply`) rather than at open time.
 *
 * D1 is typed structurally here (just the prepare/bind/first/run/all slice we
 * use) instead of pulling in `@cloudflare/workers-types`, whose global
 * declarations clash with `@types/node` in this package's single tsconfig.
 */

import type { SurveyListCounts } from "@tessera/core";

import type {
  ArtifactRow,
  BackendStore,
  CachedSnapshot,
  RefreshRunRow,
  RefreshTotals,
  SurveyIndexMeta,
  SurveyIndexRow,
  SurveyPageQuery,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import { REFRESH_RUN_RETENTION_SECONDS, validationKey } from "./store";
import {
  SURVEY_INDEX_INSERT,
  SURVEY_INDEX_META_UPSERT,
  countsFromDb,
  surveyCountsSql,
  surveyIndexInsertParams,
  surveyIndexRowFromDb,
  surveyPageSql,
  type DbSurveyIndexRow,
} from "./surveyIndexSql";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** The slice of Cloudflare's `D1Database` this store needs. */
export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

interface DbValidatedRow extends Omit<
  ValidatedResponseRow,
  "proofOk" | "wellFormed"
> {
  proofOk: number | null;
  wellFormed: number;
}

const fromDb = (r: DbValidatedRow): ValidatedResponseRow => ({
  ...r,
  proofOk: r.proofOk === null ? null : r.proofOk !== 0,
  wellFormed: r.wellFormed !== 0,
});

export function d1BackendStore(db: D1Like): BackendStore {
  return {
    async get(): Promise<CachedSnapshot | null> {
      const row = await db
        .prepare(
          "SELECT payload, fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1",
        )
        .first<{ payload: string; fetchedAt: number }>();
      if (!row) return null;
      return { payload: JSON.parse(row.payload), fetchedAt: row.fetchedAt };
    },
    async put(snapshot: CachedSnapshot): Promise<void> {
      await db
        .prepare(
          `INSERT INTO snapshot_cache (id, payload, fetched_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             payload = excluded.payload,
             fetched_at = excluded.fetched_at`,
        )
        .bind(JSON.stringify(snapshot.payload), snapshot.fetchedAt)
        .run();
    },
    async snapshotFetchedAt(): Promise<number | null> {
      const row = await db
        .prepare("SELECT fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1")
        .first<{ fetchedAt: number }>();
      return row?.fetchedAt ?? null;
    },

    async completedValidations(): Promise<Map<string, string | null>> {
      const { results } = await db
        .prepare(
          `SELECT tx_hash AS txHash, response_index AS responseIndex,
                  linked_action_id AS linkedActionId
           FROM validated_response
           WHERE block_index IS NOT NULL AND proof_ok IS NOT NULL`,
        )
        .all<{
          txHash: string;
          responseIndex: number;
          linkedActionId: string | null;
        }>();
      return new Map(
        results.map((r) => [
          validationKey(r.txHash, r.responseIndex),
          r.linkedActionId,
        ]),
      );
    },
    async upsertValidatedResponses(
      rows: readonly ValidatedResponseRow[],
    ): Promise<void> {
      if (rows.length === 0) return;
      const stmt = db.prepare(`
        INSERT INTO validated_response
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
          checked_at = excluded.checked_at
      `);
      await db.batch(
        rows.map((r) =>
          stmt.bind(
            r.txHash,
            r.responseIndex,
            r.surveyKey,
            r.role,
            r.credential,
            r.slot,
            r.epochNo,
            r.blockIndex,
            r.proofOk === null ? null : r.proofOk ? 1 : 0,
            r.linkedActionId,
            r.wellFormed ? 1 : 0,
            r.checkedAt,
          ),
        ),
      );
    },
    async validatedForSurvey(
      surveyKey: string,
    ): Promise<ValidatedResponseRow[]> {
      const { results } = await db
        .prepare(
          `SELECT tx_hash AS txHash, response_index AS responseIndex,
                  survey_key AS surveyKey, role, credential, slot,
                  epoch_no AS epochNo, block_index AS blockIndex,
                  proof_ok AS proofOk, linked_action_id AS linkedActionId,
                  well_formed AS wellFormed, checked_at AS checkedAt
           FROM validated_response WHERE survey_key = ?`,
        )
        .bind(surveyKey)
        .all<DbValidatedRow>();
      return results.map(fromDb);
    },
    async deleteValidatedResponses(
      keys: readonly { txHash: string; responseIndex: number }[],
    ): Promise<void> {
      if (keys.length === 0) return;
      const stmt = db.prepare(
        "DELETE FROM validated_response WHERE tx_hash = ? AND response_index = ?",
      );
      await db.batch(keys.map((k) => stmt.bind(k.txHash, k.responseIndex)));
    },

    async weightRows(epoch: number, role: number): Promise<WeightRow[]> {
      const { results } = await db
        .prepare(
          `SELECT epoch, role, credential, weight, registered,
                  fetched_at AS fetchedAt
           FROM weight_snapshot WHERE epoch = ? AND role = ?`,
        )
        .bind(epoch, role)
        .all<Omit<WeightRow, "registered"> & { registered: number }>();
      return results.map((r) => ({ ...r, registered: r.registered !== 0 }));
    },
    async upsertWeightRows(rows: readonly WeightRow[]): Promise<void> {
      if (rows.length === 0) return;
      const stmt = db.prepare(`
        INSERT INTO weight_snapshot
          (epoch, role, credential, weight, registered, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(epoch, role, credential) DO UPDATE SET
          weight = excluded.weight,
          registered = excluded.registered,
          fetched_at = excluded.fetched_at
      `);
      await db.batch(
        rows.map((r) =>
          stmt.bind(
            r.epoch,
            r.role,
            r.credential,
            r.weight,
            r.registered ? 1 : 0,
            r.fetchedAt,
          ),
        ),
      );
    },
    async epochTotal(epoch: number, role: number): Promise<string | null> {
      const row = await db
        .prepare("SELECT total FROM epoch_totals WHERE epoch = ? AND role = ?")
        .bind(epoch, role)
        .first<{ total: string }>();
      return row?.total ?? null;
    },
    async putEpochTotal(
      epoch: number,
      role: number,
      total: string,
      endpoint: string,
      fetchedAt: number,
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO epoch_totals (epoch, role, total, endpoint, fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(epoch, role) DO UPDATE SET
             total = excluded.total,
             endpoint = excluded.endpoint,
             fetched_at = excluded.fetched_at`,
        )
        .bind(epoch, role, total, endpoint, fetchedAt)
        .run();
    },

    async artifactBySurvey(surveyKey: string): Promise<ArtifactRow | null> {
      return db
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM tally_artifact WHERE survey_key = ?`,
        )
        .bind(surveyKey)
        .first<ArtifactRow>();
    },
    async artifactByHash(artifactHash: string): Promise<ArtifactRow | null> {
      return db
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM tally_artifact WHERE artifact_hash = ?`,
        )
        .bind(artifactHash)
        .first<ArtifactRow>();
    },
    async putArtifact(row: ArtifactRow): Promise<void> {
      await db
        .prepare(
          `INSERT OR IGNORE INTO tally_artifact
             (survey_key, end_epoch, artifact_hash, artifact, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          row.surveyKey,
          row.endEpoch,
          row.artifactHash,
          row.artifact,
          row.createdAt,
        )
        .run();
    },
    async finalizedSurveyKeys(): Promise<Set<string>> {
      const { results } = await db
        .prepare("SELECT survey_key AS surveyKey FROM tally_artifact")
        .all<{ surveyKey: string }>();
      return new Set(results.map((r) => r.surveyKey));
    },
    async finalizedCancelledKeys(): Promise<Set<string>> {
      // Same `IS NOT NULL` note as store-node: json_extract yields SQL NULL
      // for both an absent path and a JSON null.
      const { results } = await db
        .prepare(
          `SELECT survey_key AS surveyKey FROM tally_artifact
           WHERE json_extract(artifact, '$.tally.cancelled') IS NOT NULL`,
        )
        .all<{ surveyKey: string }>();
      return new Set(results.map((r) => r.surveyKey));
    },

    async cachedTxMetadata(
      txHashes: readonly string[],
    ): Promise<Map<string, unknown>> {
      // One full-table read filtered in JS — same rationale as store-node: the
      // table is scan-sized, and chunked `IN (…)` reads would cost one D1 query
      // per 100 hashes (D1's bound-parameter cap) against the very request
      // budget this cache exists to protect.
      const wanted = new Set(txHashes);
      const { results } = await db
        .prepare("SELECT tx_hash AS txHash, metadata FROM tx_metadata_cache")
        .all<{ txHash: string; metadata: string }>();
      const out = new Map<string, unknown>();
      for (const r of results) {
        if (wanted.has(r.txHash)) out.set(r.txHash, JSON.parse(r.metadata));
      }
      return out;
    },
    async putTxMetadata(entries: ReadonlyMap<string, unknown>): Promise<void> {
      if (entries.size === 0) return;
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO tx_metadata_cache (tx_hash, metadata) VALUES (?, ?)",
      );
      await db.batch(
        [...entries].map(([hash, metadata]) =>
          stmt.bind(hash, JSON.stringify(metadata ?? null)),
        ),
      );
    },

    async replaceSurveyIndex(
      rows: readonly SurveyIndexRow[],
      meta: SurveyIndexMeta,
    ): Promise<void> {
      // db.batch runs as one transaction, so readers never observe rows from
      // one refresh with the other's meta.
      const insert = db.prepare(SURVEY_INDEX_INSERT);
      await db.batch([
        db.prepare("DELETE FROM survey_index"),
        ...rows.map((r) => insert.bind(...surveyIndexInsertParams(r))),
        db
          .prepare(SURVEY_INDEX_META_UPSERT)
          .bind(meta.tip, meta.incomplete ? 1 : 0, meta.fetchedAt),
      ]);
    },
    async surveyIndexMeta(): Promise<SurveyIndexMeta | null> {
      const row = await db
        .prepare(
          `SELECT tip, incomplete, fetched_at AS fetchedAt
           FROM survey_index_meta WHERE id = 1`,
        )
        .first<{ tip: string; incomplete: number; fetchedAt: number }>();
      if (!row) return null;
      return { ...row, incomplete: row.incomplete !== 0 };
    },
    async surveyIndexPage(
      q: SurveyPageQuery,
    ): Promise<(SurveyIndexRow & { bucket: number })[]> {
      const { sql, params } = surveyPageSql(q);
      const { results } = await db
        .prepare(sql)
        .bind(...params)
        .all<DbSurveyIndexRow>();
      return results.map(surveyIndexRowFromDb);
    },
    async surveyIndexCounts(
      tipEpoch: number,
      credentials: readonly string[],
      searchTerms: readonly string[],
    ): Promise<SurveyListCounts> {
      const { sql, params } = surveyCountsSql(
        tipEpoch,
        credentials,
        searchTerms,
      );
      const row = await db
        .prepare(sql)
        .bind(...params)
        .first<Record<string, number>>();
      return countsFromDb(row ?? {});
    },

    async putRefreshRun(row: RefreshRunRow): Promise<void> {
      await db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO refresh_run
               (started_at, duration_ms, koios_calls, ok, error, incomplete,
                surveys, responses, payload_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.startedAt,
            row.durationMs,
            row.koiosCalls,
            row.ok ? 1 : 0,
            row.error,
            row.incomplete ? 1 : 0,
            row.surveys,
            row.responses,
            row.payloadBytes,
          ),
        db
          .prepare("DELETE FROM refresh_run WHERE started_at < ?")
          .bind(row.startedAt - REFRESH_RUN_RETENTION_SECONDS),
      ]);
    },
    async lastRefreshRun(): Promise<RefreshRunRow | null> {
      const row = await db
        .prepare(
          `SELECT ${REFRESH_RUN_COLUMNS} FROM refresh_run
           ORDER BY started_at DESC LIMIT 1`,
        )
        .first<
          Omit<RefreshRunRow, "ok" | "incomplete"> & {
            ok: number;
            incomplete: number;
          }
        >();
      if (!row) return null;
      return { ...row, ok: row.ok !== 0, incomplete: row.incomplete !== 0 };
    },
    async refreshTotalsSince(sinceUnix: number): Promise<RefreshTotals> {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS runs,
                  COALESCE(SUM(ok = 0), 0) AS failures,
                  COALESCE(SUM(koios_calls), 0) AS koiosCalls
           FROM refresh_run WHERE started_at >= ?`,
        )
        .bind(sinceUnix)
        .first<RefreshTotals>();
      return row ?? { runs: 0, failures: 0, koiosCalls: 0 };
    },
    async incompleteValidationCount(): Promise<number> {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM validated_response
           WHERE block_index IS NULL OR proof_ok IS NULL`,
        )
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    close() {
      // Nothing to release: D1 connections are managed by the runtime.
    },
  };
}

const ARTIFACT_COLUMNS = `survey_key AS surveyKey, end_epoch AS endEpoch,
       artifact_hash AS artifactHash, artifact, created_at AS createdAt`;

const REFRESH_RUN_COLUMNS = `started_at AS startedAt, duration_ms AS durationMs,
       koios_calls AS koiosCalls, ok, error, incomplete, surveys,
       responses, payload_bytes AS payloadBytes`;
