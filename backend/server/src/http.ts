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
  encodeSurveyCursor,
  fromJsonSafe,
  isSurveyListFilter,
  parseSurveyCursor,
  refKey,
  searchTermsOf,
  toJsonSafe,
} from "@tessera/core";
import type {
  BackendHealth,
  ChainTip,
  Cip179Records,
  GovLink,
} from "@tessera/core";
import { KoiosDataSource } from "@tessera/koios";

import type { ServerConfig } from "./config";
import type { BackendStore } from "./store";

/** How long `/api/tip` and `/api/pparams` reuse one upstream Koios call. */
const UPSTREAM_TTL_MS = 20_000;

/** Default and ceiling page sizes for the paged `/api/surveys` list. */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

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

  // Operational metrics for the app's health footer ({@link BackendHealth}).
  // Tiny body, no ETag games: refresh outcomes must be visible even when the
  // snapshot (and so the /api/surveys ETag) hasn't moved — e.g. a string of
  // failed refreshes — so this is always served fresh.
  app.get("/api/health", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const [fetchedAt, lastRefresh, last24h, validationBacklog] =
      await Promise.all([
        store.snapshotFetchedAt(),
        store.lastRefreshRun(),
        store.refreshTotalsSince(now - 86_400),
        store.incompleteValidationCount(),
      ]);
    const body: BackendHealth = {
      network: config.app.network,
      snapshot:
        fetchedAt !== null
          ? { fetchedAt, ageSeconds: now - fetchedAt }
          : null,
      lastRefresh,
      last24h,
      validationBacklog,
      limits: {
        koiosCallsPerRefresh: config.koiosCallsPerRefreshLimit,
        koiosCallsPerDay: config.koiosDailyLimit ?? null,
      },
    };
    c.header("Cache-Control", "no-store");
    return c.json(body as unknown as Record<string, unknown>);
  });

  // The paged Explore list, answered from the refresh-materialized
  // `survey_index` rows (no snapshot-blob decode). Query params mirror
  // `@tessera/core`'s `SurveyListParams`; semantics (ordering, filters,
  // counts, cursor) are the core `pageSurveyList` spec, implemented in SQL
  // (`surveyIndexSql.ts`). The finalized-cancelled overlay is baked into the
  // rows at refresh time, consistent with the snapshot the ETag versions.
  app.get("/api/surveys", async (c) => {
    const meta = await store.surveyIndexMeta();
    if (!meta) return c.json({ error: "snapshot not ready" }, 503);
    if (notModified(c, `W/"surveys-${meta.fetchedAt}"`))
      return c.body(null, 304);

    const limit = Number(c.req.query("limit") ?? DEFAULT_PAGE_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)
      return c.json({ error: "malformed limit" }, 400);
    const filter = c.req.query("filter") ?? "all";
    if (!isSurveyListFilter(filter))
      return c.json({ error: "unknown filter" }, 400);
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw ? parseSurveyCursor(cursorRaw) : null;
    if (cursorRaw && !cursor)
      return c.json({ error: "malformed cursor" }, 400);
    const credentials = (c.req.query("credentials") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const searchTerms = searchTermsOf(c.req.query("q"));

    // Stored values are already wire-form JSON text — the body is assembled
    // by parse-and-concatenate, never re-encoded through toJsonSafe.
    const tip = JSON.parse(meta.tip) as { epoch: number };
    const [rows, counts] = await Promise.all([
      store.surveyIndexPage({
        tipEpoch: tip.epoch,
        filter,
        credentials,
        searchTerms,
        cursor,
        // One extra row decides `nextCursor` without a second query.
        limit: limit + 1,
      }),
      store.surveyIndexCounts(tip.epoch, credentials, searchTerms),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      surveys: page.map((r) => JSON.parse(r.record) as unknown),
      cancellations: page.flatMap(
        (r) => JSON.parse(r.cancellations) as unknown[],
      ),
      govLinks: page.flatMap((r) => JSON.parse(r.govLinks) as unknown[]),
      tip,
      responseCounts: Object.fromEntries(
        page.map((r) => [r.surveyKey, r.responseCount]),
      ),
      finalizedCancelled: page
        .filter((r) => r.finalizedCancelled)
        .map((r) => r.surveyKey)
        .sort(),
      ...(meta.incomplete && { incomplete: true }),
      counts,
      nextCursor:
        rows.length > limit && last
          ? encodeSurveyCursor({
              bucket: last.bucket,
              slot: last.slot,
              key: last.surveyKey,
            })
          : null,
      fetchedAt: meta.fetchedAt,
      ageSeconds: now - meta.fetchedAt,
    });
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
