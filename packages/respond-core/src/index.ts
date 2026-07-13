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
 *
 * No I/O, no framework — everything a codec type away from `cip-179`.
 *
 * @module
 */

export * from "./identity.js";
export * from "./roles.js";
export * from "./eligibility.js";
export * from "./draft.js";
