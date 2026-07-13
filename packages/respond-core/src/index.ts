/**
 * `@tessera/respond-core` — the pure, framework-free core for answering CIP-179
 * surveys, shared by the Tessera app and the embeddable `<tessera-respond>`
 * widget.
 *
 * - `draft.ts`: response drafting (drafts → validated answers → `SurveyResponse`,
 *   the `decided()` progress gate, prefill for the edit/replace flow).
 * - `identity.ts`: the slim {@link ResponderIdentity} + {@link WalletCredential}.
 * - `roles.ts`: wallet-derivable role/credential logic over `ResponderIdentity`.
 * - `eligibility.ts`: eligibility including host-trusted SPO/CC credentials.
 * - `i18n.ts`: the side-effect-free `createI18n` factory + bundled `en`/`fr`.
 * - `seal.ts`: the lazy sealed-submission wrapper (tlock + evolution CBOR).
 *
 * No I/O, no framework — everything a codec type away from `cip-179`.
 *
 * @module
 */

export * from "./identity.js";
export * from "./roles.js";
export * from "./eligibility.js";
export * from "./draft.js";
export * from "./i18n.js";
export * from "./seal.js";
