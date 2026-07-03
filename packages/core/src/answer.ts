/**
 * Pure rendering of a single decoded answer item — both the machine-readable
 * form used in the CSV export and the human-readable form shown on the survey
 * results screen. No framework, no I/O; unit-testable in isolation.
 */

import type { AnswerItem, Question } from "cip-179";

/**
 * Stable, machine-readable serialization of one answer item for CSV export.
 * Indices are kept raw (0-based) so the column is a faithful record of the
 * on-chain payload; pair with the survey's labels to humanize. The format is a
 * contract consumers may parse, so keep separators stable.
 */
export function serializeAnswer(a: AnswerItem): string {
  switch (a.type) {
    case "singleChoice":
      return String(a.optionIndex);
    case "multiSelect":
      return a.optionIndices.join("|");
    case "ranking":
      return a.ranking.join(">");
    case "numeric":
      return a.value.toString();
    case "pointsAllocation":
      return a.allocations.map((p) => `${p.optionIndex}:${p.points}`).join("|");
    case "rating":
      return a.ratings.map((r) => `${r.optionIndex}:${r.rating}`).join("|");
    case "custom":
      return typeof a.value === "string" ? a.value : "[custom]";
  }
}

/**
 * Human-readable label for an option index, using the (possibly enriched)
 * definition's labels. Falls back to a 1-based "Option N" when labels aren't
 * present — count-mode questions, or external-content surveys whose
 * presentation document hasn't resolved.
 */
export function optionLabelOf(q: Question | undefined, index: number): string {
  if (q && "options" in q && q.options.type === "options") {
    return q.options.labels[index] ?? `Option ${index + 1}`;
  }
  return `Option ${index + 1}`;
}

/** Render a single answer item against its question, using option labels. */
export function humanizeAnswer(a: AnswerItem, q: Question | undefined): string {
  switch (a.type) {
    case "singleChoice":
      return optionLabelOf(q, a.optionIndex);
    case "multiSelect":
      return a.optionIndices.length === 0
        ? "(none selected)"
        : a.optionIndices.map((i) => optionLabelOf(q, i)).join(", ");
    case "ranking":
      return a.ranking
        .map((i, n) => `${n + 1}. ${optionLabelOf(q, i)}`)
        .join("  ›  ");
    case "numeric":
      return a.value.toString();
    case "pointsAllocation":
      return a.allocations
        .map((p) => `${optionLabelOf(q, p.optionIndex)}: ${p.points}`)
        .join(",  ");
    case "rating":
      return a.ratings
        .map((r) => `${optionLabelOf(q, r.optionIndex)}: ${r.rating}`)
        .join(",  ");
    case "custom":
      return typeof a.value === "string" ? a.value : "[custom value]";
  }
}
