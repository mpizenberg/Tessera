/**
 * The Cloudflare D1 {@link SqlDriver} for the Worker. Same schema as the node
 * driver, but created by the checked-in `migrations/*.sql` (applied with
 * `wrangler d1 migrations apply`) rather than at open time.
 *
 * D1 is typed structurally here (just the prepare/bind/run/all slice we use)
 * instead of pulling in `@cloudflare/workers-types`, whose global declarations
 * clash with `@types/node` in this package's single tsconfig.
 */

import type { BackendStore, SqlDriver, SqlQuery } from "./store";
import { sqlBackendStore } from "./store-sql";

/** The per-statement outcome slice we read: rows changed by a write. */
interface D1ResultMeta {
  readonly meta?: { readonly changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1ResultMeta>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** The slice of Cloudflare's `D1Database` this driver needs. */
export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  /** One round trip, one transaction; results are positional per statement. */
  batch(
    statements: D1PreparedStatement[],
  ): Promise<({ results: unknown[] } & D1ResultMeta)[]>;
}

function d1Driver(db: D1Like): SqlDriver {
  const bound = ({ sql, params }: SqlQuery): D1PreparedStatement => {
    const stmt = db.prepare(sql);
    return params.length > 0 ? stmt.bind(...params) : stmt;
  };

  return {
    async all<T>(query: SqlQuery): Promise<T[]> {
      const { results } = await bound(query).all<T>();
      return results;
    },
    async batchAll<T>(queries: readonly SqlQuery[]): Promise<T[][]> {
      if (queries.length === 0) return [];
      const outcomes = await db.batch(queries.map(bound));
      return outcomes.map((o) => (o.results ?? []) as T[]);
    },
    async batchWrite(queries: readonly SqlQuery[]): Promise<number[]> {
      if (queries.length === 0) return [];
      const outcomes = await db.batch(queries.map(bound));
      return outcomes.map((o) => o.meta?.changes ?? 0);
    },
    close() {
      // Nothing to release: D1 connections are managed by the runtime.
    },
  };
}

export function d1BackendStore(db: D1Like): BackendStore {
  return sqlBackendStore(d1Driver(db));
}
