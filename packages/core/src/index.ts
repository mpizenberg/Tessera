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

// The reusable CIP-179 domain (on-chain record shapes + pure semantics) now
// lives in the `cip-179` package; re-exported here so existing `@tessera/core`
// importers keep resolving these names unchanged.
export * from "cip-179/domain";
export * from "cip-179/tally";

export * from "./source";
export * from "./surveyList";
export * from "./page";
export * from "./config";
