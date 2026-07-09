/**
 * The data-source seam types the app's data layer speaks, grouped at one stable
 * `~/data/source` path. Two honest sources: the `DataSource` interface and the
 * Explore list/health payloads are Tessera-specific (`@tessera/core`); the
 * on-chain record shapes they carry (`ChainTip`, `SurveyRecord`,
 * `ResponseRecord`, …) are the reusable CIP-179 surface (`cip-179/domain`).
 */
export type * from "@tessera/core";
export type * from "cip-179/domain";
