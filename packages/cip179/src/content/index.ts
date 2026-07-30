/**
 * CIP-179 content anchors — dereferencing off-chain documents by hash.
 *
 * The one module in this package that performs network I/O on its own (the
 * tlock stack's beacon fetch aside): it turns a `{uri, hash}` anchor into the
 * bytes it commits to, verified against that hash before anything downstream
 * sees them. Callers get a document they can trust, or an error.
 *
 * @module
 */

export * from "./anchor.js";
