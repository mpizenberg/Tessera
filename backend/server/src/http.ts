/**
 * The HTTP contract `IndexerDataSource` speaks (`backend/ARCHITECTURE.md`
 * §2, §5.1, §8). Routes mirror the `DataSource` seam one-to-one:
 *   - GET /api/surveys                    Explore-list payload: surveys + tip +
 *                                         gov links + raw cancellations +
 *                                         deduped per-survey response counts +
 *                                         finalized-cancelled survey keys
 *   - GET /api/surveys/{txHash}/{index}   one survey's self-contained bundle:
 *                                         definition, ALL its responses (sealed
 *                                         ciphertexts included), cancellations
 *   - GET /api/responded?credentials=     survey keys with a response from any
 *                                         of the given credentials, each in the
 *                                         core `credentialKey` form
 *                                         ("key:<hex>" | "script:<hex>", comma-
 *                                         separated — a wallet controls both a
 *                                         payment and a stake credential, so one
 *                                         request carries the whole identity)
 *   - GET /api/tip                        near-live chain tip (short cache)
 *   - GET /api/tx_status                  live confirmation counts
 *   - GET /api/pparams                    latest-epoch protocol parameters, so
 *                                         the browser builds txs tokenlessly
 *
 * `/api/tip` and `/api/pparams` sit behind a ~20 s memo: a burst of requests
 * (many tabs, a refresh storm) collapses into at most one upstream Koios call
 * per window, while staying fresh enough for their consumers — the tip moves
 * every ~20 s anyway, and pparams change only at epoch boundaries.
 *
 * Transfer economics: responses are compressed (hex-heavy JSON shrinks several
 * fold), and every snapshot-derived route carries an `ETag` versioned by
 * `fetchedAt` — the body only changes when a refresh lands, so a browser
 * revalidation between refreshes is a 304 with no body. The per-page routes
 * slice the cached blob per request (it is ~tens of KB); if that ever shows up
 * in a profile, an in-memory per-isolate index (rebuilt when `fetchedAt`
 * changes) or the §6.5 tables replace it — don't build that early.
 *
 * A plain Hono app: the same object runs under `@hono/node-server` locally
 * (`main.ts`) and on a Cloudflare Worker (`worker.ts`).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";

import {
  credentialKey,
  fromJsonSafe,
  refKey,
  responseCounts,
  toJsonSafe,
} from "@tessera/core";
import type { ChainTip, Cip179Records, GovLink } from "@tessera/core";
import { KoiosDataSource } from "@tessera/koios";

import type { ServerConfig } from "./config";
import type { BackendStore } from "./store";

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

/** The decoded shape of the cached snapshot payload (built in `refresh.ts`). */
interface SnapshotBody {
  readonly records: Cip179Records;
  readonly tip: ChainTip;
  readonly govLinks: readonly GovLink[];
}

/**
 * Shared conditional-request handling for snapshot-derived routes. The body of
 * each is fully determined by which refresh produced it, so `fetchedAt` is the
 * version: `no-cache` makes the browser revalidate every time, and an unchanged
 * snapshot answers 304 with no body — checked BEFORE the blob is decoded, so a
 * revalidation costs no JSON parse. (`ageSeconds` drifts within a refresh
 * window — clients wanting live staleness should derive it from `fetchedAt`,
 * which is why the ETag deliberately ignores it. The ETag doesn't need to
 * encode the query/path either: caches key entries by full URL.)
 */
function notModified(c: Context, etag: string): boolean {
  c.header("Cache-Control", "no-cache");
  c.header("ETag", etag);
  return c.req.header("If-None-Match") === etag;
}

export interface AppOptions {
  /**
   * Compress bodies in-process (default). The Worker entry turns this off:
   * Cloudflare's edge compresses responses itself, and hono/compress relies on
   * a CompressionStream behaviour workerd doesn't reproduce.
   */
  readonly compress?: boolean;
}

