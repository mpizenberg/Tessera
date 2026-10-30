/**
 * The libSQL {@link SqlDriver}, for a Turso database. A batch is one round
 * trip; a write batch is one transaction.
 *
 * The caller creates the client, so a deployment can pick the entry point that
 * suits it (`@libsql/client/web` reaches only remote databases and carries no
 * native code) and tests can use `@libsql/client` on `:memory:`.
 *
 * Opening a store never migrates, unlike the node driver: the deploy migrates
 * once with {@link applyLibsqlMigrations}, and the functions serving the store
 * only read and write rows.
 */

import type { Client, InArgs, InStatement } from "@libsql/client";

import {
  APPLIED_MIGRATIONS,
  CREATE_MIGRATION_TABLE,
  RECORD_MIGRATION,
  pendingMigrations,
} from "./migrations";
import type { BackendStore, SqlDriver, SqlQuery } from "./store";
import { sqlBackendStore } from "./store-sql";

const statement = ({ sql, params }: SqlQuery): InStatement => ({
  sql,
  args: params as InArgs,
});

function libsqlDriver(client: Client): SqlDriver {
  return {
    async all<T>(query: SqlQuery): Promise<T[]> {
      const { rows } = await client.execute(statement(query));
      return rows as unknown as T[];
    },
    async batchAll<T>(queries: readonly SqlQuery[]): Promise<T[][]> {
      if (queries.length === 0) return [];
      const results = await client.batch(queries.map(statement), "read");
      return results.map(({ rows }) => rows as unknown as T[]);
    },
    async batchWrite(queries: readonly SqlQuery[]): Promise<number[]> {
      if (queries.length === 0) return [];
      const results = await client.batch(queries.map(statement), "write");
      return results.map(({ rowsAffected }) => rowsAffected);
    },
    close() {
      client.close();
    },
  };
}

export function libsqlBackendStore(client: Client): BackendStore {
  return sqlBackendStore(libsqlDriver(client));
}

/**
 * Bring the database to the latest schema (`migrations.ts`). Returns the names
 * of the migrations it applied, in order.
 */
export async function applyLibsqlMigrations(client: Client): Promise<string[]> {
  await client.execute(CREATE_MIGRATION_TABLE);
  const { rows } = await client.execute(APPLIED_MIGRATIONS);
  const applied = new Set(rows.map((row) => String(row.name)));
  const names: string[] = [];
  for (const { name, sql } of pendingMigrations(applied)) {
    const tx = await client.transaction("write");
    try {
      await tx.executeMultiple(sql);
      await tx.execute({ sql: RECORD_MIGRATION, args: [name, Date.now()] });
      await tx.commit();
    } finally {
      tx.close();
    }
    names.push(name);
  }
  return names;
}
