/**
 * SQL composed at call time — the statements `store-sql.ts` cannot write out
 * because their shape varies with the request: search terms and credential
 * lists (paging and counts), key sets riding as chunked JSON parameters, and
 * the snapshot reconciliation program. Every fixed statement lives in
 * `store-sql.ts` with the method that issues it.
 *
 * The `survey_index` page/count semantics mirror `cardano-tessera-core`'s
 * `pageSurveyList` — the executable spec — exactly: bucket 0 gov-linked /
 * 1 open / 2 closed, ordered (bucket ASC, slot DESC, key ASC),
 * AND-of-substrings search, chip counts over the search-matching set.
 */

import type { ResponseCursor } from "cardano-tessera-core";

import type {
  CancellationRow,
  ResponseCountBank,
  ResponseRow,
  SlotRange,
  SnapshotMeta,
  SqlQuery,
  SurveyIndexRow,
  SurveyPageQuery,
} from "./store";

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
               response_count, counted_by_role, refuted_count,
               final_state, artifact_hash,
               ${BUCKET} AS bucket
        FROM survey_index
        WHERE ${search.sql} AND ${filter.sql}
      )
      SELECT survey_key AS surveyKey, slot, end_epoch AS endEpoch, sealed,
             cancelled, gov_linked AS govLinked, owner, haystack, record,
             cancellations, gov_links AS govLinks,
             response_count AS responseCount,
             counted_by_role AS countedByRole,
             refuted_count AS refutedCount,
             final_state AS finalState, artifact_hash AS artifactHash, bucket
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

const SURVEY_INDEX_RECONCILE = `
  INSERT INTO survey_index
    (survey_key, slot, end_epoch, sealed, cancelled, gov_linked, owner,
     haystack, record, cancellations, gov_links, response_count,
     counted_by_role, refuted_count, final_state, artifact_hash)
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
         json_extract(value, '$.countedByRole'),
         json_extract(value, '$.refutedCount'),
         json_extract(value, '$.finalState'),
         json_extract(value, '$.artifactHash')
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
    counted_by_role = excluded.counted_by_role,
    refuted_count = excluded.refuted_count,
    final_state = excluded.final_state,
    artifact_hash = excluded.artifact_hash
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
     OR survey_index.counted_by_role IS NOT excluded.counted_by_role
     OR survey_index.refuted_count IS NOT excluded.refuted_count
     OR survey_index.final_state IS NOT excluded.final_state
     OR survey_index.artifact_hash IS NOT excluded.artifact_hash`;

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

/**
 * A response is content-addressed by its coordinate, but its chain position
 * can move: the same tx re-landing after a rollback carries a new slot (and
 * epoch) in its record, so this is an upsert with a changed-row guard, not an
 * insert-or-ignore that would pin the original position forever.
 */
const RESPONSE_RECONCILE = `
  INSERT INTO response
    (tx_hash, response_index, survey_key, role, credential, slot,
     countable, record)
  SELECT json_extract(value, '$.txHash'),
         json_extract(value, '$.responseIndex'),
         json_extract(value, '$.surveyKey'),
         json_extract(value, '$.role'),
         json_extract(value, '$.credential'),
         json_extract(value, '$.slot'),
         json_extract(value, '$.countable'),
         json_extract(value, '$.record')
  FROM json_each(?)
  WHERE 1
  ON CONFLICT(tx_hash, response_index) DO UPDATE SET
    survey_key = excluded.survey_key,
    role = excluded.role,
    credential = excluded.credential,
    slot = excluded.slot,
    countable = excluded.countable,
    record = excluded.record
  WHERE response.slot IS NOT excluded.slot
     OR response.countable IS NOT excluded.countable
     OR response.record IS NOT excluded.record`;

/** A recounted survey's bank, overwritten whole. */
const RESPONSE_COUNT_BANK_UPSERT = `
  INSERT INTO response_count_bank
    (survey_key, settled_count, settled_by_role, below_slot)
  SELECT json_extract(value, '$.surveyKey'),
         json_extract(value, '$.settledCount'),
         json_extract(value, '$.settledByRole'),
         json_extract(value, '$.belowSlot')
  FROM json_each(?)
  WHERE 1
  ON CONFLICT(survey_key) DO UPDATE SET
    settled_count = excluded.settled_count,
    settled_by_role = excluded.settled_by_role,
    below_slot = excluded.below_slot`;

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

/** Restricts a deletion's candidates to `range`. */
const slotBound = (range: SlotRange): SqlQuery => ({
  sql: "slot BETWEEN ? AND ?",
  params: [range.fromSlot, range.toSlot],
});

