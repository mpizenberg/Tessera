/**
 * `cardano-tessera-core` — the Tessera-specific application core shared by the browser
 * app, the serving tier, and the standalone verifier. Types + pure logic only;
 * no I/O, no wallet/CIP-30, no runtime coupling.
 *
 * Owns the Tessera seam only: the `DataSource` read interface (`source.ts`),
 * in-memory keyset paging over a full list payload (`page.ts`), the
 * survey-list aggregation adapter (`surveyList.ts`), and the read
 * configuration (`config.ts`). The HTTP contract's payload types and
 * constants, the client over it and the network calendar are the published
 * `cardano-tessera-client`; the reusable, cross-implementation surface —
 * on-chain record shapes + pure domain semantics, and the count/stake-weighted
 * tally with its canonical, content-addressed artifact — is the published
 * `cip-179`. Both are imported directly and never re-exported through here
 * (see `backend/ARCHITECTURE.md` §4 and `backend/TALLY-SPEC.md`).
 *
 * @module
 */

export * from "./source";
export * from "./surveyList";
export * from "./page";
export * from "./config";
