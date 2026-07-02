/**
 * The HTTP contract `IndexerDataSource` will speak (`backend/ARCHITECTURE.md`
 * §2, §8). Routes mirror the `DataSource` seam one-to-one:
 *   - GET /api/snapshot     cached label-17 records + tip + gov links + freshness
 *   - GET /api/tip          near-live chain tip (short cache, see below)
 *   - GET /api/tx_status    live confirmation counts for just-submitted txs
 *   - GET /api/pparams      latest-epoch protocol parameters (short cache), so
 *                           the browser can build a tx without a Koios token
 *
 * `/api/tip` and `/api/pparams` sit behind a ~20 s memo: a burst of requests
 * (many tabs, a refresh storm) collapses into at most one upstream Koios call
 * per window, while staying fresh enough for their consumers — the tip moves
 * every ~20 s anyway, and pparams change only at epoch boundaries.
 *
 * A plain Hono app: the same object runs under `@hono/node-server` locally and,
 * unchanged, on a Cloudflare Worker later.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import { toJsonSafe } from "@tessera/core";
import { KoiosDataSource } from "@tessera/koios";

import type { ServerConfig } from "./config";
import type { SnapshotStore } from "./store";

/** How long `/api/tip` and `/api/pparams` reuse one upstream Koios call. */
const UPSTREAM_TTL_MS = 20_000;

/**
 * Memoize an async producer for `ttlMs`. The in-flight promise is shared, so a
 * burst of concurrent requests triggers a single upstream call; a rejection
 * evicts itself immediately so one failure isn't served for the whole window.
 */
function ttlCache<T>(
  ttlMs: number,
  produce: () => Promise<T>,
): () => Promise<T> {
  let value: Promise<T> | null = null;
  let expiresAt = 0;
  return () => {
    if (!value || Date.now() >= expiresAt) {
      const p = produce();
      value = p;
      expiresAt = Date.now() + ttlMs;
      p.catch(() => {
        if (value === p) value = null;
      });
    }
    return value;
  };
}

export function createApp(config: ServerConfig, store: SnapshotStore): Hono {
  const app = new Hono();
  // The read API is public, cookieless data meant for browser consumption from
  // a different origin (the app may be served separately from this serving
  // tier). Permissive CORS is the right default — there is no credential to
  // protect, and `IndexerDataSource` sends no cookies. Restrict `origin` here
  // if a deployment ever needs to.
  app.use("/api/*", cors());
  // Passthroughs go to Koios: tx status live (it's per-hash and post-submit),
  // tip and pparams behind the short memo above.
  const source = new KoiosDataSource(config.app);
  const cachedTip = ttlCache(UPSTREAM_TTL_MS, () => source.chainTip());
  const cachedPParams = ttlCache(UPSTREAM_TTL_MS, async () =>
    toJsonSafe(await source.protocolParameters()),
  );

  app.get("/health", (c) => c.json({ ok: true, network: config.app.network }));

  app.get("/api/snapshot", (c) => {
    const cached = store.get();
    if (!cached) return c.json({ error: "snapshot not ready" }, 503);
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      ...(cached.payload as Record<string, unknown>),
      fetchedAt: cached.fetchedAt,
      ageSeconds: now - cached.fetchedAt,
    });
  });

  app.get("/api/tip", async (c) => {
    const tip = await cachedTip();
    return c.json(tip);
  });

  app.get("/api/tx_status", async (c) => {
    const hashes = (c.req.query("hashes") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const statuses = await source.txStatus(hashes);
    return c.json(Object.fromEntries(statuses));
  });

  // Latest-epoch protocol parameters, so the browser can build a transaction
  // (`build({ fullProtocolParameters })`) without querying Koios itself — the
  // last thing that otherwise needed a client-side Koios token. Wire-encoded
  // (bigints → decimal strings) like the snapshot.
  app.get("/api/pparams", async (c) => {
    return c.json(await cachedPParams());
  });

  return app;
}
