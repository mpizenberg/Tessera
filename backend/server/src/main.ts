/**
 * Local entry point: wire config → store → refresh loop → Hono app → Node HTTP
 * server. The Cloudflare entry point (`worker.ts`) reuses {@link createApp}
 * with a D1 store and a Cron-triggered refresh instead of this process +
 * interval. The `.env` overlay lives here (not in config.ts) because it is a
 * Node-process concern — Workers get their env injected per invocation.
 */

import { readFileSync } from "node:fs";

import { serve } from "@hono/node-server";

import { loadConfig } from "./config";
import { createApp } from "./http";
import { startRefreshLoop } from "./refresh";
import { openBackendStore } from "./store-node";

/**
 * Minimal `.env` loader (no dependency): `KEY=VALUE` lines, `#` comments, and
 * optional surrounding quotes. Real environment variables win over the file.
 * Absent file is fine — defaults + real env cover everything.
 */
function loadDotenv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv();
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
