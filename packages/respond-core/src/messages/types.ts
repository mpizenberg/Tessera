/**
 * The i18n contract: the catalog shape every locale must satisfy, plus the
 * derived key/param types the factory exposes.
 *
 * `RespondMessages = typeof en` makes the English catalog the single source of
 * truth — each other locale (`fr`) is typed as `RespondMessages`, so the build
 * fails unless it defines *exactly* these keys, and `MsgKey` is the dotted-leaf
 * union `I18n.t` accepts (e.g. `"respond.skip"`, `"roles.drep"`).
 */

import type en from "./en.js";

/** The full catalog shape (three namespaces: `respond`, `roles`, `validation`). */
export type RespondMessages = typeof en;

/** Values fillable into `{token}` placeholders. */
export type Params = Record<string, string | number>;

/** Dotted leaf paths of the catalog — the keys `t` accepts. */
export type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

/** Every message key, e.g. `"respond.skip"` | `"roles.drep"`. */
export type MsgKey = Leaves<RespondMessages>;

/**
 * A deep-partial of the catalog — the shape of the host's `messages` override:
 * any subtree, down to individual leaves, may be supplied or omitted.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? T[K] : DeepPartial<T[K]>;
};
