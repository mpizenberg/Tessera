/**
 * Render structured problems in the active locale.
 *
 * The codec's validators (`validateResponse` / `validateDefinition`) return
 * structured `{ code, params }` problems instead of English prose, so the UI can
 * localize them. Each `code` (e.g. `"answer.optionIndexOutOfRange"`) is a leaf
 * under the `validation` catalog namespace; this maps it to
 * `validation.<code>` and interpolates its `params` via `t`. The Create form's
 * own problems take the same path, with `{where}` rendered from the labels the
 * form shows. Reactive: reads the locale signal through `t`, so rendered
 * problems re-translate on locale change.
 *
 * `validation.test.ts` asserts the catalog covers every declared code, so the
 * `MsgKey` casts below can never fall through to the raw-key fallback in practice.
 */

import type { ValidationProblem } from "cip-179";

import type { CreateProblem, FormField, FormProblem } from "~/domain/create";
import { t, type MsgKey } from "~/i18n";

/** Localized one-line rendering of a single structured validation problem. */
export function problemText(problem: ValidationProblem): string {
  return t(`validation.${problem.code}` as MsgKey, problem.params);
}

/** Localized rendering of a Create-page problem, the form's own or the codec's. */
export function createProblemText(problem: CreateProblem): string {
  return "field" in problem ? formProblemText(problem) : problemText(problem);
}

function formProblemText(problem: FormProblem): string {
  const field = FIELD_LABELS[problem.field]();
  const where =
    problem.question === undefined
      ? field
      : t("create.problemInQuestion", {
          question: t("create.questionChip", { n: problem.question + 1 }),
          field,
        });
  return t(`validation.${problem.code}` as MsgKey, {
    ...problem.params,
    where,
  });
}

/** The label the form shows on the input a problem points at. */
const FIELD_LABELS: Record<FormField, () => string> = {
  endEpoch: () => t("create.endEpochLabel"),
  revealRound: () => t("create.revealRoundLabel"),
  padding: () => t("create.paddingLabel"),
  min: () => t("create.min"),
  max: () => t("create.max"),
  step: () => t("create.step"),
  budget: () => t("create.budget"),
  minSelections: () =>
    t("create.minOf", { label: t("create.selectionsLabel") }),
  maxSelections: () =>
    t("create.maxOf", { label: t("create.selectionsLabel") }),
  minRanked: () => t("create.minOf", { label: t("create.rankedLabel") }),
  maxRanked: () => t("create.maxOf", { label: t("create.rankedLabel") }),
  customUri: () => t("create.customUriLabel"),
  customHash: () => t("create.customHashLabel"),
};
