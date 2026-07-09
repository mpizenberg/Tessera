/**
 * `@tessera/core` — the Tessera-specific application core shared by the browser
 * app, the serving tier, and the standalone verifier. Types + pure logic only;
 * no I/O, no wallet/CIP-30, no runtime coupling.
 *
 * Owns the Tessera seam only: the `DataSource` read interface, the Explore
 * list/health payloads (`source.ts`), keyset paging (`page.ts`), the
 * survey-list aggregation adapter (`surveyList.ts`), and portable config. The
 * reusable, cross-implementation surface — on-chain record shapes + pure
 * domain semantics, and the count/stake-weighted tally with its canonical,
 * content-addressed artifact — lives in the `cip-179` package and is imported
 * from its subpaths directly (`cip-179/domain`, `cip-179/tally`), never
 * re-exported through here (see `backend/ARCHITECTURE.md` §4/§6/§7).
 *
 * @module
 */

export * from "./source";
export * from "./surveyList";
export * from "./page";
export * from "./config";
