/**
 * SQL over the materialized snapshot tables, shared verbatim by `store-node.ts`
 * and `store-d1.ts` (same SQLite dialect on both). The `survey_index`
 * page/count semantics mirror `cardano-tessera-core`'s `pageSurveyList` — the
 * executable spec — exactly: bucket 0 gov-linked / 1 open / 2 closed, ordered
 * (bucket ASC, slot DESC, key ASC), AND-of-substrings search, chip counts over
 * the search-matching set.
 *
 * Queries whose arity varies (search terms, credential lists) are built per
 * call, so nothing here is a cached prepared statement — the tables are
 * scan-sized and these run once per request.
 */

import type { SurveyListCounts } from "cardano-tessera-core";
import { BINDABLE_ROLES } from "cip-179/domain";

import type {
  CancellationRow,
  ResponseRow,
  ScanState,
  SlotRange,
  SnapshotMeta,
  SurveyIndexRow,
  SurveyPageQuery,
} from "./store";

export interface SqlQuery {
  readonly sql: string;
  readonly params: unknown[];
}

/** The section bucket, computed against the snapshot tip's epoch (1 param). */
const BUCKET = `CASE WHEN gov_linked = 1 THEN 0
                     WHEN cancelled = 1 OR end_epoch < ? THEN 2
                     ELSE 1 END`;

/** "Open" (active) predicate: not cancelled, deadline not passed (1 param). */
const ACTIVE = `(cancelled = 0 AND end_epoch >= ?)`;

const likeEscape = (term: string): string =>
  term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** One `haystack LIKE` clause per AND term. */
function searchSql(terms: readonly string[]): SqlQuery {
  if (terms.length === 0) return { sql: "1", params: [] };
  return {
    sql: terms.map(() => `haystack LIKE ? ESCAPE '\\'`).join(" AND "),
    params: terms.map((t) => `%${likeEscape(t)}%`),
  };
}

/** `owner IN (…)` over the caller's credentials; FALSE when none given. */
function mineSql(credentials: readonly string[]): SqlQuery {
  if (credentials.length === 0) return { sql: "0", params: [] };
  return {
    sql: `owner IN (${credentials.map(() => "?").join(", ")})`,
    params: [...credentials],
  };
}

function filterSql(q: SurveyPageQuery): SqlQuery {
  switch (q.filter) {
    case "all":
      return { sql: "1", params: [] };
    case "linked":
      return { sql: "gov_linked = 1", params: [] };
    case "active":
      return { sql: ACTIVE, params: [q.tipEpoch] };
    case "sealed":
      return { sql: `(sealed = 1 AND ${ACTIVE})`, params: [q.tipEpoch] };
    case "public":
      return { sql: `(sealed = 0 AND ${ACTIVE})`, params: [q.tipEpoch] };
    case "mine":
      return mineSql(q.credentials);
  }
}

export function surveyPageSql(q: SurveyPageQuery): SqlQuery {
  const search = searchSql(q.searchTerms);
  const filter = filterSql(q);
  const cursor = q.cursor
    ? {
        sql: `(bucket > ? OR (bucket = ? AND (slot < ? OR (slot = ? AND survey_key > ?))))`,
        params: [
          q.cursor.bucket,
          q.cursor.bucket,
          q.cursor.slot,
          q.cursor.slot,
          q.cursor.key,
        ],
      }
    : { sql: "1", params: [] };
  return {
    sql: `
      WITH rows AS (
        SELECT survey_key, slot, end_epoch, sealed, cancelled, gov_linked,
               owner, haystack, record, cancellations, gov_links,
               response_count, finalized_cancelled,
               ${BUCKET} AS bucket
        FROM survey_index
        WHERE ${search.sql} AND ${filter.sql}
      )
      SELECT survey_key AS surveyKey, slot, end_epoch AS endEpoch, sealed,
             cancelled, gov_linked AS govLinked, owner, haystack, record,
             cancellations, gov_links AS govLinks,
             response_count AS responseCount,
             finalized_cancelled AS finalizedCancelled, bucket
      FROM rows
      WHERE ${cursor.sql}
      ORDER BY bucket, slot DESC, survey_key
      LIMIT ?`,
    params: [
      q.tipEpoch,
      ...search.params,
      ...filter.params,
      ...cursor.params,
      q.limit,
    ],
  };
}

