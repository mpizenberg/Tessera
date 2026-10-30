/**
 * Vercel function serving the HTTP API from Turso. Each instance reads its
 * config once; `vercel-output.ts` bakes `NETWORK` and `GIT_COMMIT` into it.
 */

import { getRequestListener } from "@hono/node-server";

import { loadConfig } from "./config";
import { createApp } from "./http";
import { libsqlBackendStore, tursoClient } from "./store-libsql";

const app = createApp(
  loadConfig(process.env),
  libsqlBackendStore(tursoClient(process.env)),
);

export default getRequestListener(app.fetch);
