/**
 * {@link BackendStore} over `node:sqlite` for the local Node process — both
 * dev and self-hosting without Cloudflare. Kept in its own module so the
 * Cloudflare Worker bundle (which uses `store-d1.ts`) never imports
 * `node:sqlite` — Workers' nodejs_compat does not provide it.
 *
 * The schema is NOT defined here: both backends share the `migrations/*.sql`
 * files as the single source of truth. D1 applies them via `wrangler d1
 * migrations apply`; this store applies them itself at open, tracking applied
 * files in a `schema_migration` table (the node twin of wrangler's
 * `d1_migrations`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

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
import {
  REFRESH_LEASE_ACQUIRE,
  REFRESH_LEASE_RELEASE,
  REFRESH_RUN_RETENTION_SECONDS,
  validationKey,
} from "./store";
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

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** What node:sqlite accepts as a bound parameter (its SupportedValueType). */
type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Databases created before the migration runner existed were built from an
 * inline schema (deleted when the runner landed) with no record of what had
 * been applied. When `schema_migration` is empty, infer that record by
 * probing for each early migration's objects, so the runner doesn't re-run
 * CREATE TABLEs against tables that already exist — while a genuinely missing
 * piece (e.g. 0004's column, which the inline schema never ALTERed into old
 * files) stays unmarked and gets applied. Frozen list: migrations after the
 * runner are recorded when applied and must never be added here.
 */
const LEGACY_PROBES: readonly (readonly [migration: string, probe: string])[] =
  [
    [
      "0001_snapshot_cache.sql",
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_cache'",
    ],
    [
      "0002_validated_responses.sql",
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'validated_response'",
    ],
    [
      "0003_tally.sql",
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tally_artifact'",
    ],
    [
      "0004_validated_response_linked_action.sql",
      "SELECT 1 FROM pragma_table_info('validated_response') WHERE name = 'linked_action_id'",
    ],
    [
      "0005_tx_metadata_cache.sql",
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tx_metadata_cache'",
    ],
  ];

/**
 * Bring `db` to the latest schema: apply the `migrations/*.sql` files (in
 * name order, each in its own transaction) that `schema_migration` doesn't
 * list yet — the node:sqlite equivalent of `wrangler d1 migrations apply`.
 */