/** The `mine` chip alone — the one count the banked envelope can't carry. */
export const ownedCountSql = (credentials: readonly string[]): SqlQuery => {
  const mine = mineSql(credentials);
  return {
    sql: `SELECT COUNT(*) AS n FROM survey_index WHERE ${mine.sql}`,
    params: mine.params,
  };
};

export function surveyCountsSql(
  tipEpoch: number,
  credentials: readonly string[],
  searchTerms: readonly string[],
): SqlQuery {
  const search = searchSql(searchTerms);
  const mine = mineSql(credentials);
  return {
    sql: `
      SELECT COUNT(*) AS "all",
             COALESCE(SUM(gov_linked), 0) AS linked,
             COALESCE(SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END), 0) AS active,
             COALESCE(SUM(CASE WHEN sealed = 1 AND ${ACTIVE} THEN 1 ELSE 0 END), 0) AS sealed,
             COALESCE(SUM(CASE WHEN sealed = 0 AND ${ACTIVE} THEN 1 ELSE 0 END), 0) AS "public",
             COALESCE(SUM(CASE WHEN ${mine.sql} THEN 1 ELSE 0 END), 0) AS mine
      FROM survey_index
      WHERE ${search.sql}`,
    params: [tipEpoch, tipEpoch, tipEpoch, ...mine.params, ...search.params],
  };
}

/** As stored: booleans are 0/1 integers. */
export interface DbSurveyRow extends Omit<
  SurveyIndexRow,
  "sealed" | "cancelled" | "govLinked" | "finalizedCancelled"
> {
  readonly sealed: number;
  readonly cancelled: number;
  readonly govLinked: number;
  readonly finalizedCancelled: number;
}

/** A page row additionally carries its computed section bucket. */
export interface DbSurveyIndexRow extends DbSurveyRow {
  readonly bucket: number;
}

export const surveyRowFromDb = (r: DbSurveyRow): SurveyIndexRow => ({
  ...r,
  sealed: r.sealed !== 0,
  cancelled: r.cancelled !== 0,
  govLinked: r.govLinked !== 0,
  finalizedCancelled: r.finalizedCancelled !== 0,
});

export const surveyIndexRowFromDb = (
  r: DbSurveyIndexRow,
): SurveyIndexRow & { bucket: number } => ({
  ...surveyRowFromDb(r),
  bucket: r.bucket,
});

const SURVEY_INDEX_RECONCILE = `
  INSERT INTO survey_index
    (survey_key, slot, end_epoch, sealed, cancelled, gov_linked, owner,
     haystack, record, cancellations, gov_links, response_count,
     finalized_cancelled)
  SELECT json_extract(value, '$.surveyKey'),
         json_extract(value, '$.slot'),
         json_extract(value, '$.endEpoch'),
         json_extract(value, '$.sealed'),
         json_extract(value, '$.cancelled'),
         json_extract(value, '$.govLinked'),
         json_extract(value, '$.owner'),
         json_extract(value, '$.haystack'),
         json_extract(value, '$.record'),
         json_extract(value, '$.cancellations'),
         json_extract(value, '$.govLinks'),
         json_extract(value, '$.responseCount'),
         json_extract(value, '$.finalizedCancelled')
  FROM json_each(?)
  WHERE 1
  ON CONFLICT(survey_key) DO UPDATE SET
    slot = excluded.slot,
    end_epoch = excluded.end_epoch,
    sealed = excluded.sealed,
    cancelled = excluded.cancelled,
    gov_linked = excluded.gov_linked,
    owner = excluded.owner,
    haystack = excluded.haystack,
    record = excluded.record,
    cancellations = excluded.cancellations,
    gov_links = excluded.gov_links,
    response_count = excluded.response_count,
    finalized_cancelled = excluded.finalized_cancelled
  WHERE survey_index.slot IS NOT excluded.slot
     OR survey_index.end_epoch IS NOT excluded.end_epoch
     OR survey_index.sealed IS NOT excluded.sealed
     OR survey_index.cancelled IS NOT excluded.cancelled
     OR survey_index.gov_linked IS NOT excluded.gov_linked
     OR survey_index.owner IS NOT excluded.owner
     OR survey_index.haystack IS NOT excluded.haystack
     OR survey_index.record IS NOT excluded.record
     OR survey_index.cancellations IS NOT excluded.cancellations
     OR survey_index.gov_links IS NOT excluded.gov_links
     OR survey_index.response_count IS NOT excluded.response_count
     OR survey_index.finalized_cancelled IS NOT excluded.finalized_cancelled`;

