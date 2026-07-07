/**
 * CIP-179 txproof — transaction CBOR to `TxProof`, plus bech32 / CIP-129 ids.
 *
 * Pure functions over already-fetched transaction bytes: `decodeTxProof`
 * extracts the mechanism-A (required signers + native scripts) and mechanism-B
 * (governance vote bindings) evidence a credential proof is checked against,
 * and the bech32 helpers render stake / DRep / governance-action ids.
 *
 * Depends on `@evolution-sdk/evolution` for CBOR decoding and Cardano
 * address/id primitives — an optional peer, loaded via dynamic import so
 * codec-only consumers never pull it in.
 *
 * @module
 */

export * from "./bech32.js";
export * from "./txProof.js";