function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    (
      db.prepare("SELECT name FROM schema_migration").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const record = db.prepare(
    "INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)",
  );
  if (applied.size === 0) {
    for (const [migration, probe] of LEGACY_PROBES) {
      if (db.prepare(probe).get() !== undefined) {
        record.run(migration, Date.now());
        applied.add(migration);
      }
    }
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      record.run(file, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openBackendStore(path: string): BackendStore {
  const db = new DatabaseSync(path);
  applyMigrations(db);

  const selectStmt = db.prepare(
    "SELECT payload, fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO snapshot_cache (id, payload, fetched_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at
  `);
  const fetchedAtStmt = db.prepare(
    "SELECT fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1",
  );

  const completedStmt = db.prepare(
    `SELECT tx_hash AS txHash, response_index AS responseIndex,
            linked_action_id AS linkedActionId
     FROM validated_response
     WHERE block_index IS NOT NULL AND proof_ok IS NOT NULL`,
  );
  const upsertValidatedStmt = db.prepare(`
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
  const forSurveyStmt = db.prepare(
    `SELECT tx_hash AS txHash, response_index AS responseIndex,
            survey_key AS surveyKey, role, credential, slot,
            epoch_no AS epochNo, block_index AS blockIndex,
            proof_ok AS proofOk, linked_action_id AS linkedActionId,
            well_formed AS wellFormed, checked_at AS checkedAt
     FROM validated_response WHERE survey_key = ?`,
  );
  const deleteValidatedStmt = db.prepare(
    "DELETE FROM validated_response WHERE tx_hash = ? AND response_index = ?",
  );

  const weightRowsStmt = db.prepare(
    `SELECT epoch, role, credential, weight, registered,
            fetched_at AS fetchedAt
     FROM weight_snapshot WHERE epoch = ? AND role = ?`,
  );
  const insertWeightStmt = db.prepare(`
    INSERT OR IGNORE INTO weight_snapshot
      (epoch, role, credential, weight, registered, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const epochTotalStmt = db.prepare(
    "SELECT total FROM epoch_totals WHERE epoch = ? AND role = ?",
  );
  const putEpochTotalStmt = db.prepare(`
    INSERT INTO epoch_totals (epoch, role, total, endpoint, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(epoch, role) DO UPDATE SET
      total = excluded.total,
      endpoint = excluded.endpoint,
      fetched_at = excluded.fetched_at
  `);
  const artifactColumns = `survey_key AS surveyKey, end_epoch AS endEpoch,
            artifact_hash AS artifactHash, artifact, created_at AS createdAt`;
  const artifactBySurveyStmt = db.prepare(
    `SELECT ${artifactColumns} FROM tally_artifact WHERE survey_key = ?`,
  );
  const artifactByHashStmt = db.prepare(
    `SELECT ${artifactColumns} FROM tally_artifact WHERE artifact_hash = ?`,
  );
  const putArtifactStmt = db.prepare(`
    INSERT OR IGNORE INTO tally_artifact
      (survey_key, end_epoch, artifact_hash, artifact, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const finalizedStmt = db.prepare(
    "SELECT survey_key AS surveyKey FROM tally_artifact",
  );
  // `json_extract` returns SQL NULL both when the path is absent and when the
  // value is JSON null, so `IS NOT NULL` is exactly "finalized as cancelled".
  const finalizedCancelledStmt = db.prepare(
    `SELECT survey_key AS surveyKey FROM tally_artifact
     WHERE json_extract(artifact, '$.tally.cancelled') IS NOT NULL`,
  );
  const txMetaAllStmt = db.prepare(
    "SELECT tx_hash AS txHash, metadata FROM tx_metadata_cache",
  );
  const putTxMetaStmt = db.prepare(
    "INSERT OR IGNORE INTO tx_metadata_cache (tx_hash, metadata) VALUES (?, ?)",
  );

  const refreshRunColumns = `started_at AS startedAt, duration_ms AS durationMs,
            koios_calls AS koiosCalls, ok, error, incomplete, surveys,
            responses, payload_bytes AS payloadBytes`;
  const putRefreshRunStmt = db.prepare(`
    INSERT OR REPLACE INTO refresh_run
      (started_at, duration_ms, koios_calls, ok, error, incomplete,
       surveys, responses, payload_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pruneRefreshRunStmt = db.prepare(
    "DELETE FROM refresh_run WHERE started_at < ?",
  );
  const lastRefreshRunStmt = db.prepare(
    `SELECT ${refreshRunColumns} FROM refresh_run
     ORDER BY started_at DESC LIMIT 1`,
  );
  const refreshTotalsStmt = db.prepare(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(ok = 0), 0) AS failures,
            COALESCE(SUM(koios_calls), 0) AS koiosCalls
     FROM refresh_run WHERE started_at >= ?`,
  );
  const incompleteValidationStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM validated_response
     WHERE block_index IS NULL OR proof_ok IS NULL`,
  );

  const acquireLeaseStmt = db.prepare(REFRESH_LEASE_ACQUIRE);
  const releaseLeaseStmt = db.prepare(REFRESH_LEASE_RELEASE);

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

  return {
    async get(): Promise<CachedSnapshot | null> {
      const row = selectStmt.get() as
        | { payload: string; fetchedAt: number }
        | undefined;
      if (!row) return null;
      return { payload: JSON.parse(row.payload), fetchedAt: row.fetchedAt };
    },
    async put(snapshot: CachedSnapshot): Promise<void> {
      upsertStmt.run(JSON.stringify(snapshot.payload), snapshot.fetchedAt);
    },
    async snapshotFetchedAt(): Promise<number | null> {
      const row = fetchedAtStmt.get() as { fetchedAt: number } | undefined;
      return row?.fetchedAt ?? null;
    },

    async completedValidations(): Promise<Map<string, string | null>> {
      const rows = completedStmt.all() as {
        txHash: string;
        responseIndex: number;
        linkedActionId: string | null;
      }[];
      return new Map(
        rows.map((r) => [
          validationKey(r.txHash, r.responseIndex),
          r.linkedActionId,
        ]),
      );
    },
    async upsertValidatedResponses(
      rows: readonly ValidatedResponseRow[],
    ): Promise<void> {
      for (const r of rows) {
        upsertValidatedStmt.run(
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
        );
      }
    },
    async validatedForSurvey(
      surveyKey: string,
    ): Promise<ValidatedResponseRow[]> {
      return (forSurveyStmt.all(surveyKey) as unknown as DbValidatedRow[]).map(
        fromDb,
      );
    },
    async deleteValidatedResponses(
      keys: readonly { txHash: string; responseIndex: number }[],
    ): Promise<void> {
      for (const k of keys) deleteValidatedStmt.run(k.txHash, k.responseIndex);
    },

    async weightRows(epoch: number, role: number): Promise<WeightRow[]> {
      const rows = weightRowsStmt.all(epoch, role) as unknown as (Omit<
        WeightRow,
        "registered"
      > & { registered: number })[];
      return rows.map((r) => ({ ...r, registered: r.registered !== 0 }));
    },
    async insertWeightRows(rows: readonly WeightRow[]): Promise<void> {
      for (const r of rows) {
        insertWeightStmt.run(
          r.epoch,
          r.role,
          r.credential,
          r.weight,
          r.registered ? 1 : 0,
          r.fetchedAt,
        );
      }
    },
    async epochTotal(epoch: number, role: number): Promise<string | null> {
      const row = epochTotalStmt.get(epoch, role) as
        | { total: string }
        | undefined;
      return row?.total ?? null;
    },
    async putEpochTotal(
      epoch: number,
      role: number,
      total: string,
      endpoint: string,
      fetchedAt: number,
    ): Promise<void> {
      putEpochTotalStmt.run(epoch, role, total, endpoint, fetchedAt);
    },

    async artifactBySurvey(surveyKey: string): Promise<ArtifactRow | null> {
      return (
        (artifactBySurveyStmt.get(surveyKey) as ArtifactRow | undefined) ?? null
      );
    },
    async artifactByHash(artifactHash: string): Promise<ArtifactRow | null> {
      return (
        (artifactByHashStmt.get(artifactHash) as ArtifactRow | undefined) ??
        null
      );
    },
    async putArtifact(row: ArtifactRow): Promise<void> {
      putArtifactStmt.run(
        row.surveyKey,
        row.endEpoch,
        row.artifactHash,
        row.artifact,
        row.createdAt,
      );
    },
    async finalizedSurveyKeys(): Promise<Set<string>> {
      const rows = finalizedStmt.all() as { surveyKey: string }[];
      return new Set(rows.map((r) => r.surveyKey));
    },
    async finalizedCancelledKeys(): Promise<Set<string>> {
      const rows = finalizedCancelledStmt.all() as { surveyKey: string }[];
      return new Set(rows.map((r) => r.surveyKey));
    },

    async cachedTxMetadata(
      txHashes: readonly string[],
    ): Promise<Map<string, unknown>> {
      // One full-table read filtered in JS: the table is the same order of
      // magnitude as the scan itself, and one query beats chunked `IN (…)`
      // reads (which D1 would cap at 100 bound parameters each).
      const wanted = new Set(txHashes);
      const out = new Map<string, unknown>();
      const rows = txMetaAllStmt.all() as {
        txHash: string;
        metadata: string;
      }[];
      for (const row of rows) {
        if (wanted.has(row.txHash))
          out.set(row.txHash, JSON.parse(row.metadata));
      }
      return out;
    },
    async putTxMetadata(entries: ReadonlyMap<string, unknown>): Promise<void> {
      for (const [hash, metadata] of entries)
        putTxMetaStmt.run(hash, JSON.stringify(metadata ?? null));
    },

    async replaceSurveyIndex(
      rows: readonly SurveyIndexRow[],
      meta: SurveyIndexMeta,
    ): Promise<void> {
      // Full replace in one transaction: the set is scan-sized, and readers
      // must never observe rows from one refresh with the other's meta.
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM survey_index");
        const insert = db.prepare(SURVEY_INDEX_INSERT);
        for (const r of rows)
          insert.run(...(surveyIndexInsertParams(r) as SqlValue[]));
        db.prepare(SURVEY_INDEX_META_UPSERT).run(
          meta.tip,
          meta.incomplete ? 1 : 0,
          meta.fetchedAt,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async surveyIndexMeta(): Promise<SurveyIndexMeta | null> {
      const row = db
        .prepare(
          `SELECT tip, incomplete, fetched_at AS fetchedAt
           FROM survey_index_meta WHERE id = 1`,
        )
        .get() as
        | { tip: string; incomplete: number; fetchedAt: number }
        | undefined;
      if (!row) return null;
      return { ...row, incomplete: row.incomplete !== 0 };
    },
    async surveyIndexPage(
      q: SurveyPageQuery,
    ): Promise<(SurveyIndexRow & { bucket: number })[]> {
      const { sql, params } = surveyPageSql(q);
      return (
        db
          .prepare(sql)
          .all(...(params as SqlValue[])) as unknown as DbSurveyIndexRow[]
      ).map(surveyIndexRowFromDb);
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
      return countsFromDb(
        db.prepare(sql).get(...(params as SqlValue[])) as Record<
          string,
          number
        >,
      );
    },

    async putRefreshRun(row: RefreshRunRow): Promise<void> {
      putRefreshRunStmt.run(
        row.startedAt,
        row.durationMs,
        row.koiosCalls,
        row.ok ? 1 : 0,
        row.error,
        row.incomplete ? 1 : 0,
        row.surveys,
        row.responses,
        row.payloadBytes,
      );
      pruneRefreshRunStmt.run(row.startedAt - REFRESH_RUN_RETENTION_SECONDS);
    },
    async lastRefreshRun(): Promise<RefreshRunRow | null> {
      const row = lastRefreshRunStmt.get() as
        | (Omit<RefreshRunRow, "ok" | "incomplete"> & {
            ok: number;
            incomplete: number;
          })
        | undefined;
      if (!row) return null;
      return { ...row, ok: row.ok !== 0, incomplete: row.incomplete !== 0 };
    },
    async refreshTotalsSince(sinceUnix: number): Promise<RefreshTotals> {
      return refreshTotalsStmt.get(sinceUnix) as unknown as RefreshTotals;
    },
    async incompleteValidationCount(): Promise<number> {
      return (incompleteValidationStmt.get() as { n: number }).n;
    },

    async acquireRefreshLease(
      nowSec: number,
      ttlSeconds: number,
    ): Promise<string | null> {
      const holder = crypto.randomUUID();
      const row = acquireLeaseStmt.get(holder, nowSec + ttlSeconds, nowSec);
      return row === undefined ? null : holder;
    },
    async releaseRefreshLease(token: string): Promise<void> {
      releaseLeaseStmt.run(token);
    },

    close() {
      db.close();
    },
  };
}
