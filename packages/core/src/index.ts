/**
 * `@tessera/core` — the pure, portable heart shared by the browser app, the
 * serving tier, and any standalone verifier. Types + pure logic only; no I/O,
 * no wallet/CIP-30, no runtime coupling.
 *
 * Carries the data-model types + the `DataSource` seam, portable config,
 * gov-link parsing, hex, the wire codec, and the pure domain layer: survey
 * aggregation, response audit, count-based and stake-weighted tallies, and the
 * canonical, content-addressed tally artifact (see `backend/ARCHITECTURE.md`
 * §4/§6/§7).
 *
 * @module
 */

export * from "./source";
export * from "./page";
export * from "./dedupe";
export * from "./hex";
export * from "./govLink";
export * from "./config";
export * from "./wire";
export * from "./cancellation";
export * from "./proof";
export * from "./survey";
export * from "./audit";
export * from "./tally";
export * from "./weightedTally";
export * from "./tallyInput";
export * from "./answer";
export * from "./canonical";
export * from "./artifact";
