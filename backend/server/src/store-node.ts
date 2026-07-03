/**
 * {@link BackendStore} over `node:sqlite` for the local Node process. Kept in
 * its own module so the Cloudflare Worker bundle (which uses `store-d1.ts`)
 * never imports `node:sqlite` — Workers' nodejs_compat does not provide it.
 * Creates the schema itself; the D1 twin gets it from `migrations/` instead
 * (keep both in sync).
 */

import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRow,
  BackendStore,
  CachedSnapshot,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import { validationKey } from "./store";

export function openBackendStore(path: string): BackendStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_cache (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      payload    TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS validated_response (
      tx_hash        TEXT    NOT NULL,
      response_index INTEGER NOT NULL,
      survey_key     TEXT    NOT NULL,
      role           INTEGER NOT NULL,
      credential     TEXT    NOT NULL,
      slot           INTEGER NOT NULL,
      epoch_no       INTEGER NOT NULL,
      block_index    INTEGER,
      proof_ok       INTEGER,
      well_formed    INTEGER NOT NULL,
      checked_at     INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, response_index)
    );
    CREATE INDEX IF NOT EXISTS validated_response_survey
      ON validated_response (survey_key);
    CREATE TABLE IF NOT EXISTS weight_snapshot (
      epoch      INTEGER NOT NULL,
      role       INTEGER NOT NULL,
      credential TEXT    NOT NULL,
      weight     TEXT    NOT NULL,
      registered INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (epoch, role, credential)
    );
    CREATE TABLE IF NOT EXISTS epoch_totals (
      epoch      INTEGER NOT NULL,
      role       INTEGER NOT NULL,
      total      TEXT    NOT NULL,
      endpoint   TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (epoch, role)
    );
    CREATE TABLE IF NOT EXISTS tally_artifact (
      survey_key    TEXT PRIMARY KEY,
      end_epoch     INTEGER NOT NULL,
      artifact_hash TEXT    NOT NULL,
      artifact      TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tally_artifact_hash
      ON tally_artifact (artifact_hash);
  `);

  const selectStmt = db.prepare(
    "SELECT payload, fetched_at AS fetchedAt FROM snapshot_cache WHERE id = 1",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO snapshot_cache (id, payload, fetched_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at
  `);

  const completedStmt = db.prepare(
    `SELECT tx_hash AS txHash, response_index AS responseIndex
     FROM validated_response
     WHERE block_index IS NOT NULL AND proof_ok IS NOT NULL`,
  );
  const upsertValidatedStmt = db.prepare(`
    INSERT INTO validated_response
      (tx_hash, response_index, survey_key, role, credential,
       slot, epoch_no, block_index, proof_ok, well_formed, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tx_hash, response_index) DO UPDATE SET
      survey_key = excluded.survey_key,
      role = excluded.role,
      credential = excluded.credential,
      slot = excluded.slot,
      epoch_no = excluded.epoch_no,
      block_index = excluded.block_index,
      proof_ok = excluded.proof_ok,
      well_formed = excluded.well_formed,
      checked_at = excluded.checked_at
  `);
  const forSurveyStmt = db.prepare(
    `SELECT tx_hash AS txHash, response_index AS responseIndex,
            survey_key AS surveyKey, role, credential, slot,
            epoch_no AS epochNo, block_index AS blockIndex,
            proof_ok AS proofOk, well_formed AS wellFormed,
            checked_at AS checkedAt
     FROM validated_response WHERE survey_key = ?`,
  );

  const weightRowsStmt = db.prepare(
    `SELECT epoch, role, credential, weight, registered,
            fetched_at AS fetchedAt
     FROM weight_snapshot WHERE epoch = ? AND role = ?`,
  );
  const upsertWeightStmt = db.prepare(`
    INSERT INTO weight_snapshot
      (epoch, role, credential, weight, registered, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(epoch, role, credential) DO UPDATE SET
      weight = excluded.weight,
      registered = excluded.registered,
      fetched_at = excluded.fetched_at
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

    async completedValidationKeys(): Promise<Set<string>> {
      const rows = completedStmt.all() as {
        txHash: string;
        responseIndex: number;
      }[];
      return new Set(rows.map((r) => validationKey(r.txHash, r.responseIndex)));
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

    async weightRows(epoch: number, role: number): Promise<WeightRow[]> {
      const rows = weightRowsStmt.all(epoch, role) as unknown as (Omit<
        WeightRow,
        "registered"
      > & { registered: number })[];
      return rows.map((r) => ({ ...r, registered: r.registered !== 0 }));
    },
    async upsertWeightRows(rows: readonly WeightRow[]): Promise<void> {
      for (const r of rows) {
        upsertWeightStmt.run(
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

    close() {
      db.close();
    },
  };
}
