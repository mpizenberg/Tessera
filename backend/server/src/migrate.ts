/**
 * Bring the Turso database named by the environment to the latest schema. The
 * deploy runs it after a successful build and before the new functions go
 * live; migrations only add, so the running deployment keeps working on a
 * schema one step ahead.
 */

import { applyLibsqlMigrations, tursoClient } from "./store-libsql";

const client = tursoClient(process.env);
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
