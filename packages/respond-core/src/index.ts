/**
 * `cardano-tessera-respond-core` — the pure, framework-free core for answering CIP-179
 * surveys, shared by the Tessera app and the embeddable `<tessera-respond>`
 * widget.
 *
 * - `draft.ts`: response drafting (drafts → validated answers → `SurveyResponse`,
 *   the `decided()` progress gate, prefill for the edit/replace flow).
 * - `eligibility.ts`: the {@link Responder} role→credential map + which roles a
 *   responder may claim to a survey. Wallet-agnostic: deriving the map from a
 *   wallet is the host's job (respond-core never validates credentials).
 * - `i18n.ts`: the side-effect-free `createI18n` factory + bundled `en`/`fr`.
 * - `seal.ts`: the lazy sealed-submission wrapper (tlock + evolution CBOR).
 *
 * No I/O, no framework — everything a codec type away from `cip-179`.
 *
 * @module
 */

export * from "./eligibility.js";
export * from "./draft.js";
export * from "./i18n.js";
export * from "./seal.js";