const SNAPSHOT_META_UPSERT = `
  INSERT INTO snapshot_meta (id, tip, incomplete, fetched_at, list_counts)
  VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    tip = excluded.tip,
    incomplete = excluded.incomplete,
    fetched_at = excluded.fetched_at,
    list_counts = excluded.list_counts`;

/** The envelope write, alone (recomputed counts) or ending a reconcile. */
export const snapshotMetaUpsertSql = (meta: SnapshotMeta): SqlQuery => ({
  sql: SNAPSHOT_META_UPSERT,
  params: [meta.tip, meta.incomplete ? 1 : 0, meta.fetchedAt, meta.listCounts],
});

export const SNAPSHOT_META_SELECT = `
  SELECT tip, incomplete, fetched_at AS fetchedAt, list_counts AS listCounts
  FROM snapshot_meta WHERE id = 1`;

/** The survey half of a bundle — only the two columns the body carries. */
export const SURVEY_BUNDLE_SELECT = `
  SELECT record, cancellations FROM survey_index WHERE survey_key = ?`;

/** The stored links keyed by survey, skipping the rows that carry none. */
/** Stored link slices inside the caller's end-epoch horizon. Binds: (minEndEpoch). */
export const SURVEY_GOV_LINKS_SELECT = `
  SELECT survey_key AS surveyKey, gov_links AS govLinks
  FROM survey_index WHERE end_epoch >= ? AND gov_links <> '[]'`;

/**
 * A response is content-addressed by its coordinate, but its chain position
 * can move: the same tx re-landing after a rollback carries a new slot (and
 * epoch) in its record, so this is an upsert with a changed-row guard, not an
 * insert-or-ignore that would pin the original position forever.
 */
const RESPONSE_RECONCILE = `
  INSERT INTO response
    (tx_hash, response_index, survey_key, credential, slot, record)
  SELECT json_extract(value, '$.txHash'),
         json_extract(value, '$.responseIndex'),
         json_extract(value, '$.surveyKey'),
         json_extract(value, '$.credential'),
         json_extract(value, '$.slot'),
         json_extract(value, '$.record')
  FROM json_each(?)
  WHERE 1
  ON CONFLICT(tx_hash, response_index) DO UPDATE SET
    survey_key = excluded.survey_key,
    credential = excluded.credential,
    slot = excluded.slot,
    record = excluded.record
  WHERE response.slot IS NOT excluded.slot
     OR response.record IS NOT excluded.record`;

/** Same reposition rule as {@link RESPONSE_RECONCILE}. */
const CANCELLATION_RECONCILE = `
  INSERT INTO cancellation (tx_hash, survey_key, slot, record)
  SELECT json_extract(value, '$.txHash'),
         json_extract(value, '$.surveyKey'),
         json_extract(value, '$.slot'),
         json_extract(value, '$.record')
  FROM json_each(?)
  WHERE 1
  ON CONFLICT(tx_hash, survey_key) DO UPDATE SET
    slot = excluded.slot,
    record = excluded.record
  WHERE cancellation.slot IS NOT excluded.slot
     OR cancellation.record IS NOT excluded.record`;

