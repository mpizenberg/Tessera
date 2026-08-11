/**
 * `cardano-tessera-respond-ui` — the shared SolidJS answering UI for CIP-179 surveys.
 *
 * One implementation of the per-question body components — and of the reactive
 * state behind them ({@link createResponseDraft}) — consumed by both the Tessera
 * app and the `<tessera-respond>` widget so their answering behavior cannot
 * drift. The two host-specific deltas are injected via context:
 *
 * - {@link I18nContext} — an `I18n` accessor (strings, numbers, dates). Both
 *   hosts serve the same respond-core catalog by different routes: the widget
 *   builds one with `createI18n`, scoped to its `locale`/`messages` props; the
 *   app adapts its own reactive global, whose catalog spreads respond-core's,
 *   so app-level overrides reach the bodies and `createI18n`'s two bundled
 *   catalogs stay out of the app's entry chunk;
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
