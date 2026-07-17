/**
 * Helpers shared by the per-question bodies and their host question cards.
 *
 * The label helpers (`labelFor`, `typeLabel`, `typeMeta`) take the injected
 * {@link I18n} explicitly so every consumer renders from the same catalog.
 * Everything else is pure.
 */

import type { OptionsOrCount, Question, RatingScale } from "cip-179";
import type { I18n } from "@tessera/respond-core";

export function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

/**
 * Keyboard handler for div-based radio/checkbox rows: Enter or Space activates
 * the row (Space's default page-scroll is suppressed), matching native controls.
 */
export function activateOnKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

export function clampStep(
  value: bigint,
  min: bigint,
  max: bigint,
  step: bigint,
): bigint {
  let v = value < min ? min : value > max ? max : value;
  if (step > 0n) v = min + ((v - min) / step) * step;
  return v;
}

/** An option's label, or a locale-formatted "Option N" fallback. */
export function labelFor(i18n: I18n, opts: OptionsOrCount, i: number): string {
  const fallback = () => i18n.t("respond.optionFallback", { n: i18n.n(i + 1) });
  return opts.type === "options" ? (opts.labels[i] ?? fallback()) : fallback();
}

const TYPE_LABEL_KEY = {
  custom: "respond.typeCustom",
  singleChoice: "respond.typeSingleChoice",
  multiSelect: "respond.typeMultiSelect",
  ranking: "respond.typeRanking",
  numericRange: "respond.typeNumericRange",
  pointsAllocation: "respond.typePointsAllocation",
  rating: "respond.typeRating",
} as const satisfies Record<Question["type"], string>;

export function typeLabel(i18n: I18n, type: Question["type"]): string {
  return i18n.t(TYPE_LABEL_KEY[type]);
}

/** The mono "type · bounds" line under a question chip. */
export function typeMeta(i18n: I18n, q: Question): string {
  switch (q.type) {
    case "multiSelect":
      return i18n.t("respond.typeMetaRange", {
        base: typeLabel(i18n, q.type),
        min: i18n.n(q.minSelections),
        max: i18n.n(q.maxSelections),
      });
    case "ranking":
      return i18n.t("respond.typeMetaRange", {
        base: typeLabel(i18n, q.type),
        min: i18n.n(q.minRanked),
        max: i18n.n(q.maxRanked),
      });
    case "numericRange": {
      // Bounds are bigints (possibly large) — shown verbatim, ungrouped.
      const { min, max } = q.constraints;
      return i18n.t("respond.typeMetaRange", {
        base: typeLabel(i18n, q.type),
        min: min.toString(),
        max: max.toString(),
      });
    }
    case "pointsAllocation":
      return i18n.t("respond.typeMetaBudget", {
        base: typeLabel(i18n, q.type),
        budget: i18n.n(q.budget),
      });
    default:
      return typeLabel(i18n, q.type);
  }
}

export function ratingLevels(
  scale: RatingScale,
): { value: bigint; label: string }[] | null {
  switch (scale.type) {
    case "labels":
      return scale.labels.map((l, i) => ({ value: BigInt(i), label: l }));
    case "count":
      return range(scale.count).map((i) => ({
        value: BigInt(i),
        label: String(i + 1),
      }));
    case "numeric": {
      const { min, max } = scale.constraints;
      const step = scale.constraints.step ?? 1n;
      if (step <= 0n || max < min) return null;
      const n = Number((max - min) / step) + 1;
      if (n < 1 || n > 12) return null;
      return range(n).map((i) => {
        const v = min + BigInt(i) * step;
        return { value: v, label: v.toString() };
      });
    }
  }
}
