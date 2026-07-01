/**
 * The HTTP contract `IndexerDataSource` will speak (`backend/ARCHITECTURE.md`
 * §2, §8). Routes mirror the `DataSource` seam one-to-one:
 *   - GET /api/snapshot     cached label-17 records + tip + gov links + freshness
 *   - GET /api/tip          live chain tip (immediacy — bypasses the cache)
 *   - GET /api/tx_status    live confirmation counts for just-submitted txs
 *
 * A plain Hono app: the same object runs under `@hono/node-server` locally and,
 * unchanged, on a Cloudflare Worker later.
 */

import { Hono } from "hono";

import { KoiosDataSource } from "@tessera/koios";

import type { ServerConfig } from "./config";
import type { SnapshotStore } from "./store";

export function createApp(config: ServerConfig, store: SnapshotStore): Hono {
  const app = new Hono();
  // Live passthroughs (tip / tx status) go straight to Koios for immediacy.
  const source = new KoiosDataSource(config.app);

  app.get("/health", (c) =>
    c.json({ ok: true, network: config.app.network }),
  );

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
    const tip = await source.chainTip();
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

  return app;
}
