/**
 * Local entry point: wire config → store → refresh loop → Hono app → Node HTTP
 * server. The package scripts load `.env` beneath the real environment.
 */

import { serve } from "@hono/node-server";

import { loadConfig } from "./config";
import { createApp } from "./http";
import { startRefreshLoop } from "./refresh";
import { openBackendStore } from "./store-node";

const config = loadConfig(process.env);
const store = openBackendStore(config.dbPath);

startRefreshLoop(config, store);
const app = createApp(config, store);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `Tessera backend → http://localhost:${info.port}  ` +
      `(network=${config.app.network}, koios=${config.app.koiosUrl}, ` +
      `token=${config.app.koiosToken ? "set" : "anonymous"}, ` +
      `refresh=${config.refreshSeconds}s, db=${config.dbPath})`,
  );
});
