/**
 * Cloudflare Worker entry point: the same Hono app as `main.ts`, but with a D1
 * store and a Cron-triggered refresh instead of a long-lived process + interval
 * (`backend/ARCHITECTURE.md` §3, §10). Deployment config lives in
 * `wrangler.toml`; the D1 schema in `migrations/`.
 *
 * Workers hand `env` to each invocation instead of exposing a process-wide
 * environment, so config/store/app are built lazily on first use and memoized
 * per isolate (module scope can't do it — no env there).
 */

import type { ExecutionContext } from "hono";

import { loadConfig, type ServerConfig } from "./config";
import { createApp, type AppOptions } from "./http";
import { refreshSnapshot } from "./refresh";
import type { SnapshotStore } from "./store";
import { d1SnapshotStore, type D1Like } from "./store-d1";

interface Env {
  /** D1 binding (see wrangler.toml). */
  readonly DB: D1Like;
  readonly NETWORK?: string;
  readonly KOIOS_URL?: string;
  readonly KOIOS_TOKEN?: string;
  readonly SINCE?: string;
}

interface Wiring {
  config: ServerConfig;
  store: SnapshotStore;
  app: ReturnType<typeof createApp>;
}

let wiring: Wiring | null = null;

function init(env: Env): Wiring {
  if (!wiring) {
    const { DB, ...vars } = env;
    const config = loadConfig(vars);
    const store = d1SnapshotStore(DB);
    // The edge compresses responses itself — skip hono/compress (see AppOptions).
    const options: AppOptions = { compress: false };
    wiring = { config, store, app: createApp(config, store, options) };
  }
  return wiring;
}

/**
 * One refresh, with the upstream Koios calls counted. The count matters on
 * Workers: subrequests are capped per invocation (50 on the free plan, 1000
 * paid), and the refresh is the chatty path (label pages + metadata + cbor
 * batches). Logging it on every cron run keeps headroom visible in
 * `wrangler tail`.
 */
async function countedRefresh(
  config: ServerConfig,
  store: SnapshotStore,
): Promise<void> {
  const realFetch = globalThis.fetch;
  let subrequests = 0;
  globalThis.fetch = ((input, init) => {
    subrequests += 1;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await refreshSnapshot(config, store);
    console.log(`cron refresh ok: ${subrequests} Koios subrequests`);
  } catch (err) {
    console.error(
      `cron refresh failed after ${subrequests} subrequests ` +
        `(keeping last snapshot): ${String(err)}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return init(env).app.fetch(request, env, ctx);
  },
  scheduled(_event: unknown, env: Env, ctx: ExecutionContext): void {
    const { config, store } = init(env);
    ctx.waitUntil(countedRefresh(config, store));
  },
};
