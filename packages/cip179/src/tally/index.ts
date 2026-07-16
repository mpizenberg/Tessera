/**
 * CIP-179 tally — the reference ruleset and content-addressed artifact.
 *
 * The stake-weighted tally rules, the JSON-safe wire codec, the canonical-JSON
 * encoding, and the `RULESET_DESCRIPTOR` / `rulesetHash()` that make a tally
 * result reproducible and hash-identical across implementations. The unweighted
 * count-based *display* tally is not here — presentation lives with its consumer
 * in the frontend (`frontend/app/src/domain/displayTally.ts`).
 *
 * @module
 */

export * from "./weightedTally.js";
export * from "./tallyInput.js";
export * from "./wire.js";
export * from "./canonical.js";
export * from "./artifact.js";