function surveyDeletionSql(
  keys: readonly { readonly surveyKey: string }[],
  range: SlotRange,
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
  range: SlotRange,
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
  range: SlotRange,
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
 * One atomic reconciliation program for either SQLite adapter. JSON
 * table-valued parameters keep first materialization and large reorgs to
 * bounded set operations rather than one statement per record. Only rows with
 * slot in `range` are deletion candidates — settled history outside the
 * segment is never swept, however little of the chain one call covers; a null
 * `range` (an incomplete scan, whose unlisted txs are indistinguishable from
 * vanished ones) sweeps nothing. The first `rowStatements` statements are the
 * row writes; the bank upserts and the envelope upsert follow, so a caller
 * counting changed rows can exclude them (freshness moves every run).
 */
export function segmentReconciliationSql(
  range: SlotRange | null,
  surveys: readonly SurveyIndexRow[],
  responses: readonly ResponseRow[],
  cancellations: readonly CancellationRow[],
  banks: readonly ResponseCountBank[],
  meta: SnapshotMeta,
): { program: SqlQuery[]; rowStatements: number } {
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
    range === null
      ? []
      : [
          ...surveyDeletionSql(
            sortedSurveys.map(({ surveyKey }) => ({ surveyKey })),
            range,
          ),
          ...responseDeletionSql(
            sortedResponses.map(({ txHash, responseIndex }) => ({
              txHash,
              responseIndex,
            })),
            range,
          ),
          ...cancellationDeletionSql(
            sortedCancellations.map(({ txHash, surveyKey }) => ({
              txHash,
              surveyKey,
            })),
            range,
          ),
        ];

  const rows = [
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
  ];
  return {
    program: [
      ...rows,
      ...jsonChunks(banks, SNAPSHOT_ROWS_PER_CHUNK).map((chunk) => ({
        sql: RESPONSE_COUNT_BANK_UPSERT,
        params: [chunk.json],
      })),
      snapshotMetaUpsertSql(meta),
    ],
    rowStatements: rows.length,
  };
}

/** Distinct surveys answered by any of `credentials`. */
export const respondedSql = (credentials: readonly string[]): SqlQuery => ({
  sql: `SELECT DISTINCT survey_key AS surveyKey FROM response
        WHERE credential IN (${credentials.map(() => "?").join(", ")})`,
  params: [...credentials],
});

export const SURVEY_ROW_COLUMNS = `survey_key AS surveyKey, slot,
       end_epoch AS endEpoch, sealed, cancelled, gov_linked AS govLinked,
       owner, haystack, record, cancellations, gov_links AS govLinks,
       response_count AS responseCount,
       counted_by_role AS countedByRole, refuted_count AS refutedCount,
       final_state AS finalState, artifact_hash AS artifactHash`;

export const STORED_RESPONSE_COLUMNS = `tx_hash AS txHash,
       response_index AS responseIndex, survey_key AS surveyKey, role,
       credential, slot`;

export const RESPONSE_ROW_COLUMNS = `${STORED_RESPONSE_COLUMNS}, countable, record`;

/**
 * A keyed read: `sql` once per chunk of keys, each chunk bound as one JSON
 * array (`… IN (SELECT value FROM json_each(?))`) — a key list can exceed
 * D1's 100-parameter cap. Keys are sorted first, so concatenated chunk
 * results come back in key order.
 */
export const byKeysSql = (sql: string, keys: readonly string[]): SqlQuery[] =>
  jsonChunks([...keys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({ sql, params: [chunk.json] }),
  );

/** A bound JSON array read as a key set: `… IN ${JSON_KEY_SET}`. */
export const JSON_KEY_SET = "(SELECT value FROM json_each(?))";

/** Stored projections by key. */
export const surveysByKeysSql = (keys: readonly string[]): SqlQuery[] =>
  byKeysSql(
    `SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index
     WHERE survey_key IN ${JSON_KEY_SET}
     ORDER BY survey_key`,
    keys,
  );

/** All stored responses of the given surveys, records included. */
export const responsesBySurveysSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  byKeysSql(
    `SELECT ${RESPONSE_ROW_COLUMNS} FROM response
     WHERE survey_key IN ${JSON_KEY_SET}
     ORDER BY survey_key, slot, tx_hash, response_index`,
    surveyKeys,
  );

/**
 * One survey's responses in storage order, from `cursor` exclusive. The
 * `response_survey` index is exactly this order, so the page is a seek and a
 * walk of its own length — no sort, and nothing read below the cursor.
 */
export const responsesForSurveyPageSql = (
  surveyKey: string,
  cursor: ResponseCursor | null,
  limit: number,
): SqlQuery => ({
  sql: `SELECT ${RESPONSE_ROW_COLUMNS} FROM response
        WHERE survey_key = ?${
          cursor
            ? ` AND (slot > ? OR (slot = ? AND (tx_hash > ?
                 OR (tx_hash = ? AND response_index > ?))))`
            : ""
        }
        ORDER BY slot, tx_hash, response_index
        LIMIT ?`,
  params: [
    surveyKey,
    ...(cursor
      ? [
          cursor.slot,
          cursor.slot,
          cursor.txHash,
          cursor.txHash,
          cursor.responseIndex,
        ]
      : []),
    limit,
  ],
});

export const CANCELLATION_ROW_COLUMNS = `tx_hash AS txHash,
       survey_key AS surveyKey, slot, record`;

/** All stored cancellations of the given surveys — a projection rebuild's stored half. */
export const cancellationsBySurveysSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  byKeysSql(
    `SELECT ${CANCELLATION_ROW_COLUMNS} FROM cancellation
     WHERE survey_key IN ${JSON_KEY_SET}
     ORDER BY survey_key, slot, tx_hash`,
    surveyKeys,
  );

/**
 * Stamp final states onto undecided rows. A cancelled state implies the
 * `cancelled` flag; the other states leave it as the projection derived it.
 */
export const markFinalStatesSql = (
  entries: readonly {
    surveyKey: string;
    state: string;
    artifactHash: string | null;
  }[],
): SqlQuery[] =>
  jsonChunks([...entries], SNAPSHOT_ROWS_PER_CHUNK).map((chunk) => ({
    sql: `UPDATE survey_index
          SET final_state = json_extract(e.value, '$.state'),
              artifact_hash = json_extract(e.value, '$.artifactHash'),
              cancelled = CASE WHEN json_extract(e.value, '$.state') = 'cancelled'
                               THEN 1 ELSE cancelled END
          FROM json_each(?) AS e
          WHERE survey_index.survey_key = json_extract(e.value, '$.surveyKey')
            AND survey_index.final_state IS NULL`,
    params: [chunk.json],
  }));

/** Persist untalliable verdicts; re-reaching one is a no-op. */
export const putUntalliableSql = (
  surveyKeys: readonly string[],
  decidedAt: number,
): SqlQuery[] =>
  jsonChunks([...surveyKeys].sort(compareText), SNAPSHOT_KEYS_PER_CHUNK).map(
    (chunk) => ({
      sql: `INSERT INTO untalliable_survey (survey_key, decided_at)
            SELECT value, ? FROM json_each(?)
            WHERE 1
            ON CONFLICT(survey_key) DO NOTHING`,
      params: [decidedAt, chunk.json],
    }),
  );

/**
 * Completed validation verdicts (both enrichments present) of the given
 * transactions — a primary-key seek per hash, so validation reads the
 * verdicts of the responses in front of it and nothing else.
 */
export const completedValidationsSql = (
  txHashes: readonly string[],
): SqlQuery[] =>
  byKeysSql(
    `SELECT tx_hash AS txHash, response_index AS responseIndex,
            linked_action_id AS linkedActionId, slot, epoch_no AS epochNo
     FROM validated_response
     WHERE tx_hash IN ${JSON_KEY_SET}
       AND block_index IS NOT NULL AND proof_ok IS NOT NULL`,
    txHashes,
  );

/**
 * The artifact-backed final states restricted to the given surveys: which of
 * them hold an artifact, its hash, and whether it finalized them as cancelled.
 * `json_extract` returns SQL NULL both when the path is absent and when the
 * value is JSON null, so `IS NOT NULL` is exactly "finalized as cancelled".
 */
export const artifactStatesSql = (surveyKeys: readonly string[]): SqlQuery[] =>
  byKeysSql(
    `SELECT survey_key AS surveyKey, artifact_hash AS artifactHash,
            json_extract(artifact, '$.tally.cancelled') IS NOT NULL AS cancelled
     FROM tally_artifact WHERE survey_key IN ${JSON_KEY_SET}`,
    surveyKeys,
  );

/** Which of the given surveys hold a persisted untalliable verdict. */
export const untalliableKeysSql = (surveyKeys: readonly string[]): SqlQuery[] =>
  byKeysSql(
    `SELECT survey_key AS surveyKey FROM untalliable_survey
     WHERE survey_key IN ${JSON_KEY_SET}`,
    surveyKeys,
  );

/**
 * The identity of each survey's stored responses at or above its own slot
 * bound, records excluded. One statement per survey: the bounds differ, and
 * the read is a range seek on the survey's index entries either way. The
 * transaction identity rides along so the caller can tell a refuted response
 * from its neighbours sharing the same (role, credential).
 */
export const responseIdentitiesSql = (
  requests: readonly { surveyKey: string; fromSlot: number }[],
): SqlQuery[] =>
  requests.map(({ surveyKey, fromSlot }) => ({
    sql: `SELECT tx_hash AS txHash, response_index AS responseIndex,
                 survey_key AS surveyKey, role, credential, slot, countable
          FROM response WHERE survey_key = ? AND slot >= ?`,
    params: [surveyKey, fromSlot],
  }));

/**
 * What each of the given identity keys (`[role, credential]`) looks like among
 * a survey's stored responses below a slot: whether any row bears it, whether
 * a countable one does, and whether a countable one does whose proof was not
 * refuted. The keys ride as one JSON array and each is probed on the identity
 * index; a key with no row down there returns no line at all.
 */
export const settledResponseKeysSql = (
  requests: readonly {
    surveyKey: string;
    belowSlot: number;
    keys: readonly { role: number; credential: string }[];
  }[],
): SqlQuery[] =>
  requests.map(({ surveyKey, belowSlot, keys }) => ({
    sql: `SELECT j.value AS key,
                 MAX(r.countable) AS countable,
                 MAX(r.countable AND NOT EXISTS (
                   SELECT 1 FROM validated_response v
                   WHERE v.tx_hash = r.tx_hash
                     AND v.response_index = r.response_index
                     AND v.proof_ok = 0)) AS counted
          FROM json_each(?) j
          JOIN response r
            ON r.survey_key = ?
           AND r.role = json_extract(j.value, '$[0]')
           AND r.credential = json_extract(j.value, '$[1]')
           AND r.slot < ?
          GROUP BY j.value`,
    params: [
      JSON.stringify(keys.map((k) => [k.role, k.credential])),
      surveyKey,
      belowSlot,
    ],
  }));

/**
 * The identity of each of the given surveys' refuted responses, one line per
 * refuted row. `proof_ok = 0` is the WHERE clause of the partial index
 * `validated_response_refuted`, spelled the same way here so SQLite uses it:
 * the read then costs what the refutations are, not what participation is.
 */
export const refutedIdentitiesSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  byKeysSql(
    `SELECT survey_key AS surveyKey, tx_hash AS txHash,
            response_index AS responseIndex, role, credential
     FROM validated_response
     WHERE proof_ok = 0 AND survey_key IN ${JSON_KEY_SET}`,
    surveyKeys,
  );

/**
 * Surveys whose stored refutation stamp no longer matches their refuted rows.
 * A verdict is decided after the integration that projected the row, and may
 * land on a survey no segment touches, so without this the audited count
 * would stay stale until something else touched it. Driven from the refuted
 * partial index, plus the rows that stamped a refutation they no longer hold.
 */
export const STALE_REFUTED_SURVEYS = `
  SELECT s.survey_key AS surveyKey
  FROM (SELECT survey_key, COUNT(*) AS n FROM validated_response
        WHERE proof_ok = 0 GROUP BY survey_key) v
  JOIN survey_index s ON s.survey_key = v.survey_key
  WHERE s.refuted_count <> v.n
  UNION
  SELECT survey_key AS surveyKey FROM survey_index
  WHERE refuted_count > 0
    AND survey_key NOT IN (SELECT survey_key FROM validated_response
                           WHERE proof_ok = 0)`;

/** The banked settled counts of the given surveys. */
export const responseCountBanksSql = (
  surveyKeys: readonly string[],
): SqlQuery[] =>
  byKeysSql(
    `SELECT survey_key AS surveyKey, settled_count AS settledCount,
            settled_by_role AS settledByRole, below_slot AS belowSlot
     FROM response_count_bank WHERE survey_key IN ${JSON_KEY_SET}`,
    surveyKeys,
  );

/** The cached rows of the given tx hashes, from a hash-keyed cache table. */
export const cachedByTxHashSql = (
  table: string,
  column: string,
  txHashes: readonly string[],
): SqlQuery[] =>
  byKeysSql(
    `SELECT tx_hash AS txHash, ${column} FROM ${table} WHERE tx_hash IN ${JSON_KEY_SET}`,
    txHashes,
  );
