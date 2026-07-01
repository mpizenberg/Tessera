/**
 * Local entry point: wire config → store → refresh loop → Hono app → Node HTTP
 * server. The Cloudflare entry point (later) reuses {@link createApp} with a D1
 * store and a Cron-triggered refresh instead of this process + interval.
 */

import { serve } from "@hono/node-server";

import { loadConfig } from "./config";
import { createApp } from "./http";
import { startRefreshLoop } from "./refresh";
import { openSnapshotStore } from "./store";

const config = loadConfig();
const store = openSnapshotStore(config.dbPath);

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
