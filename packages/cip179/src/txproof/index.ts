/**
 * CIP-179 txproof — transaction CBOR to `TxProof`, plus bech32 / CIP-129 ids.
 *
 * Pure functions over already-fetched transaction bytes. Depends on
 * `@evolution-sdk/evolution` for CBOR decoding and Cardano address/id
 * primitives — an optional peer, loaded via dynamic import so codec-only
 * consumers never pull it in.
 *
 * @module
 */

export {};
