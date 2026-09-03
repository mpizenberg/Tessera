/**
 * Drand quicknet identity — the one chain a sealed survey can be revealed on.
 *
 * The bundled tlock client encrypts and decrypts against quicknet only, so a
 * sealed survey pinned to any other chain hash is undecryptable by every
 * conformant reader, forever. That verdict is a property of the definition
 * alone, which is why it lives here beside the other definition-derived
 * predicates rather than in the tlock stack that does the round arithmetic.
 */

import type { SurveyDefinition } from "../index.js";
import { hexToBytes } from "./hex.js";

/** Drand quicknet chain hash (hex) — matches the bundled tlock client. */
export const QUICKNET_CHAIN_HASH_HEX =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/** Drand quicknet chain hash (32 bytes), for a sealed survey's submission mode. */
export const QUICKNET_CHAIN_HASH = hexToBytes(QUICKNET_CHAIN_HASH_HEX);

/** Is this chain hash the quicknet chain we can encrypt/decrypt against? */
export function isQuicknet(chainHash: Uint8Array): boolean {
  if (chainHash.length !== QUICKNET_CHAIN_HASH.length) return false;
  return chainHash.every((b, i) => b === QUICKNET_CHAIN_HASH[i]);
}

/**
 * A sealed survey pinned to a drand chain other than quicknet. Its answers can
 * never be revealed, so a finalizer decides it untalliable and emits no
 * artifact, and a conformant UI blocks responding — a vote on it is a fee
 * spent on nothing. Distinct from {@link import("../index.js").isSurveyTalliable},
 * the spec-validity gate the tally ruleset pins: this verdict is outside the
 * ruleset, and a public survey is never affected.
 */
export function isSealedUnsupported(definition: SurveyDefinition): boolean {
  const mode = definition.submissionMode;
  return mode.type === "sealed" && !isQuicknet(mode.chainHash);
}
