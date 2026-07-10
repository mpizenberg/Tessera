/**
 * The app's evolution-sdk-backed CBOR seam. cip-179 keeps its metadatum codec
 * injectable (`MetadatumCodec`); this app runs on the evolution stack, so it
 * binds the `cip-179/evolution` adapter once here — the metadatum ↔ bytes
 * helpers (`metadatumToCbor`, `cborToMetadatum`), the `toTxMetadatum` write-path
 * bridge, and `evolutionCodec` to inject into the sealed seal/reveal path. Kept
 * behind `~/wallet/cbor` so this stays the single place the app names evolution
 * for CBOR, and lazily imported by its consumers (evolution is heavy).
 */

export {
  cborToMetadatum,
  evolutionCodec,
  metadatumToCbor,
  toTxMetadatum,
} from "cip-179/evolution";
