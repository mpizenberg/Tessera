/** Vercel function serving the HTTP API from Turso. */

import { getRequestListener } from "@hono/node-server";

import { loadConfig } from "./config";
import { createApp } from "./http";
import { libsqlBackendStore, tursoClient } from "./store-libsql";

const app = createApp(
  loadConfig(process.env),
  libsqlBackendStore(tursoClient(process.env)),
);

export default getRequestListener(app.fetch);
