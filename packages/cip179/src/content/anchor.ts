/**
 * Dereferencing tamper-evident content anchors (URI + blake2b-256 hash).
 *
 * Used by external-content surveys (presentation document), voter rationales,
 * and governance-action anchors. The contract is the same: fetch the raw bytes,
 * check their `blake2b-256` against the on-chain hash, and only then trust the
 * payload. A mismatch or fetch failure is surfaced, never silently ignored.
 *
 * `ipfs://` URIs are resolved by **racing several public gateways** with a
 * staggered start (the first fires immediately, each next ~1s later): the first
 * to return hash-verified bytes wins and the others are aborted. This is fast
 * when the leading gateway is healthy and resilient when it isn't, without
 * hammering all gateways at once. `https://` URIs are fetched directly.
 *
 * Every attempt is bounded in time and in bytes. A browser fetch happens on a
 * user gesture, but a server fetching on-chain-controlled URLs on a timer has
 * no such backstop: an endless response body or a socket that never closes
 * would be an unbounded cost handed to whoever posts an anchor.
 */

import { blake2b } from "@noble/hashes/blake2.js";

import { bytesToHex } from "../domain/hex.js";
import type { ContentAnchor } from "../types.js";

/**
 * Public gateways tried (concurrently, staggered) when resolving an `ipfs://`
 * URI. Content addressing means any gateway serving the CID returns identical
 * bytes, so racing several just buys speed + resilience — the first that returns
 * hash-verified bytes wins and the rest are aborted. Order ≈ preference.
 */
export const IPFS_GATEWAYS: readonly string[] = [
  "https://ipfs.io/ipfs/",
  "https://ipfs.blockfrost.dev/ipfs/",
  "https://dweb.link/ipfs/",
  "https://c-ipfs-gw.nmkr.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

/** Milliseconds between successive gateway attempts (first fires immediately). */
export const GATEWAY_STAGGER_MS = 1000;

/** Per-attempt timeout: a stalled connection must fail, not hang the caller. */
export const ANCHOR_TIMEOUT_MS = 10_000;

/**
 * Bytes an anchor document may weigh. Anchored documents are structured JSON
 * (CIP-108 metadata, a CIP-179 presentation) — kilobytes in practice — and the
 * hash can only be checked over the *whole* body, so the cap is what stops a
 * hostile URI from making the reader buffer without end.
 */
export const ANCHOR_MAX_BYTES = 1_000_000;

export interface AnchorFetchOptions {
  /** Caller-side cancellation (an overall budget, a component unmounting). */
  readonly signal?: AbortSignal | undefined;
  /** Per-attempt timeout; defaults to {@link ANCHOR_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Response-size cap; defaults to {@link ANCHOR_MAX_BYTES}. */
  readonly maxBytes?: number | undefined;
  /** IPFS gateways to race; defaults to {@link IPFS_GATEWAYS}. */
  readonly gateways?: readonly string[] | undefined;
  /** Delay between successive gateway attempts; defaults to {@link GATEWAY_STAGGER_MS}. */
  readonly staggerMs?: number | undefined;
  /**
   * Fires once per actual HTTP request. A caller on a metered runtime (the
   * Cloudflare Worker's per-invocation subrequest cap) counts them: one
   * `ipfs://` anchor can cost as many requests as gateways that get to fire.
   */
  readonly onRequest?: (() => void) | undefined;
}

/** blake2b-256 (32-byte) digest of raw bytes. */
export function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 32 });
}

function hashMatches(bytes: Uint8Array, expected: Uint8Array): boolean {
  return bytesToHex(blake2b256(bytes)) === bytesToHex(expected);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Resolve with the first fulfilled promise; reject only when all reject — a
 * `Promise.any` stand-in, kept because consumers compile this source directly
 * (the exports map points at `src/`) and the browser app's lib is ES2020.
 */
function firstSuccess<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remaining = promises.length;
    if (remaining === 0) return reject(new Error("no attempts"));
    for (const p of promises) {
      p.then(resolve, () => {
        if (--remaining === 0) reject(new Error("all attempts failed"));
      });
    }
  });
}

/**
 * Abort `target` whenever `source` aborts (chaining a caller's budget into an
 * attempt's own controller). Returns an unsubscribe so a settled attempt stops
 * holding a listener on a long-lived caller signal.
 */
