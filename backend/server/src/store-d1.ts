/**
 * {@link BackendStore} over Cloudflare D1 for the Worker. Same schema as
 * `store-node.ts`, but created by the checked-in `migrations/*.sql` (applied
 * with `wrangler d1 migrations apply`) rather than at open time.
 *
 * D1 is typed structurally here (just the prepare/bind/first/run/all slice we
 * use) instead of pulling in `@cloudflare/workers-types`, whose global
 * declarations clash with `@types/node` in this package's single tsconfig.
 */

import type {
  ArtifactRow,
  BackendStore,
  CachedSnapshot,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import { validationKey } from "./store";

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

    close() {
      // Nothing to release: D1 connections are managed by the runtime.
    },
  };
}

const ARTIFACT_COLUMNS = `survey_key AS surveyKey, end_epoch AS endEpoch,
       artifact_hash AS artifactHash, artifact, created_at AS createdAt`;
