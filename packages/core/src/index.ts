/**
 * `@tessera/core` — the pure, portable heart shared by the browser app, the
 * serving tier, and any standalone verifier. Types + pure logic only; no I/O,
 * no wallet/CIP-30, no runtime coupling.
 *
 * This phase carries what the Koios read path needs (data-model types + the
 * `DataSource` seam, portable config, gov-link parsing, hex, and the wire
 * codec). The rest of the pure domain (audit/tally/survey/…) moves here when the
 * weighted-tally work lands (see `backend/ARCHITECTURE.md` §4).
 *
 * @module
 */

export * from "./source";
export * from "./hex";
export * from "./govLink";
export * from "./config";
export * from "./wire";
