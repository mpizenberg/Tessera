/**
 * CIP-179 — On-Chain Surveys and Polls.
 *
 * A pure, side-effect-free TypeScript library for the CIP-179 metadata format
 * (metadata label 17). It converts between ergonomic domain types and a generic
 * Cardano {@link Metadatum} tree, and validates structures. It performs no I/O
 * and no CBOR (de)serialization: serialize the resulting metadatum with the
 * Cardano library of your choice.
 *
 * @module
 */

export * from "./constants.js";
export * from "./errors.js";
export * from "./metadatum.js";
export * from "./types.js";
export * from "./encode.js";
export * from "./decode.js";
export * from "./validate.js";
