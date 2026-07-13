/**
 * `@tessera/respond-widget` — the embeddable `<tessera-respond>` answering
 * widget.
 *
 * Milestone 4 exports the pieces the dev harness (and, in milestone 6, the
 * `solid-element` wrapper) compose:
 *
 * - {@link RespondRoot}: the trimmed answering component (props in →
 *   `tessera:response` / `tessera:change` / `tessera:invalid` out);
 * - {@link adoptWidgetStyles}: shadow-root CSS delivery (§4);
 * - {@link I18nContext} / {@link useI18n}: the injected-i18n seam;
 * - the public prop / event TypeScript contract.
 *
 * The `customElement("tessera-respond", …)` registration and the `build.lib`
 * config land in milestone 6.
 *
 * @module
 */

export { RespondRoot } from "./Respond";
export { adoptWidgetStyles, cssText } from "./styles";
export { I18nContext, useI18n } from "./i18n-context";
export { RESPOND_EVENTS } from "./types";
export type {
  CredentialProof,
  ProofKeyKind,
  Responder,
  RespondChangeDetail,
  RespondInvalidDetail,
  RespondResult,
  TesseraRespondProps,
} from "./types";
