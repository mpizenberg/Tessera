/**
 * The CIP-179 metadatum ↔ CBOR seam now lives in `@tessera/tlock` (shared with
 * the serving tier and the verifier). Re-exported here so existing
 * `~/wallet/cbor` importers (`toTxMetadatum`, `metadatumToCbor`,
 * `cborToMetadatum`) keep their path.
 */

export * from "@tessera/tlock";