const SNAPSHOT_ROWS_PER_CHUNK = 500;
const SNAPSHOT_KEYS_PER_CHUNK = 5_000;
const SNAPSHOT_JSON_BYTES_PER_CHUNK = 512 * 1_024;
const utf8 = new TextEncoder();

interface JsonChunk<T> {
  readonly values: readonly T[];
  readonly json: string;
}

function jsonChunks<T>(values: readonly T[], maxRows: number): JsonChunk<T>[] {
  const chunks: JsonChunk<T>[] = [];
  let chunkValues: T[] = [];
  let encodedValues: string[] = [];
  let bytes = 2;

  const flush = () => {
    if (chunkValues.length === 0) return;
    chunks.push({
      values: chunkValues,
      json: `[${encodedValues.join(",")}]`,
    });
    chunkValues = [];
    encodedValues = [];
    bytes = 2;
  };

  for (const value of values) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("snapshot row is not JSON");
    const encodedBytes = utf8.encode(encoded).byteLength;
    const separatorBytes = chunkValues.length === 0 ? 0 : 1;
    if (
      chunkValues.length > 0 &&
      (chunkValues.length >= maxRows ||
        bytes + separatorBytes + encodedBytes > SNAPSHOT_JSON_BYTES_PER_CHUNK)
    ) {
      flush();
    }
    chunkValues.push(value);
    encodedValues.push(encoded);
    bytes += (chunkValues.length === 1 ? 0 : 1) + encodedBytes;
  }
  flush();
  return chunks;
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Restricts a deletion's candidates to `range`; unbounded when absent. */
const slotBound = (range: SlotRange | undefined): SqlQuery =>
  range === undefined
    ? { sql: "1", params: [] }
    : { sql: "slot BETWEEN ? AND ?", params: [range.fromSlot, range.toSlot] };

function surveyDeletionSql(
  keys: readonly { readonly surveyKey: string }[],
  range?: SlotRange,
): SqlQuery[] {
  const bound = slotBound(range);
  if (keys.length === 0)
    return [
      {
        sql: `DELETE FROM survey_index WHERE ${bound.sql}`,
        params: [...bound.params],
      },
    ];
  const chunks = jsonChunks(keys, SNAPSHOT_KEYS_PER_CHUNK);
  return chunks.map((chunk, index) => {
    const lower = index === 0 ? null : chunk.values[0]!.surveyKey;
    const upper = chunks[index + 1]?.values[0]?.surveyKey ?? null;
    const bounds: string[] = [bound.sql];
    const params: unknown[] = [...bound.params];
    if (lower !== null) {
      bounds.push("survey_key >= ?");
      params.push(lower);
    }
    if (upper !== null) {
      bounds.push("survey_key < ?");
      params.push(upper);
    }
    params.push(chunk.json);
    return {
      sql: `DELETE FROM survey_index
            WHERE ${bounds.join(" AND ")}
              AND survey_key NOT IN (
                SELECT json_extract(value, '$.surveyKey') FROM json_each(?)
              )`,
      params,
    };
  });
}

interface ResponseKey {
  readonly txHash: string;
  readonly responseIndex: number;
}

