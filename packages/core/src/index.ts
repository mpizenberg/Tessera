/**
 * `@tessera/core` — the Tessera-specific application core shared by the browser
 * app, the serving tier, and the standalone verifier. Types + pure logic only;
 * no I/O, no wallet/CIP-30, no runtime coupling.
 *
 * Owns the Tessera seam: the `DataSource` read interface, the Explore
 * list/health payloads (`source.ts`), keyset paging (`page.ts`), the
 * survey-list aggregation adapter (`surveyList.ts`), and portable config. The
 * reusable, cross-implementation surface — on-chain record shapes + pure
 * domain semantics, and the count/stake-weighted tally with its canonical,
 * content-addressed artifact — lives in the `cip-179` package (see
 * `backend/ARCHITECTURE.md` §4/§6/§7).
 *
 * @module
 */

// Re-export the reusable cip-179 domain + tally surface so existing
// `@tessera/core` importers (notably the app) keep resolving these names
// unchanged. The serving tier and verifier import the cip-179 subpaths directly.
export * from "cip-179/domain";
export * from "cip-179/tally";

export * from "./source";
export * from "./surveyList";
export * from "./page";
export * from "./config";
