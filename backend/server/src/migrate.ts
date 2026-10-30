/**
 * Bring the libSQL database at `TURSO_DATABASE_URL` (authenticated by
 * `TURSO_AUTH_TOKEN`) to the latest schema. The deploy runs it after a
 * successful build and before the new functions go live; migrations only add,
 * so the running deployment keeps working on a schema one step ahead.
 */

import { createClient } from "@libsql/client";

import { applyLibsqlMigrations } from "./store-libsql";

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL is not set");
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient(authToken ? { url, authToken } : { url });
try {
  const applied = await applyLibsqlMigrations(client);
  console.log(
    applied.length > 0
      ? `Applied ${applied.length} migration(s): ${applied.join(", ")}`
      : "Schema already up to date",
  );
} finally {
  client.close();
}
