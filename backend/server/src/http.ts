/**
 * The HTTP contract `IndexerDataSource` speaks (`backend/ARCHITECTURE.md`
 * §2, §5.1, §7). Routes mirror the `DataSource` seam one-to-one:
 *   - GET /api/surveys                    Explore-list payload: surveys + tip +
 *                                         gov links + raw cancellations +
 *                                         deduped per-survey response counts +
 *                                         per-survey final states
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
 *   - GET /api/responses/{txHash}         the responses that transaction
 *                                         carried — coordinates and identity,
 *                                         no records; how a mirror settles an
 *                                         optimistic row for its own submission
 *   - GET /api/tip                        near-live chain tip (short cache)
 *   - GET /api/tx_status                  live confirmation counts
 *   - GET /api/pparams                    latest-epoch protocol parameters, so
 *                                         the browser builds txs tokenlessly
 *
 * `/api/tip` sits behind a ~20 s memo: a burst of requests (many tabs, a refresh
 * storm) collapses into at most one upstream Koios call per window, and the tip
 * moves every ~20 s anyway. `/api/pparams` is keyed by epoch instead, because
 * that is when protocol parameters can change at all.
 *
 * Transfer economics: responses are compressed (hex-heavy JSON shrinks several
 * fold), and every snapshot-derived route carries an `ETag` versioned by
 * `fetchedAt` — the body only changes when a refresh lands, so a browser
 * revalidation between refreshes is a 304 with no body. Each route reads only
 * the rows it serves: the refresh materializes the snapshot into `survey_index`
 * and `response` rows, so no request cost scales with the whole corpus.
 *
 * A plain Hono app: the same object runs under `@hono/node-server` locally
 * (`main.ts`) and on a Cloudflare Worker (`worker.ts`).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";

import { toJsonSafe } from "cip-179/tally";
import {
  encodeResponseCursor,
  encodeSurveyCursor,
  isSurveyListFilter,
  parseResponseCursor,
  parseSurveyCursor,
  searchTermsOf,
  type BackendHealth,
} from "cardano-tessera-core";
import { KoiosDataSource } from "cardano-tessera-koios";

import type { ServerConfig } from "./config";
import { upstreamMeter } from "./meter";
import {
  snapshotListCounts,
  snapshotTip,
  sumUpstream,
  validationKey,
  type BackendStore,
  type SnapshotMeta,
  type SurveyIndexRow,
} from "./store";

/** How long `/api/tip` reuses one upstream Koios call. */
const UPSTREAM_TTL_MS = 20_000;

/** Default and ceiling page sizes for the paged `/api/surveys` list. */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/**
 * Responses per page of a survey bundle — fixed, with no request parameter to
 * override it. Every consumer of a bundle wants the whole response set (it is a
 * tally input, not a scrolling view), so a smaller page would only add round
 * trips and a larger one would unbound the read this page size exists to bound.
 */
const RESPONSES_PER_PAGE = 200;

/**
 * Upper bound on hashes one `/api/tx_status` request forwards to Koios. Real
 * submit flows have a handful of pending txs; this only rejects abusively
 * oversized lists (the actual DoS defense is the segregated token below —
 * comfort polling can't touch the refresh/finalize quota regardless).
 */
const MAX_TX_STATUS_HASHES = 20;

/**
 * Upper bound on credentials one request may filter by. A wallet controls a
 * payment and a stake credential, so real callers send two; the bound keeps an
 * abusive list from reaching the store, where it would become an `IN (…)` past
 * D1's 100-parameter cap.
 */
const MAX_CREDENTIALS = 20;

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

/**
 * Memoize an async producer against a key, recomputing only when the key
 * changes. Sharing and eviction work as in {@link ttlCache}; what differs is
 * what makes the value stale — a fact the caller can observe, rather than the
 * passage of time.
 */
export function keyedCache<K, T>(
  keyOf: () => Promise<K>,
  produce: () => Promise<T>,
): () => Promise<T> {
  let value: Promise<T> | null = null;
  let cachedKey: K | undefined;
  return async () => {
    const key = await keyOf();
    if (!value || key !== cachedKey) {
      const p = produce();
      value = p;
      cachedKey = key;
      p.catch(() => {
        if (value === p) value = null;
      });
    }
    return value;
  };
}

