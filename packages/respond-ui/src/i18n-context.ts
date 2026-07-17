/**
 * Solid context carrying the {@link I18n} instance down to every body.
 *
 * Both consumers provide it: the widget from its instance-scoped
 * `createI18n({ locale, messages })` props, the app from the same `createI18n`
 * driven by its reactive global locale. The context holds an **accessor**
 * (`() => I18n`) recreated by a memo when the locale changes; `useI18n` returns
 * a stable facade that delegates through it, so callers keep the plain
 * `i18n.t(...)` API while every call stays reactive to a locale switch.
 */

import { createContext, useContext, type Accessor } from "solid-js";
import type { I18n } from "@tessera/respond-core";

export const I18nContext = createContext<Accessor<I18n>>();

export function useI18n(): I18n {
  const get = useContext(I18nContext);
  if (!get) {
    throw new Error("useI18n must be used within an <I18nContext.Provider>");
  }
  return {
    t: (key, params) => get().t(key, params),
    n: (value, options) => get().n(value, options),
    d: (unixSeconds, options) => get().d(unixSeconds, options),
  };
}
