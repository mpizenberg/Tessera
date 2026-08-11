/** Leaf bits shared by more than one results view. */

import { Show, type Component } from "solid-js";

import { t } from "~/i18n";
import css from "./results.module.css";

/**
 * Informational note shown above every results view: Tessera's tallies are
 * generic and indicative — a survey's own validity/allow-list/weighting rules
 * are the creator's to apply and interpret. In the final (artifact) view it
 * carries the "view raw responses" escape hatch on its right.
 */
export const InfoNote: Component<{ onShowRaw?: () => void }> = (props) => (
  <div class={css.disclaimer}>
    <span class={css.disclaimerBadge}>{t("survey.infoBadge")}</span>
    <span class={css.disclaimerText}>
      <b>{t("survey.infoNoteStrong")}</b> {t("survey.infoNote")}
    </span>
    <Show when={props.onShowRaw}>
      <button class={css.excludedToggle} onClick={() => props.onShowRaw!()}>
        {t("survey.weightedShowRaw")}
      </button>
    </Show>
  </div>
);