/**
 * The `credentials=` query list in core `credentialKey` form, or null when it
 * is oversized (the caller answers 400).
 */
function credentialsOf(c: Context): string[] | null {
  const list = (c.req.query("credentials") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > MAX_CREDENTIALS ? null : list;
}

/**
 * The `refs=` query list as survey keys (`"<txHash>:<index>"`), or null when a
 * ref is malformed or the list is oversized (the caller answers 400). Only the
 * canonical index form is accepted — a stored key spells its index without
 * leading zeros, so `:01` would silently name nothing.
 */
function refsOf(raw: string): string[] | null {
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0 || list.length > MAX_PAGE_LIMIT) return null;
  return list.every((key) => /^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(key))
    ? list
    : null;
}

/**
 * The wire form of a set of survey rows — what both selections of
 * `/api/surveys` (a filtered page, or the refs a caller names) answer with.
 * Stored values are already wire-form JSON text, so the body is assembled by
 * parse-and-concatenate, never re-encoded through toJsonSafe. Paging's own
 * `counts` and `nextCursor` ride on top of this.
 */
function surveyListBody(
  rows: readonly SurveyIndexRow[],
  meta: SnapshotMeta,
): Record<string, unknown> {
  return {
    surveys: rows.map((r) => JSON.parse(r.record) as unknown),
    cancellations: rows.flatMap(
      (r) => JSON.parse(r.cancellations) as unknown[],
    ),
    govLinks: rows.flatMap((r) => JSON.parse(r.govLinks) as unknown[]),
    tip: snapshotTip(meta),
    responseCounts: Object.fromEntries(
      rows.map((r) => [r.surveyKey, r.responseCount]),
    ),
    // Every row gets an entry, `{}` where nothing counts: a client must be
    // able to tell "no counted response" from "this source does not audit".
    countedByRole: Object.fromEntries(
      rows.map((r) => [
        r.surveyKey,
        JSON.parse(r.countedByRole) as Record<string, number>,
      ]),
    ),
    finalState: Object.fromEntries(
      rows
        .filter((r) => r.finalState !== null)
        .map((r) => [
          r.surveyKey,
          {
            state: r.finalState,
            ...(r.artifactHash !== null && { artifactHash: r.artifactHash }),
          },
        ]),
    ),
    ...(meta.incomplete && { incomplete: true }),
    fetchedAt: meta.fetchedAt,
    ageSeconds: Math.floor(Date.now() / 1000) - meta.fetchedAt,
  };
}

