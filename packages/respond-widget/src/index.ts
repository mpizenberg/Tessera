/**
 * `cardano-tessera-respond` — the embeddable `<tessera-respond>` answering
 * widget.
 *
 * The pieces the dev harness and the `solid-element` wrapper compose:
 *
 * - {@link RespondRoot}: the trimmed answering component (props in →
 *   `tessera:response` / `tessera:change` / `tessera:invalid` out);
 * - {@link adoptWidgetStyles}: shadow-root CSS delivery;
 * - {@link I18nContext} / {@link useI18n}: the injected-i18n seam;
 * - the public prop / event TypeScript contract.
 *
 * The `customElement("tessera-respond", …)` registration lives in `./element`,
 * which is also the lib-build entry.
 *
 * @module
 */

export { RespondRoot } from "./Respond";
export { adoptWidgetStyles, cssText } from "./styles";
export { I18nContext, useI18n } from "cardano-tessera-respond-ui";
export { RESPOND_EVENTS } from "./types";
export type {
  CredentialProof,
  ProofKeyKind,
  Responder,
  RespondChangeDetail,
  RespondInvalidDetail,
  RespondResult,
  TesseraRespondElement,
  TesseraRespondProps,
} from "./types";
