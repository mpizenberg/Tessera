/**
 * Cloudflare Worker entry point: the same Hono app as `main.ts`, but with a D1
 * store and a Cron-triggered refresh instead of a long-lived process + interval
 * (`backend/ARCHITECTURE.md` §3). Deployment config lives in
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
import type { BackendStore } from "./store";
import { d1BackendStore, type D1Like } from "./store-d1";

interface Env {
  /** D1 binding (see wrangler.toml). */
  readonly DB: D1Like;
  readonly NETWORK?: string;
  readonly KOIOS_URL?: string;
  readonly KOIOS_TOKEN?: string;
  readonly SINCE?: string;
  readonly WORKER_SUBREQUEST_CAP?: string;
  readonly KOIOS_DAILY_LIMIT?: string;
  readonly GIT_COMMIT?: string;
}

interface Wiring {
  config: ServerConfig;
  store: BackendStore;
  app: ReturnType<typeof createApp>;
}

let wiring: Wiring | null = null;

function init(env: Env): Wiring {
  if (!wiring) {
    const { DB, ...vars } = env;
    const config = loadConfig(vars);
    const store = d1BackendStore(DB);
    // The edge compresses responses itself — skip hono/compress (see AppOptions).
    const options: AppOptions = { compress: false };
    wiring = { config, store, app: createApp(config, store, options) };
  }
  return wiring;
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
    // Upstream requests are metered (and per-run stats persisted) inside
    // refreshSnapshot itself; the count tracks headroom against this
    // invocation's subrequest cap (50 on the free plan, 1000 paid) via
    // `wrangler tail` and the /api/health route. Failures are logged there too.
    ctx.waitUntil(refreshSnapshot(config, store).catch(() => {}));
  },
};