/**
 * Shared conditional-request handling for snapshot-derived routes. The body of
 * each is fully determined by which refresh produced it, so `fetchedAt` is the
 * version: `no-cache` makes the browser revalidate every time, and an unchanged
 * snapshot answers 304 with no body — checked BEFORE any row is read, so a
 * revalidation costs one envelope lookup. (`ageSeconds` drifts within a refresh
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
  // Passthroughs to Koios. `tip`/`pparams` carry the operator's Koios identity
  // (`config.app.koiosToken`) — the memos above cap them at one upstream call
  // per window and per epoch respectively, so they can't burn quota even though
  // `pparams` feeds the (necessary) submit flow. `tx_status` is uncached
  // comfort traffic (post-submit confirmation polling), so it goes through a
  // SEPARATE source with its own token (`config.passthroughKoiosToken`, default
  // unauthenticated): a flood of `/api/tx_status` can only exhaust that
  // isolated quota, never the identity refresh/validate/finalize rely on for
  // artifact *correctness*.
  // Serving-path Koios calls spend the same daily quotas the refresh does, so
  // they are metered too — a 24 h total summed from refresh runs alone would
  // report the operator's identity as quieter than it is. The drain runs after
  // the handler rather than from the hook: only there is there a request still
  // alive to keep the write from being cancelled.
  const meter = upstreamMeter(store);
  app.use(async (_c, next) => {
    try {
      await next();
    } finally {
      await meter
        .drain(Math.floor(Date.now() / 1000))
        .catch((err: unknown) =>
          console.warn(`upstream tally failed: ${String(err)}`),
        );
    }
  });
  const source = new KoiosDataSource(
    config.app,
    undefined,
    undefined,
    meter.hook("koios"),
  );
  const convenienceSource = new KoiosDataSource(
    config.app,
    () => config.passthroughKoiosToken,
    undefined,
    meter.hook("koios-passthrough"),
  );
  // The near-live fields are read fresh on every miss; only the tip's
  // `gov_action_lifetime` comes from the stored snapshot, and only while the
  // chain is still in the epoch that snapshot named. The route would otherwise
  // spend a second Koios call re-reading a parameter that is fixed for the
  // epoch — the one part of a "near-live" tip that cannot move.
  const cachedTip = ttlCache(UPSTREAM_TTL_MS, async () => {
    const meta = await store.snapshotMeta();
    return source.chainTip(meta ? snapshotTip(meta) : null);
  });
  // Protocol parameters are fixed within an epoch, so the epoch is the cache
  // key and a second read inside one could only return what is already held.
  // The epoch is this tier's own — the stored snapshot's — which costs a row
  // read instead of a Koios call and, for the one refresh interval after a
  // boundary, holds the previous epoch's parameters. Before the first snapshot
  // there is no epoch to key on: one read then serves until a refresh lands.
  const cachedPParams = keyedCache(
    async () => {
      const meta = await store.snapshotMeta();
      return meta ? snapshotTip(meta).epoch : null;
    },
    async () => toJsonSafe(await source.protocolParameters()),
  );

  app.get("/health", (c) => c.json({ ok: true, network: config.app.network }));

  // The 24 h aggregates only move when a refresh run lands (every run writes a
  // row, failures included — so a string of failed refreshes still re-keys
  // this) plus the serving-path tally buckets, which are near-zero. The latest
  // run's start is therefore the version, read for one row per hit instead of
  // the full 24 h scans. The hour bucket bounds the sliding window's drift for
  // the one state the run key can't see: a cron that stopped writing rows
  // entirely would otherwise serve its final 24 h totals forever.
  const cachedHealthAggregates = keyedCache(
    async () =>
      `${(await store.lastRefreshRun())?.startedAt ?? -1}:` +
      `${Math.floor(Date.now() / 3_600_000)}`,
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const [lastRefresh, runs, calls, scan] = await Promise.all([
        store.lastRefreshRun(),
        store.refreshTotalsSince(now - 86_400),
        store.upstreamTotalsSince(now - 86_400),
        store.scanState().then((bank) => bank.walker),
      ]);
      // Banked by the refresh; the live count only backs up runs that predate
      // the column (or whose own count failed).
      const validationBacklog =
        lastRefresh?.validationBacklog ??
        (await store.incompleteValidationCount());
      return { lastRefresh, runs, calls, validationBacklog, scan };
    },
  );

  // Operational metrics for the app's health footer ({@link BackendHealth}).
  // Tiny body, no ETag games: the snapshot age must stay live even when the
  // snapshot (and so the /api/surveys ETag) hasn't moved, so this is served
  // fresh — only the aggregates above are memoized per refresh generation.
  app.get("/api/health", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const [meta, { lastRefresh, runs, calls, validationBacklog, scan }] =
      await Promise.all([store.snapshotMeta(), cachedHealthAggregates()]);
    const body: BackendHealth = {
      network: config.app.network,
      commit: config.commit ?? null,
      snapshot: meta
        ? { fetchedAt: meta.fetchedAt, ageSeconds: now - meta.fetchedAt }
        : null,
      lastRefresh,
      scan: scan && {
        cursorSlot: scan.cursor?.slot ?? null,
        caughtUp: scan.caughtUp,
      },
      last24h: {
        ...runs,
        upstreamRequests: sumUpstream(calls),
        koiosCalls: calls.koios,
        passthroughCalls: calls["koios-passthrough"],
      },
      validationBacklog,
      quotas: {
        subrequestsPerInvocation: config.workerSubrequestCap ?? null,
        koiosCallsPerDay: config.koiosDailyLimit ?? null,
      },
    };
    c.header("Cache-Control", "no-store");
    return c.json(body as unknown as Record<string, unknown>);
  });

  // The paged Explore list, answered from the refresh-materialized
  // `survey_index` rows. Query params mirror `cardano-tessera-core`'s
  // `SurveyListParams`; semantics (ordering, filters, counts, cursor) are the
  // core `pageSurveyList` spec, implemented in SQL (`sqlBuilders.ts`). The
  // final-state overlay is baked into the rows at refresh time, consistent
  // with the snapshot the ETag versions.
  app.get("/api/surveys", async (c) => {
    const meta = await store.snapshotMeta();
    if (!meta) return c.json({ error: "snapshot not ready" }, 503);
    if (notModified(c, `W/"surveys-${meta.fetchedAt}"`))
      return c.body(null, 304);

    // Naming the surveys is a second selection, not a variant of the first: a
    // set of references has no order to page and no filter to count over, so
    // the paging parameters are refused rather than silently ignored. A ref
    // that names no stored row is simply absent from the answer — a mirror
    // asks for what it holds, and a rolled-back survey is legitimately gone.
    const refsRaw = c.req.query("refs");
    if (refsRaw !== undefined) {
      if (
        ["filter", "cursor", "q", "limit"].some(
          (param) => c.req.query(param) !== undefined,
        )
      )
        return c.json(
          { error: "refs is exclusive with filter, cursor, q and limit" },
          400,
        );
      const keys = refsOf(refsRaw);
      if (!keys) return c.json({ error: "malformed refs" }, 400);
      return c.json(surveyListBody(await store.surveyRowsByKeys(keys), meta));
    }

    const limit = Number(c.req.query("limit") ?? DEFAULT_PAGE_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)
      return c.json({ error: "malformed limit" }, 400);
    const filter = c.req.query("filter") ?? "all";
    if (!isSurveyListFilter(filter))
      return c.json({ error: "unknown filter" }, 400);
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw ? parseSurveyCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) return c.json({ error: "malformed cursor" }, 400);
    // A cursor minted against an older snapshot: still answer it (keyset order
    // is best-effort across generations), but tell the client to refresh page
    // one — rows may have crossed the boundary when their bucket changed.
    const staleCursor =
      cursor?.generation !== undefined && cursor.generation !== meta.fetchedAt;
    const credentials = credentialsOf(c);
    if (!credentials) return c.json({ error: "too many credentials" }, 400);
    const searchTerms = searchTermsOf(c.req.query("q"));

    const tip = snapshotTip(meta);
    // Without a search, every chip but `mine` comes banked in the envelope
    // already in hand, so the request pays only the indexed owner count — or
    // no counting query at all without credentials. A search (counts scope to
    // the matching set) or an unbanked envelope aggregates live.
    const banked = searchTerms.length === 0 ? snapshotListCounts(meta) : null;
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
      banked === null
        ? store.surveyIndexCounts(tip.epoch, credentials, searchTerms)
        : credentials.length === 0
          ? { ...banked, mine: 0 }
          : store
              .ownedSurveyCount(credentials)
              .then((mine) => ({ ...banked, mine })),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      ...surveyListBody(page, meta),
      ...(staleCursor && { resync: true }),
      counts,
      nextCursor:
        rows.length > limit && last
          ? encodeSurveyCursor({
              bucket: last.bucket,
              slot: last.slot,
              key: last.surveyKey,
              generation: meta.fetchedAt,
            })
          : null,
    });
  });

  // One survey's self-contained bundle, plus the per-response proof verdicts
  // validation already decided. Stored values are already wire-form JSON text,
  // so the body is assembled by parse-and-concatenate — the survey's own rows
  // and nothing else are read.
  app.get("/api/surveys/:txHash/:index", async (c) => {
    const meta = await store.snapshotMeta();
    if (!meta) return c.json({ error: "snapshot not ready" }, 503);
    const txHash = c.req.param("txHash").toLowerCase();
    const index = Number(c.req.param("index"));
    if (!/^[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(index) || index < 0)
      return c.json({ error: "malformed survey ref" }, 404);
    // One ETag for every page: a page is a function of the snapshot and of the
    // cursor, and the cursor travels in the URL the validator is stored against.
    if (notModified(c, `W/"survey-${meta.fetchedAt}"`))
      return c.body(null, 304);
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw ? parseResponseCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) return c.json({ error: "malformed cursor" }, 400);
    // A cursor from an older snapshot: answered from the current one, but
    // flagged, because a bundle is a tally input and a response that crossed
    // the boundary would silently change a result. The collector restarts.
    const staleCursor =
      cursor?.generation !== undefined && cursor.generation !== meta.fetchedAt;
    const key = `${txHash}:${index}`;
    const bundle = await store.surveyBundle(key, {
      cursor,
      // One extra row decides `nextCursor` without a second query.
      limit: RESPONSES_PER_PAGE + 1,
    });
    if (!bundle) return c.json({ error: `unknown survey ${key}` }, 404);
    const page = bundle.responses.slice(0, RESPONSES_PER_PAGE);
    const last = page[page.length - 1];
    // After the page, and narrowed to it: the survey's whole verdict set is the
    // one read left that would grow with participation.
    const pageKeys = new Set(
      page.map((r) => validationKey(r.txHash, r.responseIndex)),
    );
    const validated = await store.validatedForSurvey(
      key,
      page.map((r) => r.txHash),
    );
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      survey: JSON.parse(bundle.record) as unknown,
      responses: page.map((r) => JSON.parse(r.record) as unknown),
      cancellations: JSON.parse(bundle.cancellations) as unknown,
      govLinks: JSON.parse(bundle.govLinks) as unknown,
      tip: snapshotTip(meta),
      // Decided credential-proof verdicts only — an omitted key is *pending*,
      // and the client must render it as such, never as failed. Scoped to this
      // page's responses: a transaction can carry one the next page holds.
      verdicts: Object.fromEntries(
        validated
          .filter((r) => r.proofOk !== null)
          .map((r) => [validationKey(r.txHash, r.responseIndex), r.proofOk])
          .filter(([k]) => pageKeys.has(k as string)),
      ),
      nextCursor:
        bundle.responses.length > RESPONSES_PER_PAGE && last
          ? encodeResponseCursor({
              slot: last.slot,
              txHash: last.txHash,
              responseIndex: last.responseIndex,
              generation: meta.fetchedAt,
            })
          : null,
      ...(staleCursor && { resync: true }),
      fetchedAt: meta.fetchedAt,
      ageSeconds: now - meta.fetchedAt,
    });
  });

  app.get("/api/responded", async (c) => {
    const meta = await store.snapshotMeta();
    if (!meta) return c.json({ error: "snapshot not ready" }, 503);
    if (notModified(c, `W/"responded-${meta.fetchedAt}"`))
      return c.body(null, 304);
    const credentials = credentialsOf(c);
    if (!credentials) return c.json({ error: "too many credentials" }, 400);
    return c.json({
      surveyKeys: await store.respondedSurveyKeys(credentials),
      fetchedAt: meta.fetchedAt,
    });
  });

  // The responses one transaction carried. `/api/responded` answers membership
  // per credential, which cannot tell a replacement from the response it
  // superseded — a mirror holding an optimistic "pending" row for a submission
  // it made needs to know that *that transaction* was indexed. A well-formed
  // hash with no stored responses answers an empty list, never 404: "not
  // indexed yet" is the ordinary state this route reports, and its consumer
  // reads any non-2xx as an outage.
  app.get("/api/responses/:txHash", async (c) => {
    const meta = await store.snapshotMeta();
    if (!meta) return c.json({ error: "snapshot not ready" }, 503);
    const txHash = c.req.param("txHash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txHash))
      return c.json({ error: "malformed tx hash" }, 404);
    if (notModified(c, `W/"responses-${meta.fetchedAt}"`))
      return c.body(null, 304);
    return c.json({
      responses: await store.responsesByTx(txHash),
      fetchedAt: meta.fetchedAt,
    });
  });

  // Final tally artifacts (TALLY-SPEC §5): immutable, content-addressed. The
  // stored JSON text is served verbatim (byte identity with the hash), with a
  // strong ETag and immutable caching — once emitted, the body never changes.
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
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    // Cheap forwarding hygiene: never relay an oversized or non-hex list
    // upstream. (An empty list is fine — `txStatus([])` short-circuits to `{}`.)
    if (hashes.length > MAX_TX_STATUS_HASHES)
      return c.json({ error: "too many tx hashes" }, 400);
    if (!hashes.every((h) => /^[0-9a-f]{64}$/.test(h)))
      return c.json({ error: "malformed tx hash" }, 400);
    // Segregated identity: comfort polling is quota-isolated from the critical
    // Koios path (see `convenienceSource` above).
    const statuses = await convenienceSource.txStatus(hashes);
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
