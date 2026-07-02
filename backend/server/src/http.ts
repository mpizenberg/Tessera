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
import { cors } from "hono/cors";

import { toJsonSafe } from "@tessera/core";
import { KoiosDataSource } from "@tessera/koios";

import type { ServerConfig } from "./config";
import type { SnapshotStore } from "./store";

export function createApp(config: ServerConfig, store: SnapshotStore): Hono {
  const app = new Hono();
  // The read API is public, cookieless data meant for browser consumption from
  // a different origin (the app may be served separately from this serving
  // tier). Permissive CORS is the right default — there is no credential to
  // protect, and `IndexerDataSource` sends no cookies. Restrict `origin` here
  // if a deployment ever needs to.
  app.use("/api/*", cors());
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

  // Latest-epoch protocol parameters, so the browser can build a transaction
  // (`build({ fullProtocolParameters })`) without querying Koios itself — the
  // last thing that otherwise needed a client-side Koios token. Wire-encoded
  // (bigints → decimal strings) like the snapshot; a live read (pparams change
  // only at epoch boundaries, and tx building is infrequent).
  app.get("/api/pparams", async (c) => {
    const pparams = await source.protocolParameters();
    return c.json(toJsonSafe(pparams));
  });

  return app;
}