export function createApp(
  config: ServerConfig,
  store: BackendStore,
  options: AppOptions = {},
): Hono {
  const app = new Hono();
  // The read API is public, cookieless data meant for browser consumption from
  // a different origin (the app may be served separately from this serving
  // tier). Permissive CORS is the right default — there is no credential to
  // protect, and `IndexerDataSource` sends no cookies. Restrict `origin` here
  // if a deployment ever needs to. `/health` is included because the app reads
  // it cross-origin too: `IndexerDataSource` checks the backend's network
  // against its own before trusting the snapshot.
  app.use("/api/*", cors());
  app.use("/health", cors());
  // Compress bodies when the client accepts it. The snapshot is hex-string-heavy
  // JSON, which deflates several fold; on Cloudflare the edge does this instead.
  if (options.compress !== false) app.use(compress());
  // Passthroughs go to Koios: tx status live (it's per-hash and post-submit),
  // tip and pparams behind the short memo above.
  const source = new KoiosDataSource(config.app);
  const cachedTip = ttlCache(UPSTREAM_TTL_MS, () => source.chainTip());
  const cachedPParams = ttlCache(UPSTREAM_TTL_MS, async () =>
    toJsonSafe(await source.protocolParameters()),
  );

  app.get("/health", (c) => c.json({ ok: true, network: config.app.network }));

  // The per-page routes decode the cached wire blob per request and slice
  // it — the simplest correct thing at today's snapshot size (see file header).
  app.get("/api/surveys", async (c) => {
    const cached = await store.get();
    if (!cached) return c.json({ error: "snapshot not ready" }, 503);
    // The finalized-cancelled overlay is not part of the ETag version: a
    // cancelled artifact emitted mid-refresh shows up at most one refresh
    // interval late (the next cron bumps `fetchedAt`), and keeping the ETag
    // snapshot-only keeps the 304 path free of store queries.
    if (notModified(c, `W/"surveys-${cached.fetchedAt}"`))
      return c.body(null, 304);
    const { records, tip, govLinks } = fromJsonSafe(
      cached.payload,
    ) as SnapshotBody;
    const now = Math.floor(Date.now() / 1000);
    return c.json(
      toJsonSafe({
        surveys: records.surveys,
        cancellations: records.cancellations,
        govLinks,
        tip,
        // Counted with the same core dedupe rule the client audit runs, so the
        // list's numbers and a survey page's tally agree by construction.
        responseCounts: responseCounts(records.responses),
        // Surveys finalized as cancelled: the scan can't verify a closed
        // survey's cancellation (proof: null), so the artifact's verdict rides
        // along or Explore would show a cancelled-then-closed survey as
        // "Ended" (finding 19). Sorted for a deterministic body.
        finalizedCancelled: [...(await store.finalizedCancelledKeys())].sort(),
        ...(records.incomplete !== undefined && {
          incomplete: records.incomplete,
        }),
        fetchedAt: cached.fetchedAt,
        ageSeconds: now - cached.fetchedAt,
      }) as Record<string, unknown>,
    );
  });

  app.get("/api/surveys/:txHash/:index", async (c) => {
    const cached = await store.get();
    if (!cached) return c.json({ error: "snapshot not ready" }, 503);
    const txHash = c.req.param("txHash").toLowerCase();
    const index = Number(c.req.param("index"));
    if (!/^[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(index) || index < 0)
      return c.json({ error: "malformed survey ref" }, 404);
    if (notModified(c, `W/"survey-${cached.fetchedAt}"`))
      return c.body(null, 304);
    const { records, tip } = fromJsonSafe(cached.payload) as SnapshotBody;
    const key = `${txHash}:${index}`;
    const survey = records.surveys.find((s) => refKey(s.ref) === key);
    if (!survey) return c.json({ error: `unknown survey ${key}` }, 404);
    const now = Math.floor(Date.now() / 1000);
    return c.json(
      toJsonSafe({
        survey,
        responses: records.responses.filter(
          (r) => refKey(r.response.surveyRef) === key,
        ),
        cancellations: records.cancellations.filter(
          (x) => refKey(x.target) === key,
        ),
        tip,
        fetchedAt: cached.fetchedAt,
        ageSeconds: now - cached.fetchedAt,
      }) as Record<string, unknown>,
    );
  });

  app.get("/api/responded", async (c) => {
    const cached = await store.get();
    if (!cached) return c.json({ error: "snapshot not ready" }, 503);
    if (notModified(c, `W/"responded-${cached.fetchedAt}"`))
      return c.body(null, 304);
    const wanted = new Set(
      (c.req.query("credentials") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    // Raw responses, no dedupe/validity filter: this feeds "surveys I answered"
    // flags, where any response attempt counts (mirrors the seam contract).
    const { records } = fromJsonSafe(cached.payload) as SnapshotBody;
    const surveyKeys = new Set<string>();
    for (const r of records.responses) {
      if (wanted.has(credentialKey(r.response.credential))) {
        surveyKeys.add(refKey(r.response.surveyRef));
      }
    }
    return c.json({
      surveyKeys: [...surveyKeys],
      fetchedAt: cached.fetchedAt,
    });
  });

  // Final tally artifacts (§7): immutable, content-addressed. The stored JSON
  // text is served verbatim (byte identity with the hash), with a strong ETag
  // and immutable caching — once emitted, the body never changes.
  const serveArtifact = (
    c: Context,
    row: { artifact: string; artifactHash: string } | null,
  ): Response => {
    if (!row) return c.json({ error: "no artifact" }, 404);
    const etag = `"${row.artifactHash}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
    return c.body(row.artifact, 200, { "Content-Type": "application/json" });
  };

  app.get("/api/surveys/:txHash/:index/artifact", async (c) => {
    const txHash = c.req.param("txHash").toLowerCase();
    const index = Number(c.req.param("index"));
    if (!/^[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(index) || index < 0)
      return c.json({ error: "malformed survey ref" }, 404);
    return serveArtifact(c, await store.artifactBySurvey(`${txHash}:${index}`));
  });

  app.get("/api/artifacts/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash))
      return c.json({ error: "malformed artifact hash" }, 404);
    return serveArtifact(c, await store.artifactByHash(hash));
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
