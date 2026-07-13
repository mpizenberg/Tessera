/**
 * Render a cip-179 {@link ValidationProblem} in the active locale.
 *
 * The codec's validators (`validateResponse` / `validateDefinition`) return
 * structured `{ code, params }` problems instead of English prose, so the UI can
 * localize them. Each `code` (e.g. `"answer.optionIndexOutOfRange"`) is a leaf
 * under the `validation` catalog namespace; this maps it to
 * `validation.<code>` and interpolates its `params` via `t`. Reactive: reads the
 * locale signal through `t`, so rendered problems re-translate on locale change.
 *
 * `validation.test.ts` asserts the catalog covers every declared code, so the
 * `MsgKey` cast below can never fall through to the raw-key fallback in practice.
 */

import type { ValidationProblem } from "cip-179";

import { t, type MsgKey } from "~/i18n";

/** Localized one-line rendering of a single structured validation problem. */
export function problemText(problem: ValidationProblem): string {
  return t(`validation.${problem.code}` as MsgKey, problem.params);
}
