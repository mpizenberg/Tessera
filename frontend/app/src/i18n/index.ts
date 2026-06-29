/**
 * Tiny zero-dependency i18n core, built on Solid signals + the platform Intl API.
 *
 * Why no library: a reactive locale switch is a one-signal problem in Solid —
 * any `{t(...)}` in JSX reads the locale signal, so it re-renders for free when
 * the locale changes — and Intl already handles number/date formatting and
 * plural rules natively. See ./en.ts for the message-catalog convention.
 *
 *   import { t, n } from "~/i18n";
 *   <span>{t("onchainPreview.copy")}</span>
 *   <span>{t("onchainPreview.bytes", { size: n(1024) })}</span>  // EN "1,024 B" · FR "1 024 o"
 *
 * `en` is bundled (default + fallback); every other catalog is code-split and
 * fetched on demand the first time its locale is selected.
 */

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import en, { type Dict } from "./en";

/** Supported locales, each with its autonym (shown untranslated in the picker). */
export const LOCALES = [
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

/** Dotted leaf paths of the catalog, e.g. "onchainPreview.copy" — the keys `t` accepts. */
type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

export type MsgKey = Leaves<Dict>;
type Params = Record<string, string | number>;

const STORAGE_KEY = "tessera.locale";

function isLocale(x: unknown): x is Locale {
  return LOCALES.some((l) => l.code === x);
}

/** Lazy catalog loaders. `en` is already bundled, so it resolves synchronously. */
const LOADERS: Record<Locale, () => Promise<{ default: Dict }>> = {
  en: () => Promise.resolve({ default: en }),
  fr: () => import("./fr"),
};

function storedLocale(): Locale | undefined {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function detectLocale(): Locale {
  try {
    const lang = navigator.language.slice(0, 2).toLowerCase();
    if (isLocale(lang)) return lang;
  } catch {
    // navigator unavailable (non-browser context) — fall through to default
  }
  return "en";
}

const [localeSig, setLocaleSig] = createSignal<Locale>(
  storedLocale() ?? detectLocale(),
);
const [loaded, setLoaded] = createStore<Partial<Record<Locale, Dict>>>({ en });

/** The active locale (reactive accessor). */
export const locale = localeSig;

async function ensureLoaded(l: Locale): Promise<void> {
  if (loaded[l]) return;
  const mod = await LOADERS[l]();
  setLoaded(l, mod.default);
}

function setHtmlLang(l: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

/**
 * Switch locale: load its catalog (if not already), persist the choice, then
 * apply. Loading *before* flipping the signal avoids a flash of English while a
 * code-split catalog is in flight.
 */
export async function setLocale(l: Locale): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // storage unavailable — the choice just won't persist across reloads
  }
  await ensureLoaded(l);
  setLocaleSig(l);
  setHtmlLang(l);
}

/** Catalog for the active locale, falling back to `en` until it has loaded. */
function catalog(): Dict {
  return loaded[localeSig()] ?? en;
}

function lookup(dict: Dict, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

/**
 * Translate `key` for the active locale, filling `{placeholder}` tokens from
 * `params`. Reactive: reads the locale signal, so any `{t(...)}` in JSX updates
 * when the locale changes. Falls back to the English string, then the raw key,
 * if a catalog is mid-load or a message is somehow absent.
 */
export function t(key: MsgKey, params?: Params): string {
  const tmpl = lookup(catalog(), key) ?? lookup(en, key) ?? key;
  return params ? interpolate(tmpl, params) : tmpl;
}

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Locale-aware number formatting via Intl. Reactive (reads the locale signal):
 * 1024 → "1,024" in English, "1 024" in French. Formatters are memoized per
 * (locale, options) since constructing an Intl.NumberFormat is not free.
 */
export function n(value: number, options?: Intl.NumberFormatOptions): string {
  const loc = localeSig();
  const cacheKey = loc + (options ? JSON.stringify(options) : "");
  let f = formatters.get(cacheKey);
  if (!f) {
    f = new Intl.NumberFormat(loc, options);
    formatters.set(cacheKey, f);
  }
  return f.format(value);
}

// Reflect the initial locale on <html lang>, and warm its catalog: a no-op for
// the default `en`, or a code-split fetch for a remembered non-default locale.
setHtmlLang(localeSig());
void ensureLoaded(localeSig());
