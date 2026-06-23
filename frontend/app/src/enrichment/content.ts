/**
 * Dereferencing tamper-evident content anchors (URI + blake2b-256 hash).
 *
 * Used by external-content surveys (presentation document) and voter rationales.
 * The contract is the same: fetch the raw bytes, check their `blake2b-256`
 * against the on-chain hash, and only then trust the payload. A mismatch or
 * fetch failure is surfaced, never silently ignored.
 *
 * `ipfs://` URIs are resolved by **racing several public gateways** with a
 * staggered start (the first fires immediately, each next ~1s later): the first
 * to return hash-verified bytes wins and the others are aborted. This is fast
 * when the leading gateway is healthy and resilient when it isn't, without
 * hammering all gateways at once. `https://` URIs are fetched directly.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import type { ContentAnchor, SurveyDefinition } from "cip-179";

import { bytesToHex } from "~/util/hex";
import { GATEWAY_STAGGER_MS, IPFS_GATEWAYS } from "./providers";
import {
  applyPresentation,
  parsePresentation,
  type Presentation,
} from "./presentation";

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
 * Resolve with the first fulfilled promise; reject only when all reject (a
 * `Promise.any` stand-in, since the tsconfig targets ES2020).
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

/** Fetch + hash-verify a single URL, honouring an abort signal. */
async function fetchVerified(
  url: string,
  expected: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!hashMatches(bytes, expected)) {
    throw new Error(`content hash mismatch from ${url}`);
  }
  return bytes;
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
): Promise<Uint8Array> {
  const controller = new AbortController();
  const attempts = IPFS_GATEWAYS.map(async (gateway, i) => {
    if (i > 0) await delay(i * GATEWAY_STAGGER_MS, controller.signal);
    return fetchVerified(gateway + path, expected, controller.signal);
  });
  try {
    return await firstSuccess(attempts);
  } catch {
    throw new Error(
      `no IPFS gateway returned a matching document (tried ${IPFS_GATEWAYS.length})`,
    );
  } finally {
    controller.abort(); // cancel the losers + their pending delays
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
): Promise<Uint8Array> {
  if (anchor.uri.startsWith("ipfs://")) {
    return fetchFromGateways(anchor.uri.slice("ipfs://".length), anchor.hash);
  }
  // The URI is attacker-controllable on-chain data; only ever fetch over
  // `https:` (the hash check guarantees integrity, not that the URL is safe).
  // `data:`/`file:`/`javascript:` and plain `http:` are rejected outright.
  if (!anchor.uri.startsWith("https://")) {
    throw new Error(`unsupported anchor URI scheme: ${anchor.uri}`);
  }
  const controller = new AbortController();
  return fetchVerified(anchor.uri, anchor.hash, controller.signal);
}

/** Fetch + verify + JSON-parse an anchor's content. */
export async function fetchAnchorJson(anchor: ContentAnchor): Promise<unknown> {
  const bytes = await fetchAnchorBytes(anchor);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Load the presentation document for an external-content survey, or `null` if
 * the definition carries no content anchor (inline-content survey).
 */
export async function loadPresentation(
  def: SurveyDefinition,
): Promise<Presentation | null> {
  if (!def.contentAnchor) return null;
  return parsePresentation(await fetchAnchorJson(def.contentAnchor));
}

/**
 * Resolve a definition to its display form: enriched with off-chain labels when
 * an anchor is present and verifiable, otherwise the on-chain definition as-is.
 * Throws only when an anchor is present but can't be fetched/verified — callers
 * fall back to the on-chain definition and show an "unavailable" notice.
 */
export async function enrichDefinition(
  def: SurveyDefinition,
): Promise<SurveyDefinition> {
  const pres = await loadPresentation(def);
  return pres ? applyPresentation(def, pres) : def;
}
