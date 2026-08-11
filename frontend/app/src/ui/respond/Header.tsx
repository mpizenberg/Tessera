/**
 * What sits above the form: the survey's identity and role picker, then the
 * banners that qualify what answering here means — already responded, sealed
 * until a drand round, or rendering with labels that couldn't be fetched.
 */

import { For, Show, type Component } from "solid-js";
import type { Role, SurveyDefinition } from "cip-179";
import type { SurveyAggregate } from "cip-179/domain";

import { formatRevealDate } from "~/tlock/drand";
import { fullRef, roleLabel, shortRef } from "~/ui/format";
import { t } from "~/i18n";
import css from "./respond.module.css";

export const SurveyHeader: Component<{
  s: SurveyAggregate;
  /** Display definition (enriched with off-chain labels for external content). */
  def: SurveyDefinition;
  pro: boolean;
  role: Role | null;
  respondable: Role[];
  onPickRole: (r: Role) => void;
}> = (props) => (
  <div class={css.header}>
    <div class={css.headerTop}>
      <span class={css.respondLabel}>{t("respond.respondLabel")}</span>
      {/* refText carries margin-left:auto, so no spacer node is needed. When
          pro is off, "Responding as" / title don't depend on the spacer. */}
      <Show when={props.pro}>
        <span title={t("respond.refTitle")} class={css.refText}>
          {t("respond.refPrefix", { ref: fullRef(props.s.key) })}
        </span>
      </Show>
    </div>
    <h1 class={css.headerTitle}>
      {props.def.title || t("respond.untitledSurvey")}
    </h1>
    <Show when={props.def.description}>
      <p class={css.headerDesc}>{props.def.description}</p>
    </Show>

    <Show when={props.respondable.length > 0}>
      <div class={css.roleRow}>
        <span class={css.roleRowLabel}>{t("respond.respondingAs")}</span>
        <For each={props.respondable}>
          {(r) => (
            <button
              onClick={() => props.onPickRole(r)}
              class={css.rolePick}
              classList={{ [css.rolePickOn]: r === props.role }}
            >
              {roleLabel(r)}
            </button>
          )}
        </For>
      </div>
    </Show>
  </div>
);

export const RespondedBanner: Component<{ role: Role | null }> = (props) => (
  <div class={css.respondedBanner}>
    <span class={css.respondedCheck}>✓</span>
    <div class={css.bannerBody}>
      <div class={css.respondedTitle}>
        {t("respond.alreadyResponded", {
          role:
            props.role !== null
              ? roleLabel(props.role)
              : t("respond.alreadyRespondedRoleFallback"),
        })}
      </div>
      <div class={css.respondedText}>{t("respond.alreadyRespondedText")}</div>
    </div>
  </div>
);

export const SealedBanner: Component<{ round: number }> = (props) => (
  <div class={css.cardBanner}>
    <span class={css.bannerIcon}>◆</span>
    <div class={css.bannerBody}>
      <div class={css.bannerTitle}>{t("respond.sealedTitle")}</div>
      <div class={css.bannerText}>
        {t("respond.sealedTextBefore")}
        <b>{t("respond.sealedNoOne")}</b>
        {t("respond.sealedTextAfter", {
          reveal: formatRevealDate(props.round),
        })}
      </div>
    </div>
  </div>
);

/**
 * External-content survey whose off-chain labels couldn't be fetched/verified.
 * The form still works: every question's type, count and constraints are
 * on-chain, and answers reference option indices (validated + tallied normally).
 */
export const LabelsAbsentBanner: Component<{ keyStr: string }> = (props) => (
  <div class={css.cardBanner}>
    <span class={css.bannerIcon}>⚠</span>
    <div class={css.bannerBody}>
      <div class={css.bannerTitle}>{t("respond.labelsAbsentTitle")}</div>
      <div class={css.bannerText}>
        {t("respond.labelsAbsentTextBefore")}
        <span class={css.refInline}>{shortRef(props.keyStr)}</span>
        {t("respond.labelsAbsentTextMid")}
        <b>{t("respond.labelsAbsentCanRespond")}</b>
        {t("respond.labelsAbsentTextAfter")}
      </div>
    </div>
  </div>
);
