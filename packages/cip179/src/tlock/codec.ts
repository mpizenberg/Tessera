/**
 * The `MetadatumCodec` port — canonical CBOR (de)serialization of a CIP-179
 * {@link Metadatum} tree, which the sealed-submission stack needs but cip-179
 * does **not** implement itself.
 *
 * The sealed wire format is the **CBOR of the answers array**, so seal/reveal
 * must encode a metadatum to bytes before encrypting and decode the decrypted
 * bytes back after reveal. Canonical metadatum CBOR has strict rules (definite
 * lengths, sorted keys, minimal ints) and real interop stakes with the spec and
 * the Elm reference, so it is injected rather than reimplemented:
 * `cip-179/evolution` provides an `@evolution-sdk/evolution`-backed codec; a
 * downstream implementer supplies their own stack's canonical encoder.
 *
 * @module
 */

import type { Metadatum } from "../index.js";

/** Canonical CBOR (de)serialization of a CIP-179 metadatum tree. */
export interface MetadatumCodec {
  /** Encode a metadatum tree to canonical CBOR bytes. */
  metadatumToCbor(m: Metadatum): Uint8Array;
  /**
   * Decode the **first** CBOR item from `bytes` into a metadatum tree, ignoring
   * any trailing bytes — sealed plaintext is CBOR followed by zero padding, and
   * CBOR is self-delimiting, so decoding one item drops the pad cleanly.
   */
  cborToMetadatum(bytes: Uint8Array): Metadatum;
}
