/**
 * Dereferencing tamper-evident content anchors (URI + blake2b-256 hash).
 *
 * Used by external-content surveys (presentation document) and — at author
 * time — by voter rationales. The contract is the same: fetch the raw bytes,
 * check their `blake2b-256` against the on-chain hash, and only then trust the
 * payload. A mismatch or fetch failure is surfaced, never silently ignored.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import type { ContentAnchor, SurveyDefinition } from "cip-179";

import { bytesToHex } from "~/util/hex";
import {
  applyPresentation,
  parsePresentation,
  type Presentation,
} from "./presentation";

/** blake2b-256 (32-byte) digest of raw bytes. */
export function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 32 });
}

/** Resolve an anchor URI to an HTTP(S) URL, routing `ipfs://` through the gateway. */
export function resolveAnchorUri(uri: string, gateway: string): string {
  return uri.startsWith("ipfs://")
    ? gateway + uri.slice("ipfs://".length)
    : uri;
}

/**
 * Fetch the bytes behind an anchor and verify their hash. Throws on a network
 * failure or a hash mismatch (tamper / wrong document).
 */
export async function fetchAnchorBytes(
  anchor: ContentAnchor,
  gateway: string,
): Promise<Uint8Array> {
  const url = resolveAnchorUri(anchor.uri, gateway);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytesToHex(blake2b256(bytes)) !== bytesToHex(anchor.hash)) {
    throw new Error(
      "content hash mismatch — document doesn't match the anchor",
    );
  }
  return bytes;
}

/** Fetch + verify + JSON-parse an anchor's content. */
export async function fetchAnchorJson(
  anchor: ContentAnchor,
  gateway: string,
): Promise<unknown> {
  const bytes = await fetchAnchorBytes(anchor, gateway);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Load the presentation document for an external-content survey, or `null` if
 * the definition carries no content anchor (inline-content survey).
 */
export async function loadPresentation(
  def: SurveyDefinition,
  gateway: string,
): Promise<Presentation | null> {
  if (!def.contentAnchor) return null;
  return parsePresentation(await fetchAnchorJson(def.contentAnchor, gateway));
}

/**
 * Resolve a definition to its display form: enriched with off-chain labels when
 * an anchor is present and verifiable, otherwise the on-chain definition as-is.
 * Throws only when an anchor is present but can't be fetched/verified — callers
 * fall back to the on-chain definition and show an "unavailable" notice.
 */
export async function enrichDefinition(
  def: SurveyDefinition,
  gateway: string,
): Promise<SurveyDefinition> {
  const pres = await loadPresentation(def, gateway);
  return pres ? applyPresentation(def, pres) : def;
}
