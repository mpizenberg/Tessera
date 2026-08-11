/**
 * The `node:sqlite` {@link SqlDriver} for the local Node process — both dev and
 * self-hosting without Cloudflare. Kept in its own module so the Cloudflare
 * Worker bundle (which uses `store-d1.ts`) never imports `node:sqlite` —
 * Workers' nodejs_compat does not provide it.
 *
 * The schema is NOT defined here: both runtimes share the `migrations/*.sql`
 * files as the single source of truth. D1 applies them via `wrangler d1
 * migrations apply`; this driver applies them itself at open, tracking applied
 * files in a `schema_migration` table (the node twin of wrangler's
 * `d1_migrations`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { BackendStore, SqlDriver, SqlQuery } from "./store";
import { sqlBackendStore } from "./store-sql";

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

function nodeDriver(db: DatabaseSync): SqlDriver {
  // Prepared statements are reused across calls: a refresh writes thousands of
  // rows through the same statement. The key space is the set of query shapes,
  // bounded by the parameter counts the callers build.
  const prepared = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let stmt = prepared.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      prepared.set(sql, stmt);
    }
    return stmt;
  };
  const rowsOf = <T>({ sql, params }: SqlQuery): T[] =>
    statement(sql).all(...(params as SqlValue[])) as unknown as T[];

  return {
    async all<T>(q: SqlQuery): Promise<T[]> {
      return rowsOf<T>(q);
    },
    async batchAll<T>(queries: readonly SqlQuery[]): Promise<T[][]> {
      return queries.map((q) => rowsOf<T>(q));
    },
    async batchWrite(queries: readonly SqlQuery[]): Promise<number[]> {
      if (queries.length === 0) return [];
      db.exec("BEGIN");
      try {
        const changes = queries.map(({ sql, params }) =>
          Number(statement(sql).run(...(params as SqlValue[])).changes),
        );
        db.exec("COMMIT");
        return changes;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      prepared.clear();
      db.close();
    },
  };
}

export function openBackendStore(path: string): BackendStore {
  const db = new DatabaseSync(path);
  applyMigrations(db);
  return sqlBackendStore(nodeDriver(db));
}
