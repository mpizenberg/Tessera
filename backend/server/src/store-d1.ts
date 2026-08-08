/**
 * {@link BackendStore} over Cloudflare D1 for the Worker. Same schema as
 * `store-node.ts`, but created by the checked-in `migrations/*.sql` (applied
 * with `wrangler d1 migrations apply`) rather than at open time.
 *
 * D1 is typed structurally here (just the prepare/bind/first/run/all slice we
 * use) instead of pulling in `@cloudflare/workers-types`, whose global
 * declarations clash with `@types/node` in this package's single tsconfig.
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

/** The per-statement outcome slice we read: rows changed by a write. */
interface D1ResultMeta {
  readonly meta?: { readonly changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1ResultMeta>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** The slice of Cloudflare's `D1Database` this store needs. */
export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  /** One round trip, one transaction; results are positional per statement. */
  batch(
    statements: D1PreparedStatement[],
  ): Promise<({ results: unknown[] } & D1ResultMeta)[]>;
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

interface DbRefreshRunRow extends Omit<
  RefreshRunRow,
  "ok" | "govLinksOk" | "incomplete"
> {
  ok: number;
  govLinksOk: number;
  incomplete: number;
}

/** D1 rejects a statement with more bound parameters than this. */
const D1_PARAM_CAP = 100;

export function d1BackendStore(db: D1Like): BackendStore {
  return {
    async completedValidationsForSurveys(
      surveyKeys: readonly string[],
    ): Promise<Map<string, CompletedValidation>> {
      const out = new Map<string, CompletedValidation>();
      if (surveyKeys.length === 0) return out;
      const batches = await db.batch(
        completedValidationsSql(surveyKeys).map(({ sql, params }) =>
          db.prepare(sql).bind(...params),
        ),
      );
      for (const b of batches) {
        for (const r of b.results as ({
          txHash: string;
          responseIndex: number;
        } & CompletedValidation)[])
          out.set(validationKey(r.txHash, r.responseIndex), {
            linkedActionId: r.linkedActionId,
            slot: r.slot,
            epochNo: r.epochNo,
          });
      }
      return out;
    },
    async validatedLinkCursors(): Promise<ValidatedLinkCursor[]> {
      const { results } = await db
        .prepare(VALIDATED_LINK_CURSORS.sql)
        .bind(...VALIDATED_LINK_CURSORS.params)
        .all<ValidatedLinkCursor>();
      return results;
    },
    async incompleteValidationSurveys(): Promise<string[]> {
      const { results } = await db
        .prepare(INCOMPLETE_VALIDATION_SURVEYS)
        .all<{ surveyKey: string }>();
      return results.map((r) => r.surveyKey);
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
      const validated = db.prepare(
        "DELETE FROM validated_response WHERE tx_hash = ? AND response_index = ?",
      );
      const reveal = db.prepare(
        "DELETE FROM sealed_reveal WHERE tx_hash = ? AND response_index = ?",
      );
      await db.batch(
        keys.flatMap((k) => [
          validated.bind(k.txHash, k.responseIndex),
          reveal.bind(k.txHash, k.responseIndex),
        ]),
      );
    },
    async sealedReveals(
      surveyKey: string,
    ): Promise<Map<string, string | null>> {
      const { results } = await db
        .prepare(
          `SELECT s.tx_hash AS txHash, s.response_index AS responseIndex,
                  s.response
           FROM sealed_reveal s
           JOIN validated_response v
             ON v.tx_hash = s.tx_hash AND v.response_index = s.response_index
           WHERE v.survey_key = ?`,
        )
        .bind(surveyKey)
        .all<{
          txHash: string;
          responseIndex: number;
          response: string | null;
        }>();
      return new Map(
        results.map((r) => [
          validationKey(r.txHash, r.responseIndex),
          r.response,
        ]),
      );
    },
    async putSealedReveals(rows: readonly SealedRevealRow[]): Promise<void> {
      if (rows.length === 0) return;
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO sealed_reveal (tx_hash, response_index, response)
         VALUES (?, ?, ?)`,
      );
      await db.batch(
        rows.map((r) => stmt.bind(r.txHash, r.responseIndex, r.response)),
      );
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
    async insertWeightRows(rows: readonly WeightRow[]): Promise<void> {
      if (rows.length === 0) return;
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO weight_snapshot
          (epoch, role, credential, weight, registered, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
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
    async finalizedArtifactKeys(): Promise<ArtifactKeys> {
      // Same `IS NOT NULL` note as store-node: json_extract yields SQL NULL
      // for both an absent path and a JSON null.
      const { results } = await db
        .prepare(
          `SELECT survey_key AS surveyKey,
                  json_extract(artifact, '$.tally.cancelled') IS NOT NULL
                    AS cancelled
           FROM tally_artifact`,
        )
        .all<{ surveyKey: string; cancelled: number }>();
      return {
        finalized: new Set(results.map((r) => r.surveyKey)),
        cancelled: new Set(
          results.filter((r) => r.cancelled).map((r) => r.surveyKey),
        ),
      };
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

    async cachedTxProofCbor(
      txHashes: readonly string[],
    ): Promise<Map<string, string>> {
      // Chunked `IN (…)` rather than the full-table read its metadata twin
      // does: these rows carry whole transactions, and pruning holds the table
      // at the live working set, so this is one query in practice.
      const out = new Map<string, string>();
      for (let i = 0; i < txHashes.length; i += D1_PARAM_CAP) {
        const chunk = txHashes.slice(i, i + D1_PARAM_CAP);
        const { results } = await db
          .prepare(
            `SELECT tx_hash AS txHash, cbor FROM tx_proof_cache
             WHERE tx_hash IN (${chunk.map(() => "?").join(", ")})`,
          )
          .bind(...chunk)
          .all<{ txHash: string; cbor: string }>();
        for (const r of results) out.set(r.txHash, r.cbor);
      }
      return out;
    },
    async putTxProofCbor(entries: ReadonlyMap<string, string>): Promise<void> {
      if (entries.size === 0) return;
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO tx_proof_cache (tx_hash, cbor) VALUES (?, ?)",
      );
      await db.batch([...entries].map(([hash, cbor]) => stmt.bind(hash, cbor)));
    },
    async cachedTxProofHashes(): Promise<readonly string[]> {
      const { results } = await db
        .prepare("SELECT tx_hash AS txHash FROM tx_proof_cache")
        .all<{ txHash: string }>();
      return results.map((r) => r.txHash);
    },
    async deleteTxProofCbor(txHashes: readonly string[]): Promise<void> {
      if (txHashes.length === 0) return;
      const stmt = db.prepare("DELETE FROM tx_proof_cache WHERE tx_hash = ?");
      await db.batch(txHashes.map((h) => stmt.bind(h)));
    },

    async cachedGovAnchors(
      hashes: readonly string[],
    ): Promise<Map<string, GovLinkDoc | null>> {
      // Full-table read filtered in JS — same rationale as store-node: settlement
      // prunes the bank to the anchors of unsettled epochs, so it stays about the
      // size of the request, and chunked `IN (…)` would cost one D1 query per 100
      // hashes (its bound-parameter cap).
      const wanted = new Set(hashes);
      const { results } = await db
        .prepare("SELECT anchor_hash AS hash, link FROM gov_anchor")
        .all<{ hash: string; link: string }>();
      const out = new Map<string, GovLinkDoc | null>();
      for (const r of results) {
        if (wanted.has(r.hash))
          out.set(r.hash, JSON.parse(r.link) as GovLinkDoc | null);
      }
      return out;
    },
    async putGovAnchors(
      entries: ReadonlyMap<string, GovLinkDoc | null>,
    ): Promise<void> {
      if (entries.size === 0) return;
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO gov_anchor (anchor_hash, link) VALUES (?, ?)",
      );
      await db.batch(
        [...entries].map(([hash, link]) =>
          stmt.bind(hash, JSON.stringify(link)),
        ),
      );
    },
    async deleteGovAnchors(hashes: readonly string[]): Promise<void> {
      if (hashes.length === 0) return;
      const stmt = db.prepare("DELETE FROM gov_anchor WHERE anchor_hash = ?");
      await db.batch(hashes.map((h) => stmt.bind(h)));
    },
    async settledGovEpochs(
      expirations: readonly number[],
    ): Promise<Map<number, SettledGovEpoch>> {
      if (expirations.length === 0) return new Map();
      // Read from the lowest expiration asked about: the request is a
      // contiguous-ish horizon, so one bounded read beats chunked `IN (…)`
      // and never touches the settled archive below it.
      const wanted = new Set(expirations);
      const { results } = await db
        .prepare(
          `SELECT expiration, links, gave_up AS gaveUp, settled_at AS settledAt
           FROM gov_epoch WHERE expiration >= ?`,
        )
        .bind(Math.min(...expirations))
        .all<DbGovEpochRow>();
      return new Map(
        results
          .filter((r) => wanted.has(r.expiration))
          .map((r) => [r.expiration, govEpochFromDb(r)]),
      );
    },
    async putSettledGovEpoch(row: SettledGovEpoch): Promise<void> {
      await db
        .prepare(
          `INSERT OR IGNORE INTO gov_epoch (expiration, links, gave_up, settled_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          row.expiration,
          JSON.stringify(row.links),
          JSON.stringify(row.gaveUp),
          row.settledAt,
        )
        .run();
    },

    async reconcileSnapshot(
      surveys: readonly SurveyIndexRow[],
      responses: readonly ResponseRow[],
      cancellations: readonly CancellationRow[],
      meta: SnapshotMeta,
    ): Promise<void> {
      // One batch is one transaction: row diffs and their freshness envelope
      // become visible together, or the previous generation remains intact.
      await db.batch(
        snapshotReconciliationSql(surveys, responses, cancellations, meta).map(
          ({ sql, params }) => db.prepare(sql).bind(...params),
        ),
      );
    },
    async publishSnapshotMeta(meta: SnapshotMeta): Promise<void> {
      const { sql, params } = snapshotMetaUpsertSql(meta);
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
    async snapshotMeta(): Promise<SnapshotMeta | null> {
      const row = await db.prepare(SNAPSHOT_META_SELECT).first<{
        tip: string;
        incomplete: number;
        fetchedAt: number;
        listCounts: string | null;
      }>();
      if (!row) return null;
      return { ...row, incomplete: row.incomplete !== 0 };
    },
    async surveyGovLinks(minEndEpoch: number): Promise<Map<string, GovLink[]>> {
      const { results } = await db
        .prepare(SURVEY_GOV_LINKS_SELECT)
        .bind(minEndEpoch)
        .all<{ surveyKey: string; govLinks: string }>();
      return new Map(
        results.map((r) => [r.surveyKey, JSON.parse(r.govLinks) as GovLink[]]),
      );
    },
    async surveyBundle(surveyKey: string): Promise<SurveyBundleRows | null> {
      const [survey, responses] = await db.batch([
        db.prepare(SURVEY_BUNDLE_SELECT).bind(surveyKey),
        db.prepare(RESPONSES_FOR_SURVEY).bind(surveyKey),
      ]);
      const row = survey?.results[0] as
        | { record: string; cancellations: string }
        | undefined;
      if (!row) return null;
      return {
        ...row,
        responses: ((responses?.results ?? []) as { record: string }[]).map(
          (r) => r.record,
        ),
      };
    },
    async respondedSurveyKeys(
      credentials: readonly string[],
    ): Promise<string[]> {
      if (credentials.length === 0) return [];
      const { sql, params } = respondedSql(credentials);
      const { results } = await db
        .prepare(sql)
        .bind(...params)
        .all<{ surveyKey: string }>();
      return results.map((r) => r.surveyKey);
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
    async ownedSurveyCount(credentials: readonly string[]): Promise<number> {
      const { sql, params } = ownedCountSql(credentials);
      const row = await db
        .prepare(sql)
        .bind(...params)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async scanState(): Promise<ScanState | null> {
      const row = await db.prepare(SCAN_STATE_SELECT).first<DbScanStateRow>();
      return row === null ? null : scanStateFromDb(row);
    },
    async putScanState(state: ScanState): Promise<void> {
      const { sql, params } = scanStateUpsertSql(state);
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
    async settlementFloor(): Promise<number> {
      const row = await db
        .prepare(SETTLEMENT_FLOOR_SELECT)
        .first<{ settlementFloor: number }>();
      return row?.settlementFloor ?? 0;
    },
    async putSettlementFloor(expiration: number): Promise<void> {
      await db.prepare(SETTLEMENT_FLOOR_UPDATE).bind(expiration).run();
    },
    async reconcileSegment(
      range: SlotRange | null,
      surveys: readonly SurveyIndexRow[],
      responses: readonly ResponseRow[],
      cancellations: readonly CancellationRow[],
      meta: SnapshotMeta,
    ): Promise<number> {
      const outcomes = await db.batch(
        segmentReconciliationSql(
          range,
          surveys,
          responses,
          cancellations,
          meta,
        ).map(({ sql, params }) => db.prepare(sql).bind(...params)),
      );
      // The final statement is the envelope upsert, which changes every run.
      return outcomes
        .slice(0, -1)
        .reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    },
    async surveyRowsByKeys(keys: readonly string[]): Promise<SurveyIndexRow[]> {
      if (keys.length === 0) return [];
      const batches = await db.batch(
        surveysByKeysSql(keys).map(({ sql, params }) =>
          db.prepare(sql).bind(...params),
        ),
      );
      return batches.flatMap((b) =>
        (b.results as DbSurveyRow[]).map(surveyRowFromDb),
      );
    },
    async responseRowsForSurveys(
      surveyKeys: readonly string[],
    ): Promise<ResponseRow[]> {
      if (surveyKeys.length === 0) return [];
      const batches = await db.batch(
        responsesBySurveysSql(surveyKeys).map(({ sql, params }) =>
          db.prepare(sql).bind(...params),
        ),
      );
      return batches.flatMap((b) => b.results as ResponseRow[]);
    },
    async responseRowsInSlotRange(range: SlotRange): Promise<ResponseRow[]> {
      const { results } = await db
        .prepare(RESPONSES_IN_SLOT_RANGE)
        .bind(range.fromSlot, range.toSlot)
        .all<ResponseRow>();
      return results;
    },
    async cancellationRowsForSurveys(
      surveyKeys: readonly string[],
    ): Promise<CancellationRow[]> {
      if (surveyKeys.length === 0) return [];
      const batches = await db.batch(
        cancellationsBySurveysSql(surveyKeys).map(({ sql, params }) =>
          db.prepare(sql).bind(...params),
        ),
      );
      return batches.flatMap((b) => b.results as CancellationRow[]);
    },
    async cancellationRowsInSlotRange(
      range: SlotRange,
    ): Promise<CancellationRow[]> {
      const { results } = await db
        .prepare(CANCELLATIONS_IN_SLOT_RANGE)
        .bind(range.fromSlot, range.toSlot)
        .all<CancellationRow>();
      return results;
    },
    async staleCancelledSurveyKeys(tipEpoch: number): Promise<string[]> {
      const { results } = await db
        .prepare(STALE_CANCELLED_SURVEYS)
        .bind(tipEpoch)
        .all<{ surveyKey: string }>();
      return results.map((r) => r.surveyKey);
    },
    async markFinalizedCancelled(
      surveyKeys: readonly string[],
    ): Promise<number> {
      if (surveyKeys.length === 0) return 0;
      const outcomes = await db.batch(
        markFinalizedCancelledSql(surveyKeys).map(({ sql, params }) =>
          db.prepare(sql).bind(...params),
        ),
      );
      return outcomes.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    },
    async surveyEndEpochs(minEndEpoch: number): Promise<number[]> {
      const { results } = await db
        .prepare(SURVEY_END_EPOCHS)
        .bind(minEndEpoch)
        .all<{ endEpoch: number }>();
      return results.map((r) => r.endEpoch);
    },
    async unfinalizedClosedSurveyRows(
      tipEpoch: number,
    ): Promise<SurveyIndexRow[]> {
      const { results } = await db
        .prepare(UNFINALIZED_CLOSED_SURVEYS)
        .bind(tipEpoch)
        .all<DbSurveyRow>();
      return results.map(surveyRowFromDb);
    },
    async surveyRowsEndingAtOrAfter(
      minEndEpoch: number,
    ): Promise<SurveyIndexRow[]> {
      const { results } = await db
        .prepare(SURVEYS_ENDING_AT_OR_AFTER)
        .bind(minEndEpoch)
        .all<DbSurveyRow>();
      return results.map(surveyRowFromDb);
    },

    async putRefreshRun(row: RefreshRunRow): Promise<void> {
      await db.batch([
        db
          .prepare(
            `INSERT OR REPLACE INTO refresh_run
               (started_at, duration_ms, upstream_requests, koios_calls, ok,
                error, gov_links_ok, incomplete, surveys, responses,
                payload_bytes, validation_backlog)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.startedAt,
            row.durationMs,
            row.upstreamRequests,
            row.koiosCalls,
            row.ok ? 1 : 0,
            row.error,
            row.govLinksOk ? 1 : 0,
            row.incomplete ? 1 : 0,
            row.surveys,
            row.responses,
            row.payloadBytes,
            row.validationBacklog,
          ),
        db
          .prepare("DELETE FROM refresh_run WHERE started_at < ?")
          .bind(row.startedAt - OPERATIONAL_RETENTION_SECONDS),
      ]);
    },
    async lastRefreshRun(): Promise<RefreshRunRow | null> {
      const row = await db
        .prepare(
          `SELECT ${REFRESH_RUN_COLUMNS} FROM refresh_run
           ORDER BY started_at DESC LIMIT 1`,
        )
        .first<DbRefreshRunRow>();
      if (!row) return null;
      return {
        ...row,
        ok: row.ok !== 0,
        govLinksOk: row.govLinksOk !== 0,
        incomplete: row.incomplete !== 0,
      };
    },
    async refreshTotalsSince(sinceUnix: number): Promise<RefreshTotals> {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS runs, COALESCE(SUM(ok = 0), 0) AS failures
           FROM refresh_run WHERE started_at >= ?`,
        )
        .bind(sinceUnix)
        .first<RefreshTotals>();
      return row ?? { runs: 0, failures: 0 };
    },
    async addUpstreamCalls(
      nowSec: number,
      calls: UpstreamCalls,
    ): Promise<void> {
      const bucket = tallyBucket(nowSec);
      const writes = UPSTREAM_KINDS.filter((kind) => calls[kind]).map((kind) =>
        db
          .prepare(
            `INSERT INTO upstream_tally (bucket, kind, calls) VALUES (?, ?, ?)
             ON CONFLICT (bucket, kind) DO UPDATE
               SET calls = calls + excluded.calls`,
          )
          .bind(bucket, kind, calls[kind]),
      );
      if (writes.length > 0) await db.batch(writes);
    },
    async upstreamTotalsSince(sinceUnix: number): Promise<UpstreamTotals> {
      const { results } = await db
        .prepare(
          `SELECT kind, SUM(calls) AS calls FROM upstream_tally
           WHERE bucket >= ? GROUP BY kind`,
        )
        .bind(tallyBucket(sinceUnix))
        .all<{ kind: string; calls: number }>();
      return upstreamTotalsFrom(results);
    },
    async pruneUpstreamTally(beforeUnix: number): Promise<void> {
      await db
        .prepare("DELETE FROM upstream_tally WHERE bucket < ?")
        .bind(tallyBucket(beforeUnix))
        .run();
    },
    async acquireRefreshLease(
      nowSec: number,
      ttlSeconds: number,
    ): Promise<string | null> {
      const holder = crypto.randomUUID();
      const row = await db
        .prepare(REFRESH_LEASE_ACQUIRE)
        .bind(holder, nowSec + ttlSeconds, nowSec)
        .first<{ holder: string }>();
      return row ? holder : null;
    },
    async releaseRefreshLease(token: string): Promise<void> {
      await db.prepare(REFRESH_LEASE_RELEASE).bind(token).run();
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
       upstream_requests AS upstreamRequests, koios_calls AS koiosCalls,
       ok, error, gov_links_ok AS govLinksOk, incomplete, surveys, responses,
       payload_bytes AS payloadBytes, validation_backlog AS validationBacklog`;
