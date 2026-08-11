/**
 * CIP-179 tally — the reference ruleset and content-addressed artifact.
 *
 * The stake-weighted tally rules, the JSON-safe wire codec, the canonical-JSON
 * encoding, and the `RULESET_DESCRIPTOR` / `rulesetHash()` that make a tally
 * result reproducible and hash-identical across implementations. These are the
 * only counting rules there are: an unweighted count is this tally with every
 * weight `1n`. Presentation is not here — turning the integer aggregates into
 * chart floats lives with its consumer.
 *
 * @module
 */

export * from "./weightedTally.js";
export * from "./tallyInput.js";
export * from "./wire.js";
export * from "./canonical.js";
export * from "./artifact.js";
