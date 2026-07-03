/**
 * Pure rendering of decoded answer items. Moved to `@tessera/core` (shared
 * with the serving tier and verifier); this re-export keeps the
 * `~/domain/answer` import path stable.
 */
export { serializeAnswer, optionLabelOf, humanizeAnswer } from "@tessera/core";
