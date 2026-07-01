/**
 * CIP-179 survey-link (Info Action anchor) parsing. Moved to `@tessera/core`
 * (shared with the serving tier); this re-export keeps the `~/domain/govLink`
 * import path stable for the proposal builder.
 */
export { GOV_LINK_KIND, parseCip179Link } from "@tessera/core";
export type { SurveyRefLite, Cip179LinkResult } from "@tessera/core";
