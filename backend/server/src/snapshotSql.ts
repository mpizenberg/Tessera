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

import type {
  ResponseRow,
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
export interface DbSurveyIndexRow extends Omit<
  SurveyIndexRow,
  "sealed" | "cancelled" | "govLinked" | "finalizedCancelled"
> {
  readonly sealed: number;
  readonly cancelled: number;
  readonly govLinked: number;
  readonly finalizedCancelled: number;
  readonly bucket: number;
}

export const surveyIndexRowFromDb = (
  r: DbSurveyIndexRow,
): SurveyIndexRow & { bucket: number } => ({
  ...r,
  sealed: r.sealed !== 0,
  cancelled: r.cancelled !== 0,
  govLinked: r.govLinked !== 0,
  finalizedCancelled: r.finalizedCancelled !== 0,
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
  INSERT INTO snapshot_meta (id, tip, incomplete, fetched_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    tip = excluded.tip,
    incomplete = excluded.incomplete,
    fetched_at = excluded.fetched_at`;

export const SNAPSHOT_META_SELECT = `
  SELECT tip, incomplete, fetched_at AS fetchedAt FROM snapshot_meta WHERE id = 1`;

/** The survey half of a bundle — only the two columns the body carries. */
export const SURVEY_BUNDLE_SELECT = `
  SELECT record, cancellations FROM survey_index WHERE survey_key = ?`;

/** The stored snapshot's governance links, skipping the rows that carry none. */
export const SNAPSHOT_GOV_LINKS_SELECT = `
  SELECT gov_links AS govLinks FROM survey_index WHERE gov_links <> '[]'`;

/** A repeated coordinate is the same immutable on-chain response. */
const RESPONSE_RECONCILE = `
  INSERT OR IGNORE INTO response
    (tx_hash, response_index, survey_key, credential, slot, record)
  SELECT json_extract(value, '$.txHash'),
         json_extract(value, '$.responseIndex'),
         json_extract(value, '$.surveyKey'),
         json_extract(value, '$.credential'),
         json_extract(value, '$.slot'),
         json_extract(value, '$.record')
  FROM json_each(?)`;

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

function surveyDeletionSql(
  keys: readonly { readonly surveyKey: string }[],
): SqlQuery[] {
  if (keys.length === 0)
    return [{ sql: "DELETE FROM survey_index", params: [] }];
  const chunks = jsonChunks(keys, SNAPSHOT_KEYS_PER_CHUNK);
  return chunks.map((chunk, index) => {
    const lower = index === 0 ? null : chunk.values[0]!.surveyKey;
    const upper = chunks[index + 1]?.values[0]?.surveyKey ?? null;
    const bounds: string[] = [];
    const params: unknown[] = [];
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
            WHERE ${bounds.length === 0 ? "1" : bounds.join(" AND ")}
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

function responseDeletionSql(keys: readonly ResponseKey[]): SqlQuery[] {
  if (keys.length === 0) return [{ sql: "DELETE FROM response", params: [] }];
  const chunks = jsonChunks(keys, SNAPSHOT_KEYS_PER_CHUNK);
  return chunks.map((chunk, index) => {
    const lower = index === 0 ? null : chunk.values[0]!;
    const upper = chunks[index + 1]?.values[0] ?? null;
    const bounds: string[] = [];
    const params: unknown[] = [];
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
            WHERE ${bounds.length === 0 ? "1" : bounds.join(" AND ")}
              AND (tx_hash, response_index) NOT IN (
                SELECT json_extract(value, '$.txHash'),
                       json_extract(value, '$.responseIndex')
                FROM json_each(?)
              )`,
      params,
    };
  });
}

/**
 * One atomic reconciliation program for either SQLite adapter. JSON table-valued
 * parameters keep first materialization and large reorgs to bounded set
 * operations rather than one statement per record.
 */
export function snapshotReconciliationSql(
  surveys: readonly SurveyIndexRow[],
  responses: readonly ResponseRow[],
  meta: SnapshotMeta,
): SqlQuery[] {
  const sortedSurveys = [...surveys].sort((a, b) =>
    compareText(a.surveyKey, b.surveyKey),
  );
  const sortedResponses = [...responses].sort(
    (a, b) =>
      compareText(a.txHash, b.txHash) || a.responseIndex - b.responseIndex,
  );
  const surveyKeys = sortedSurveys.map(({ surveyKey }) => ({ surveyKey }));
  const responseKeys = sortedResponses.map(({ txHash, responseIndex }) => ({
    txHash,
    responseIndex,
  }));

  return [
    ...jsonChunks(sortedSurveys, SNAPSHOT_ROWS_PER_CHUNK).map((chunk) => ({
      sql: SURVEY_INDEX_RECONCILE,
      params: [chunk.json],
    })),
    ...surveyDeletionSql(surveyKeys),
    ...jsonChunks(sortedResponses, SNAPSHOT_ROWS_PER_CHUNK).map((chunk) => ({
      sql: RESPONSE_RECONCILE,
      params: [chunk.json],
    })),
    ...responseDeletionSql(responseKeys),
    {
      sql: SNAPSHOT_META_UPSERT,
      params: [meta.tip, meta.incomplete ? 1 : 0, meta.fetchedAt],
    },
  ];
}

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

/** Counts come back as SQLite integers already shaped like the counts type. */
export const countsFromDb = (r: Record<string, number>): SurveyListCounts => ({
  all: r["all"] ?? 0,
  linked: r["linked"] ?? 0,
  active: r["active"] ?? 0,
  sealed: r["sealed"] ?? 0,
  public: r["public"] ?? 0,
  mine: r["mine"] ?? 0,
});