function responseDeletionSql(
  keys: readonly ResponseKey[],
  range?: SlotRange,
): SqlQuery[] {
  const bound = slotBound(range);
  if (keys.length === 0)
    return [
      {
        sql: `DELETE FROM response WHERE ${bound.sql}`,
        params: [...bound.params],
      },
    ];
  const chunks = jsonChunks(keys, SNAPSHOT_KEYS_PER_CHUNK);
  return chunks.map((chunk, index) => {
    const lower = index === 0 ? null : chunk.values[0]!;
    const upper = chunks[index + 1]?.values[0] ?? null;
    const bounds: string[] = [bound.sql];
    const params: unknown[] = [...bound.params];
    if (lower !== null) {
      bounds.push("(tx_hash > ? OR (tx_hash = ? AND response_index >= ?))");
      params.push(lower.txHash, lower.txHash, lower.responseIndex);
    }
    if (upper !== null) {
      bounds.push("(tx_hash < ? OR (tx_hash = ? AND response_index < ?))");
      params.push(upper.txHash, upper.txHash, upper.responseIndex);
    }
    params.push(chunk.json);
    return {
      sql: `DELETE FROM response
            WHERE ${bounds.join(" AND ")}
              AND (tx_hash, response_index) NOT IN (
                SELECT json_extract(value, '$.txHash'),
                       json_extract(value, '$.responseIndex')
                FROM json_each(?)
              )`,
      params,
    };
  });
}

interface CancellationKey {
  readonly txHash: string;
  readonly surveyKey: string;
}

function cancellationDeletionSql(
  keys: readonly CancellationKey[],
  range?: SlotRange,
): SqlQuery[] {
  const bound = slotBound(range);
  if (keys.length === 0)
    return [
      {
        sql: `DELETE FROM cancellation WHERE ${bound.sql}`,
        params: [...bound.params],
      },
    ];
  const chunks = jsonChunks(keys, SNAPSHOT_KEYS_PER_CHUNK);
  return chunks.map((chunk, index) => {
    const lower = index === 0 ? null : chunk.values[0]!;
    const upper = chunks[index + 1]?.values[0] ?? null;
    const bounds: string[] = [bound.sql];
    const params: unknown[] = [...bound.params];
    if (lower !== null) {
      bounds.push("(tx_hash > ? OR (tx_hash = ? AND survey_key >= ?))");
      params.push(lower.txHash, lower.txHash, lower.surveyKey);
    }
    if (upper !== null) {
      bounds.push("(tx_hash < ? OR (tx_hash = ? AND survey_key < ?))");
      params.push(upper.txHash, upper.txHash, upper.surveyKey);
    }
    params.push(chunk.json);
    return {
      sql: `DELETE FROM cancellation
            WHERE ${bounds.join(" AND ")}
              AND (tx_hash, survey_key) NOT IN (
                SELECT json_extract(value, '$.txHash'),
                       json_extract(value, '$.surveyKey')
                FROM json_each(?)
              )`,
      params,
    };
  });
}

/**
 * How a reconcile program sweeps: everywhere (the full rebuild), only within
 * a slot range (a covered segment), or not at all (an incomplete scan, whose
 * unlisted txs are indistinguishable from vanished ones).
 */
type Sweep =
  | { readonly kind: "everything" }
  | { readonly kind: "range"; readonly range: SlotRange }
  | { readonly kind: "none" };

