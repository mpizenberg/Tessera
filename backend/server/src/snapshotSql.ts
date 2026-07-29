/**
 * SQL over the materialized snapshot tables, shared verbatim by `store-node.ts`
 * and `store-d1.ts` (same SQLite dialect on both). The `survey_index`
 * page/count semantics mirror `@tessera/core`'s `pageSurveyList` — the
 * executable spec — exactly: bucket 0 gov-linked / 1 open / 2 closed, ordered
 * (bucket ASC, slot DESC, key ASC), AND-of-substrings search, chip counts over
 * the search-matching set.
 *
 * Queries whose arity varies (search terms, credential lists) are built per
 * call, so nothing here is a cached prepared statement — the tables are
 * scan-sized and these run once per request.
 */

import type { SurveyListCounts } from "@tessera/core";

import type { ResponseRow, SurveyIndexRow, SurveyPageQuery } from "./store";

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

export const SURVEY_INDEX_INSERT = `
  INSERT INTO survey_index
    (survey_key, slot, end_epoch, sealed, cancelled, gov_linked, owner,
     haystack, record, cancellations, gov_links, response_count,
     finalized_cancelled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const surveyIndexInsertParams = (r: SurveyIndexRow): unknown[] => [
  r.surveyKey,
  r.slot,
  r.endEpoch,
  r.sealed ? 1 : 0,
  r.cancelled ? 1 : 0,
  r.govLinked ? 1 : 0,
  r.owner,
  r.haystack,
  r.record,
  r.cancellations,
  r.govLinks,
  r.responseCount,
  r.finalizedCancelled ? 1 : 0,
];

export const SNAPSHOT_META_UPSERT = `
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

/**
 * A repeated `(tx_hash, response_index)` names the same immutable on-chain
 * response, so replacing is a no-op — and cheaper than letting a scan quirk
 * abort the whole refresh, which is the silent-freeze failure this table exists
 * to remove.
 */
export const RESPONSE_INSERT = `
  INSERT OR REPLACE INTO response
    (tx_hash, response_index, survey_key, credential, slot, record)
  VALUES (?, ?, ?, ?, ?, ?)`;

export const responseInsertParams = (r: ResponseRow): unknown[] => [
  r.txHash,
  r.responseIndex,
  r.surveyKey,
  r.credential,
  r.slot,
  r.record,
];

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
