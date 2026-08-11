/**
 * `cardano-tessera-respond-ui` — the shared SolidJS answering UI for CIP-179 surveys.
 *
 * One implementation of the per-question body components — and of the reactive
 * state behind them ({@link createResponseDraft}) — consumed by both the Tessera
 * app and the `<tessera-respond>` widget so their answering behavior cannot
 * drift. The two host-specific deltas are injected via context:
 *
 * - {@link I18nContext} — an `I18n` accessor (strings, numbers, dates); both
 *   hosts provide respond-core's `createI18n`, so wording comes from one
 *   catalog;
 * - {@link ClassesContext} — the class-name map: identity by default (the
 *   widget's shadow-scoped stylesheet uses the literal names); the app
 *   provides its CSS-module lookup.
 *
 * @module
 */

export { QuestionBody } from "./bodies";
export { createResponseDraft } from "./response-draft";
export type { ResponseDraft, ResponseDraftSource } from "./response-draft";
export { I18nContext, useI18n } from "./i18n-context";
export {
  BODY_CLASS_NAMES,
  ClassesContext,
  IDENTITY_CLASSES,
  useClasses,
} from "./classes-context";
export type { BodyClassName, BodyClasses } from "./classes-context";
export {
  activateOnKey,
  clampStep,
  labelFor,
  range,
  ratingLevels,
  typeLabel,
  typeMeta,
} from "./shared";
