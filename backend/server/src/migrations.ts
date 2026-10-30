/**
 * The schema's history: the `migrations/*.sql` files, applied in name order,
 * each in its own transaction together with its row in `schema_migration`.
 * Every driver that migrates runs this same list against that same table; what
 * a driver owns is only how it opens a transaction.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export const CREATE_MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`;

export const APPLIED_MIGRATIONS = "SELECT name FROM schema_migration";

/** Binds: (name, appliedAtMs). */
export const RECORD_MIGRATION =
  "INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)";

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/** The migrations `applied` does not list yet, in the order they apply. */
export function pendingMigrations(applied: ReadonlySet<string>): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && !applied.has(name))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
    }));
}
