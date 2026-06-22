/**
 * CBOR (de)serialization of a CIP-179 {@link Metadatum} tree — part of the
 * wallet seam because evolution-sdk is the CBOR provider and stays isolated
 * here. The `cip-179` codec is deliberately CBOR-free; this is where a
 * metadatum tree becomes bytes and back.
 *
 * Used for sealed (tlock) responses: the timelock plaintext is the **CBOR of
 * the answers array**, so we encode the answers metadatum to bytes before
 * encrypting and decode the decrypted bytes back to a metadatum after reveal.
 *
 * Both `Metadatum` and evolution-sdk's `TransactionMetadatum` are the same
 * structural tree (bigint | string | Uint8Array | Map | array); the casts are
 * type-level only.
 */

import { CBOR, TransactionMetadatum } from "@evolution-sdk/evolution";
import type { Metadatum } from "cip-179";

/** Encode a metadatum tree to canonical CBOR bytes. */
export function metadatumToCbor(m: Metadatum): Uint8Array {
  return TransactionMetadatum.toCBORBytes(
    m as unknown as TransactionMetadatum.TransactionMetadatum,
    CBOR.CANONICAL_OPTIONS,
  );
}

/**
 * Decode the **first** CBOR item from `bytes` into a metadatum tree, ignoring
 * any trailing bytes. Sealed plaintext is CBOR followed by zero padding (to
 * `padding_size`); CBOR is self-delimiting, so decoding one item drops the pad
 * cleanly — and we can't simply trim trailing `0x00`, since a legitimate
 * trailing integer `0` is the same byte.
 */
export function cborToMetadatum(bytes: Uint8Array): Metadatum {
  const { item } = CBOR.decodeItemWithOffset(bytes, 0, CBOR.CANONICAL_OPTIONS);
  return item as unknown as Metadatum;
}