function reconciliationSql(
  surveys: readonly SurveyIndexRow[],
  responses: readonly ResponseRow[],
  cancellations: readonly CancellationRow[],
  meta: SnapshotMeta,
  sweep: Sweep,
): SqlQuery[] {
  const sortedSurveys = [...surveys].sort((a, b) =>
    compareText(a.surveyKey, b.surveyKey),
  );
  const sortedResponses = [...responses].sort(
    (a, b) =>
      compareText(a.txHash, b.txHash) || a.responseIndex - b.responseIndex,
  );
  const sortedCancellations = [...cancellations].sort(
    (a, b) =>
      compareText(a.txHash, b.txHash) || compareText(a.surveyKey, b.surveyKey),
  );

  const deletions =
    sweep.kind === "none"
      ? []
      : [
          ...surveyDeletionSql(
            sortedSurveys.map(({ surveyKey }) => ({ surveyKey })),
            sweep.kind === "range" ? sweep.range : undefined,
          ),
          ...responseDeletionSql(
            sortedResponses.map(({ txHash, responseIndex }) => ({
              txHash,
              responseIndex,
            })),
            sweep.kind === "range" ? sweep.range : undefined,
          ),
          ...cancellationDeletionSql(
            sortedCancellations.map(({ txHash, surveyKey }) => ({
              txHash,
              surveyKey,
            })),
            sweep.kind === "range" ? sweep.range : undefined,
          ),
        ];

  return [
    ...jsonChunks(sortedSurveys, SNAPSHOT_ROWS_PER_CHUNK).map((chunk) => ({
      sql: SURVEY_INDEX_RECONCILE,
      params: [chunk.json],
    })),
    ...jsonChunks(sortedResponses, SNAPSHOT_ROWS_PER_CHUNK).map((chunk) => ({
      sql: RESPONSE_RECONCILE,
      params: [chunk.json],
    })),
    ...jsonChunks(sortedCancellations, SNAPSHOT_ROWS_PER_CHUNK).map(
      (chunk) => ({
        sql: CANCELLATION_RECONCILE,
        params: [chunk.json],
      }),
    ),
    ...deletions,
    snapshotMetaUpsertSql(meta),
  ];
}

/**
 * One atomic reconciliation program for either SQLite adapter. JSON table-valued
 * parameters keep first materialization and large reorgs to bounded set
 * operations rather than one statement per record. The envelope upsert is
 * always the final statement, so a caller counting changed rows can exclude
 * it (freshness moves every run).
 */
export const snapshotReconciliationSql = (
  surveys: readonly SurveyIndexRow[],
  responses: readonly ResponseRow[],
  cancellations: readonly CancellationRow[],
  meta: SnapshotMeta,
): SqlQuery[] =>
  reconciliationSql(surveys, responses, cancellations, meta, {
    kind: "everything",
  });

/**
 * The slot-bounded sibling of {@link snapshotReconciliationSql}: the same
 * upserts, but only rows with slot in `range` are deletion candidates —
 * settled history outside the segment is never swept, however little of the
 * chain one call covers. A null `range` (incomplete scan) sweeps nothing.
 */
export const segmentReconciliationSql = (
  range: SlotRange | null,
  surveys: readonly SurveyIndexRow[],
  responses: readonly ResponseRow[],
  cancellations: readonly CancellationRow[],
  meta: SnapshotMeta,
): SqlQuery[] =>
  reconciliationSql(
    surveys,
    responses,
    cancellations,
    meta,
    range === null ? { kind: "none" } : { kind: "range", range },
  );

/** Ordered so a bundle body is byte-stable across refreshes. */
export const RESPONSES_FOR_SURVEY = `
  SELECT record FROM response WHERE survey_key = ?
  ORDER BY slot, tx_hash, response_index`;

/** Distinct surveys answered by any of `credentials`. */
export const respondedSql = (credentials: readonly string[]): SqlQuery => ({
  sql: `SELECT DISTINCT survey_key AS surveyKey FROM response
        WHERE credential IN (${credentials.map(() => "?").join(", ")})`,
  params: [...credentials],
});

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

export const scanStateUpsertSql = (state: ScanState): SqlQuery => ({
  sql: SCAN_STATE_UPSERT,
  params: [
    state.cursor?.slot ?? null,
    state.cursor?.txHash ?? null,
    state.caughtUp ? 1 : 0,
    state.generation,
    state.trickle?.slot ?? null,
    state.trickle?.txHash ?? null,
  ],
});

/**
 * The settlement floor, written on its own so an incomplete scan — which must
 * not bank a cursor — can still bank what the governance pass settled. Before
 * the first cursor there is no row, and the update is a no-op: the floor reads
 * 0, which asks about everything.
 */
export const SETTLEMENT_FLOOR_UPDATE = `
  UPDATE scan_state SET settlement_floor = ? WHERE id = 1`;