function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = (): void => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/**
 * Read a response body, refusing to buffer past `maxBytes`. The declared
 * `content-length` short-circuits the obvious case; the streamed read is what
 * actually enforces the cap, since that header is the server's claim, not a
 * promise.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const tooBig = (): Error =>
    new Error(`content at ${url} exceeds ${maxBytes} bytes`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  const body = res.body;
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw tooBig();
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) throw tooBig();
      chunks.push(value);
    }
  } finally {
    // Releases the connection when the loop left early (cap hit, hash abort).
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Fetch + hash-verify a single URL under its own timeout and size cap. */
async function fetchVerified(
  url: string,
  expected: Uint8Array,
  opts: AnchorFetchOptions,
  outer: AbortSignal | undefined,
): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? ANCHOR_TIMEOUT_MS;
  const controller = new AbortController();
  const unforward = forwardAbort(outer, controller);
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`fetch ${url} timed out (${timeoutMs} ms)`)),
    timeoutMs,
  );
  try {
    opts.onRequest?.();
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    const bytes = await readCapped(res, opts.maxBytes ?? ANCHOR_MAX_BYTES, url);
    if (!hashMatches(bytes, expected)) {
      throw new Error(`content hash mismatch from ${url}`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    unforward();
  }
}

/**
 * Race the gateways for an `ipfs://` path (`<cid>/<rest>`), staggering the
 * start of each so a healthy leading gateway usually wins before the others
 * even fire. Resolves with the first hash-verified payload; rejects only if
 * every gateway fails. The winner aborts all the rest (and any pending delays).
 */
async function fetchFromGateways(
  path: string,
  expected: Uint8Array,
  opts: AnchorFetchOptions,
): Promise<Uint8Array> {
  const gateways = opts.gateways ?? IPFS_GATEWAYS;
  const stagger = opts.staggerMs ?? GATEWAY_STAGGER_MS;
  const race = new AbortController();
  const unforward = forwardAbort(opts.signal, race);
  const attempts = gateways.map(async (gateway, i) => {
    if (i > 0) await delay(i * stagger, race.signal);
    return fetchVerified(gateway + path, expected, opts, race.signal);
  });
  try {
    return await firstSuccess(attempts);
  } catch {
    throw new Error(
      `no IPFS gateway returned a matching document (tried ${gateways.length})`,
    );
  } finally {
    race.abort(); // cancel the losers + their pending delays
    unforward();
    // Swallow the now-rejected losers so they don't surface as unhandled.
    attempts.forEach((p) => void p.catch(() => {}));
  }
}

/**
 * Fetch the bytes behind an anchor and verify their hash. `ipfs://` anchors race
 * the public gateways; `https://` anchors are fetched directly. Throws if the
 * scheme is unsupported or no source yields bytes matching the anchor hash.
 */
export async function fetchAnchorBytes(
  anchor: ContentAnchor,
  opts: AnchorFetchOptions = {},
): Promise<Uint8Array> {
  if (anchor.uri.startsWith("ipfs://")) {
    return fetchFromGateways(
      anchor.uri.slice("ipfs://".length),
      anchor.hash,
      opts,
    );
  }
  // The URI is attacker-controllable on-chain data; only ever fetch over
  // `https:` (the hash check guarantees integrity, not that the URL is safe).
  // `data:`/`file:`/`javascript:` and plain `http:` are rejected outright. A
  // server-side caller inside a private network should additionally keep this
  // fetch off its internal routes — https alone does not stop an anchor
  // pointing at a hostname that resolves internally.
  if (!anchor.uri.startsWith("https://")) {
    throw new Error(`unsupported anchor URI scheme: ${anchor.uri}`);
  }
  return fetchVerified(anchor.uri, anchor.hash, opts, opts.signal);
}

/**
 * Fetch + hash-verify + JSON-parse an anchor's content. Throws if the anchor
 * can't be fetched or its bytes don't match the committed hash. Verification
 * happens here, so a returned value is safe to persist under the anchor hash.
 */
export async function fetchAnchorJson(
  anchor: ContentAnchor,
  opts: AnchorFetchOptions = {},
): Promise<unknown> {
  const bytes = await fetchAnchorBytes(anchor, opts);
  return JSON.parse(new TextDecoder().decode(bytes));
}
