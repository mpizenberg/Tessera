/**
 * Shared Koios read-path plumbing: a JSON fetch with a bounded retry + backoff
 * on transient failures, and a concurrency-capped fan-out. Both {@link
 * KoiosDataSource} and {@link KoiosTallyInputs} target the same rate-limited
 * Koios endpoints, so they share the same resilience discipline (finding 39).
 *
 * @module
 */

/** Per-request timeout: a stalled connection should fail, not hang forever. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Backoff before the single retry (ms). */
export const RETRY_BACKOFF_MS = 500;

/** One bounded retry: a transient blip is absorbed; a persistent failure still
 * surfaces after exactly one extra attempt (never a retry storm). */
export const MAX_RETRIES = 1;

/**
 * Max concurrent batch requests in a single fan-out. Koios rate-limits, and
 * firing every batch at once is exactly the shape that trips it (finding 39);
 * 6 keeps the pipe busy without stampeding.
 */
export const MAX_INFLIGHT_BATCHES = 6;

/**
 * HTTP statuses worth one retry: the explicit rate-limit / overload / gateway
 * signals an immediate retry can actually clear.
 *
 * `500` is deliberately **excluded**: Koios surfaces deterministic db-sync
 * failures (e.g. the word128 errors on some preview epochs, noted in
 * `tallyInputs.ts`) as a plain 500 that an immediate retry cannot fix — the
 * endpoints that hit it already degrade to null-means-retry-*next-refresh*, so
 * retrying here would only burn a second subrequest against the Worker budget.
 */
const RETRIABLE_STATUS = new Set([429, 502, 503, 504]);

/** A request timeout (`AbortSignal.timeout`) rejects with this DOMException name. */
const TIMEOUT_ERROR_NAME = "TimeoutError";

export interface KoiosFetchOptions {
  /** Path (not the full URL) used in the error message — keeps `Koios GET /tip → 502`. */
  label: string;
  /** Fires once per actual HTTP attempt (a retry counts as its own subrequest). */
  onRequest?: (() => void) | undefined;
  /** Backoff sleep; injectable so tests run instant. Defaults to a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isTimeout = (err: unknown): boolean =>
  err instanceof Error && err.name === TIMEOUT_ERROR_NAME;

/**
 * Fetch JSON from Koios with one bounded retry + backoff on a transient failure
 * ({@link RETRIABLE_STATUS} or a request timeout). A non-transient status (4xx,
 * 500) or a non-timeout throw fails immediately — no point retrying a
 * deterministic error. The caller owns the request timeout; this owns the retry.
 */
export async function koiosFetchJson<T>(
  url: string,
  init: RequestInit,
  opts: KoiosFetchOptions,
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt++) {
    opts.onRequest?.();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A request timeout is transient; any other throw (network refused, a
      // malformed request) is not worth an immediate retry.
      if (attempt < MAX_RETRIES && isTimeout(err)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
    if (res.ok) return (await res.json()) as T;
    if (attempt < MAX_RETRIES && RETRIABLE_STATUS.has(res.status)) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`Koios ${method} ${opts.label} → ${res.status}`);
  }
}

/**
 * Map `items` through `worker` with at most `limit` running at once, returning
 * `PromiseSettledResult`s in input order — a concurrency-capped
 * `Promise.allSettled`. A worker that throws yields a `rejected` entry rather
 * than sinking the whole fan-out, so callers keep the per-item "one failure
 * flags incomplete, the rest survive" semantics.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const lanes = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}
