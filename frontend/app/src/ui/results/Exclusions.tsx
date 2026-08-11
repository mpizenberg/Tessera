// ----------------------------------------------------------------------------
// Results body (public, or revealed-sealed) + sealed reveal pipeline
// ----------------------------------------------------------------------------

/**
 * Why responses weren't counted — the audit panel and the count summary it
 * renders, derived from the flat excluded-record list.
 */

import { For, type Component } from "solid-js";
import type { ExcludedRecord, ExclusionKey } from "cip-179/domain";

import { t, n } from "~/i18n";
import css from "./results.module.css";

/** One row of the exclusion breakdown: a category with its rendered count. */
export interface ExclusionSummary {
  readonly key: ExclusionKey;
  readonly label: string;
  readonly hint: string;
  readonly count: number;
}

// Presentation for each exclusion category, kept in one place (`after-deadline`
// folds in the survey's end_epoch; the rest are static). The domain layer only
// emits the `ExclusionKey` — the English lives here.
function exclusionMeta(
  key: ExclusionKey,
  endEpoch: number,
): { label: string; hint: string } {
  switch (key) {
    case "after-deadline":
      return {
        label: t("survey.exclAfterDeadlineLabel"),
        hint: t("survey.exclAfterDeadlineHint", { epoch: endEpoch }),
      };
    case "invalid":
      return {
        label: t("survey.exclInvalidLabel"),
        hint: t("survey.exclInvalidHint"),
      };
    case "unproven":
      return {
        label: t("survey.exclUnprovenLabel"),
        hint: t("survey.exclUnprovenHint"),
      };
    case "superseded":
      return {
        label: t("survey.exclSupersededLabel"),
        hint: t("survey.exclSupersededHint"),
      };
    case "undecryptable":
      return {
        label: t("survey.exclUndecryptableLabel"),
        hint: t("survey.exclUndecryptableHint"),
      };
  }
}

const EXCLUSION_ORDER: readonly ExclusionKey[] = [
  "after-deadline",
  "invalid",
  "unproven",
  "superseded",
  "undecryptable",
];

/**
 * Derive the per-category count summary from the flat excluded records (the
 * single source of truth), in a fixed display order — dropping empty categories.
 */
export function summarizeExclusions(
  records: readonly ExcludedRecord[],
  endEpoch: number,
): ExclusionSummary[] {
  return EXCLUSION_ORDER.flatMap((key) => {
    const count = records.filter((r) => r.key === key).length;
    return count > 0 ? [{ key, ...exclusionMeta(key, endEpoch), count }] : [];
  });
}

/**
 * Expandable audit of why responses weren't counted. The categories provable
 * from on-chain data alone are always present; when the serving tier supplies
 * proof verdicts (`proofChecked`), credential-proof failures join them and the
 * copy says so — role membership and weights re-checked at the snapshot remain
 * finalization-side either way, and are called out as absent.
 */
export const ExclusionPanel: Component<{
  excluded: readonly ExclusionSummary[];
  endEpoch: number;
  proofChecked: boolean;
}> = (props) => {
  const max = (): number => Math.max(1, ...props.excluded.map((e) => e.count));
  return (
    <div class={css.exclPanel}>
      <div class={css.exclHead}>
        <span class={css.exclHeadTitle}>{t("survey.exclHeadTitle")}</span>
        <span class={css.exclHeadNote}>
          {props.proofChecked
            ? t("survey.exclHeadNoteProofs")
            : t("survey.exclHeadNote")}
        </span>
      </div>
      <div class={css.exclBody}>
        <For each={props.excluded}>
          {(e) => (
            <div class={css.exclRow}>
              <div class={css.exclRowMain}>
                <div class={css.exclRowLabel}>{e.label}</div>
                <div class={css.exclRowHint}>{e.hint}</div>
              </div>
              <div class={css.exclTrack}>
                <div
                  class={css.exclBar}
                  style={{ "--excl-pct": `${(e.count / max()) * 100}%` }}
                />
              </div>
              <span class={css.exclCount}>{n(e.count)}</span>
            </div>
          )}
        </For>
        <p class={css.exclFootnote}>
          {props.proofChecked
            ? t("survey.exclFootnoteProofs1")
            : t("survey.exclFootnote1")}{" "}
          <span class={css.exclFootnoteMono}>end_epoch {props.endEpoch}</span>{" "}
          {props.proofChecked
            ? t("survey.exclFootnoteProofs2")
            : t("survey.exclFootnote2")}
        </p>
      </div>
    </div>
  );
};