export const SETTLEMENT_FLOOR_SELECT = `
  SELECT settlement_floor AS settlementFloor FROM scan_state WHERE id = 1`;

/**
 * The finalization floor, on the same row and by the same rule: written on its
 * own, and 0 before there is a row to write.
 */
export const FINALIZATION_FLOOR_UPDATE = `
  UPDATE scan_state SET finalization_floor = ? WHERE id = 1`;

export const FINALIZATION_FLOOR_SELECT = `
  SELECT finalization_floor AS finalizationFloor FROM scan_state WHERE id = 1`;

export const SCAN_STATE_SELECT = `
  SELECT cursor_slot AS cursorSlot, cursor_tx_hash AS cursorTxHash,
         caught_up AS caughtUp, generation,
         trickle_slot AS trickleSlot, trickle_tx_hash AS trickleTxHash
  FROM scan_state WHERE id = 1`;

/** As stored: each cursor is a pair of columns, NULL together. */
export interface DbScanStateRow {
  readonly cursorSlot: number | null;
  readonly cursorTxHash: string | null;
  readonly caughtUp: number;
  readonly generation: number;
  readonly trickleSlot: number | null;
  readonly trickleTxHash: string | null;
}

export const scanStateFromDb = (r: DbScanStateRow): ScanState => ({
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

const SURVEY_ROW_COLUMNS = `survey_key AS surveyKey, slot,
       end_epoch AS endEpoch, sealed, cancelled, gov_linked AS govLinked,
       owner, haystack, record, cancellations, gov_links AS govLinks,
       response_count AS responseCount,
       finalized_cancelled AS finalizedCancelled`;

const RESPONSE_ROW_COLUMNS = `tx_hash AS txHash,
       response_index AS responseIndex, survey_key AS surveyKey, credential,
       slot, record`;

/**
 * Stored projections by key. Keys ride as one bound JSON array per chunk (a
 * key list can exceed D1's 100-parameter cap); sorted first, so concatenated
 * chunk results come back in key order.
 */
export const surveysByKeysSql = (keys: readonly string[]): SqlQuery[] =>
  jsonChunks([...keys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({
      sql: `SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index
            WHERE survey_key IN (SELECT value FROM json_each(?))
            ORDER BY survey_key`,
      params: [chunk.json],
    }),
  );

/** All stored responses of the given surveys — a recount's stored half. */
export const responsesBySurveysSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  jsonChunks([...surveyKeys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({
      sql: `SELECT ${RESPONSE_ROW_COLUMNS} FROM response
            WHERE survey_key IN (SELECT value FROM json_each(?))
            ORDER BY survey_key, slot, tx_hash, response_index`,
      params: [chunk.json],
    }),
  );

/** The window's stored responses, in scan order. Binds: (fromSlot, toSlot). */
export const RESPONSES_IN_SLOT_RANGE = `
  SELECT ${RESPONSE_ROW_COLUMNS} FROM response
  WHERE slot BETWEEN ? AND ?
  ORDER BY slot, tx_hash, response_index`;

const CANCELLATION_ROW_COLUMNS = `tx_hash AS txHash,
       survey_key AS surveyKey, slot, record`;

/** All stored cancellations of the given surveys — a projection rebuild's stored half. */
export const cancellationsBySurveysSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  jsonChunks([...surveyKeys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({
      sql: `SELECT ${CANCELLATION_ROW_COLUMNS} FROM cancellation
            WHERE survey_key IN (SELECT value FROM json_each(?))
            ORDER BY survey_key, slot, tx_hash`,
      params: [chunk.json],
    }),
  );

/** The window's stored cancellations. Binds: (fromSlot, toSlot). */
export const CANCELLATIONS_IN_SLOT_RANGE = `
  SELECT ${CANCELLATION_ROW_COLUMNS} FROM cancellation
  WHERE slot BETWEEN ? AND ?
  ORDER BY slot, tx_hash`;

/**
 * Surveys whose verified-while-open cancellation expired at close (no
 * finalized overlay yet backs it). Binds: (tipEpoch).
 */
export const STALE_CANCELLED_SURVEYS = `
  SELECT survey_key AS surveyKey FROM survey_index
  WHERE cancelled = 1 AND finalized_cancelled = 0 AND end_epoch < ?`;

/** Stamp the finalized-cancelled overlay where not already set. */
export const markFinalizedCancelledSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  jsonChunks([...surveyKeys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({
      sql: `UPDATE survey_index SET finalized_cancelled = 1, cancelled = 1
            WHERE finalized_cancelled = 0
              AND survey_key IN (SELECT value FROM json_each(?))`,
      params: [chunk.json],
    }),
  );

/**
 * The governance pass's input: which end epochs any stored survey has, from
 * the settlement horizon up. Binds: (minEndEpoch).
 */
export const SURVEY_END_EPOCHS = `
  SELECT DISTINCT end_epoch AS endEpoch FROM survey_index
  WHERE end_epoch >= ?
  ORDER BY end_epoch`;

/**
 * Finalization's candidate set: closed at the tip, no artifact yet, from its
 * floor up — below which every survey is decided, so neither the rows nor the
 * artifacts down there are worth reading. Binds: (floorEpoch, tipEpoch,
 * floorEpoch).
 */
export const UNFINALIZED_CLOSED_SURVEYS = `
  SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index
  WHERE end_epoch >= ? AND end_epoch < ?
    AND survey_key NOT IN (
      SELECT survey_key FROM tally_artifact WHERE end_epoch >= ?)
  ORDER BY survey_key`;

/** Surveys still inside a caller's end-epoch horizon. Binds: (minEndEpoch). */
export const SURVEYS_ENDING_AT_OR_AFTER = `
  SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index
  WHERE end_epoch >= ?
  ORDER BY survey_key`;

/**
 * Completed validation verdicts (both enrichments present) of the given
 * surveys, keyed so a windowed refresh reads only the corner of the table its
 * candidates touch instead of every verdict ever recorded.
 */
export const completedValidationsSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  jsonChunks([...surveyKeys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({
      sql: `SELECT tx_hash AS txHash, response_index AS responseIndex,
                   linked_action_id AS linkedActionId, slot, epoch_no AS epochNo
            FROM validated_response
            WHERE survey_key IN (SELECT value FROM json_each(?))
              AND block_index IS NOT NULL AND proof_ok IS NOT NULL`,
      params: [chunk.json],
    }),
  );

const BINDABLE = [...BINDABLE_ROLES].sort((a, b) => a - b);

/**
 * The distinct link-set cursors completed verdicts are pinned to, per survey.
 * Only bindable roles: no other verdict re-evaluates on a link change, so no
 * other row can put a survey back on the candidate list.
 */
export const VALIDATED_LINK_CURSORS: SqlQuery = {
  sql: `SELECT DISTINCT survey_key AS surveyKey,
               linked_action_id AS linkedActionId
        FROM validated_response
        WHERE block_index IS NOT NULL AND proof_ok IS NOT NULL
          AND role IN (${BINDABLE.map(() => "?").join(", ")})`,
  params: [...BINDABLE],
};

/** Surveys with a verdict still awaiting an enrichment retry. */
export const INCOMPLETE_VALIDATION_SURVEYS = `
  SELECT DISTINCT survey_key AS surveyKey FROM validated_response
  WHERE block_index IS NULL OR proof_ok IS NULL`;

/** Counts come back as SQLite integers already shaped like the counts type. */
export const countsFromDb = (r: Record<string, number>): SurveyListCounts => ({
  all: r["all"] ?? 0,
  linked: r["linked"] ?? 0,
  active: r["active"] ?? 0,
  sealed: r["sealed"] ?? 0,
  public: r["public"] ?? 0,
  mine: r["mine"] ?? 0,
});
