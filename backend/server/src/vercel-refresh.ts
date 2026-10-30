/**
 * Vercel function at `/cron/refresh`: one snapshot refresh per call. Vercel's
 * cron sends `Bearer $CRON_SECRET`; any other caller gets 401, and a missing
 * secret fails the instance rather than accepting `Bearer undefined`.
 */

import { getRequestListener } from "@hono/node-server";

import { loadConfig } from "./config";
import { refreshSnapshot } from "./refresh";
import { libsqlBackendStore, tursoClient } from "./store-libsql";

const secret = process.env["CRON_SECRET"];
if (!secret) throw new Error("CRON_SECRET is not set");
const config = loadConfig(process.env);
const store = libsqlBackendStore(tursoClient(process.env));

export default getRequestListener(async (request) => {
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response(null, { status: 401 });
  }
  try {
    await refreshSnapshot(config, store);
    return new Response(null, { status: 204 });
  } catch {
    // Logged and recorded in `refresh_run` by refreshSnapshot; the status
    // marks the cron invocation failed.
    return new Response(null, { status: 500 });
  }
});
