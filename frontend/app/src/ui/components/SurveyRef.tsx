/** A survey's "<txHash>:<index>" key, as a header shows it, with a copy button. */

import type { Component } from "solid-js";
import { CopyButton } from "~/ui/components/CopyButton";
import { t } from "~/i18n";
import css from "./SurveyRef.module.css";

export const SurveyRef: Component<{ keyStr: string }> = (props) => (
  <span class={css.ref}>
    <span title={t("surveyRef.title")} class={css.text}>
      {t("surveyRef.label", { ref: props.keyStr })}
    </span>
    <CopyButton text={props.keyStr} />
  </span>
);
