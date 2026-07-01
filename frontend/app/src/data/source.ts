/**
 * The data-source seam types. Moved to `@tessera/core` (the record types +
 * `DataSource` interface are shared by the app, the serving tier, and the
 * verifier); this re-export keeps the `~/data/source` import path stable.
 */
export type * from "@tessera/core";
