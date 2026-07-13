/**
 * Instance-scoped, side-effect-free i18n for the `<tessera-respond>` widget.
 *
 * Unlike the app's reactive global (`frontend/app/src/i18n/index.ts`), this
 * touches no `localStorage`, `navigator`, or `document` — a host embedding the
 * widget drives everything through props. `createI18n({ locale, messages })`
 * returns an {@link I18n} with:
 *
 * - `t` — look up a message for `locale`, interpolating `{token}` params;
 * - `n` — `Intl.NumberFormat(locale)` (1024 → "1,024" en · "1 024" fr);
 * - `d` — `Intl.DateTimeFormat(locale)` over unix **seconds** (the sealed
 *   reveal moment) — replaces the app's browser-locale `formatRevealDate`.
 *
 * Number/locale policy (plan §2.4, option 1 + 3): numbers/dates always follow
 * `locale`, even when strings fall back to English; and if `locale` resolves to
 * no bundled catalog *and* no `messages` override, a one-time dev-build warning
 * flags the misconfiguration (UI text will render in English).
 */

import type { ValidationProblem } from "cip-179";

import en from "./messages/en.js";
import fr from "./messages/fr.js";
import type {
  DeepPartial,
  MsgKey,
  Params,
  RespondMessages,
} from "./messages/types.js";

export type { DeepPartial, MsgKey, Params, RespondMessages };

/** The i18n surface the widget consumes. */
export interface I18n {
  /** Translate `key` for the locale, filling `{token}` placeholders. */
  t(key: MsgKey, params?: Params): string;
  /** Locale-aware number formatting (memoized per options). */
  n(value: number, options?: Intl.NumberFormatOptions): string;
  /** Locale-aware date/time from unix **seconds** (e.g. the reveal moment). */
  d(unixSeconds: number, options?: Intl.DateTimeFormatOptions): string;
}

export interface CreateI18nOptions {
  /** BCP-47 locale; default `"en"`. Drives strings, numbers, and dates. */
  locale?: string;
  /** Deep-merged string overrides, or an unshipped language's catalog. */
  messages?: DeepPartial<RespondMessages>;
}

/** The catalogs shipped in the bundle; every other locale comes via `messages`. */
const BUNDLED: Record<string, RespondMessages> = { en, fr };

/** Base language subtag, lowercased: `"fr-CA"` → `"fr"`, `"EN"` → `"en"`. */
function baseLanguage(locale: string): string {
  return locale.split("-")[0]!.toLowerCase();
}

/** Dev-build detection: Vite/Vitest define `import.meta.env`; Node/tsc don't. */
function isDevBuild(): boolean {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return env?.DEV === true;
}

/** Locales already warned about — keeps the missing-catalog warning one-time. */
const warnedLocales = new Set<string>();

function warnMissingCatalog(locale: string): void {
  if (!isDevBuild() || warnedLocales.has(locale)) return;
  warnedLocales.add(locale);
  console.warn(
    `tessera-respond: locale '${locale}' has no bundled catalog and no ` +
      "`messages`; UI text will render in English.",
  );
}

/** Deep-merge `override`'s defined leaves over `base`, returning a new tree. */
function deepMerge<T>(base: T, override?: DeepPartial<T>): T {
  if (!override) return base;
  const out: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const key of Object.keys(override)) {
    const o = (override as Record<string, unknown>)[key];
    if (o === undefined) continue;
    const b = (base as Record<string, unknown>)[key];
    out[key] =
      b !== null &&
      typeof b === "object" &&
      o !== null &&
      typeof o === "object" &&
      !Array.isArray(o)
        ? deepMerge(b, o as DeepPartial<typeof b>)
        : o;
  }
  return out as T;
}

/** Walk a dotted `key` through the catalog; undefined if absent or non-string. */
function lookup(catalog: RespondMessages, key: string): string | undefined {
  let cur: unknown = catalog;
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
 * Build an {@link I18n} bound to a locale and optional overrides. Everything is
 * resolved once at construction: the merged catalog and the format caches live
 * on the returned instance, so `t`/`n`/`d` are cheap to call in a render loop.
 */
export function createI18n(opts: CreateI18nOptions = {}): I18n {
  const locale = opts.locale ?? "en";
  const lang = baseLanguage(locale);
  const bundled = BUNDLED[lang];

  if (!bundled && !opts.messages) warnMissingCatalog(locale);

  // Unknown locale with no messages falls back to the English strings; numbers
  // and dates still follow `locale`.
  const catalog = deepMerge(bundled ?? en, opts.messages);

  const numberFormats = new Map<string, Intl.NumberFormat>();
  const dateFormats = new Map<string, Intl.DateTimeFormat>();

  return {
    t(key, params) {
      const tmpl = lookup(catalog, key) ?? lookup(en, key) ?? key;
      return params ? interpolate(tmpl, params) : tmpl;
    },

    n(value, options) {
      const cacheKey = options ? JSON.stringify(options) : "";
      let f = numberFormats.get(cacheKey);
      if (!f) {
        f = new Intl.NumberFormat(locale, options);
        numberFormats.set(cacheKey, f);
      }
      return f.format(value);
    },

    d(unixSeconds, options) {
      const cacheKey = options ? JSON.stringify(options) : "";
      let f = dateFormats.get(cacheKey);
      if (!f) {
        f = new Intl.DateTimeFormat(locale, options);
        dateFormats.set(cacheKey, f);
      }
      return f.format(new Date(unixSeconds * 1000));
    },
  };
}

/**
 * Localized one-line rendering of a cip-179 {@link ValidationProblem}: maps its
 * stable `code` to the `validation.<code>` catalog leaf and interpolates the
 * problem's `params` (the `{where}` locator is passed through verbatim). Mirrors
 * the app's `~/i18n/problem.ts`; the widget uses it to fill `tessera:invalid`'s
 * `messages` from the same catalog it renders everything else with.
 */
export function renderProblem(i18n: I18n, problem: ValidationProblem): string {
  return i18n.t(`validation.${problem.code}` as MsgKey, problem.params);
}
