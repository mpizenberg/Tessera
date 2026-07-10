/**
 * CIP-179 txproof — interpret transaction CBOR into a `TxProof`.
 *
 * `decodeTxProof` extracts the mechanism-A (required signers + native scripts)
 * and mechanism-B (governance vote bindings) evidence a credential proof is
 * checked against, from the library-neutral {@link DecodedTx} an injected
 * {@link TxProofCodec} produces — no Cardano-serialization library is imported
 * here. Wire `cip-179/evolution` (or your own stack's adapter) into it and into
 * the bech32 `stakeAddress` / `drepId` id encoders.
 *
 * @module
 */

export * from "./codec.js";
export * from "./txProof.js";
