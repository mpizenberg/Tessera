/**
 * The right-hand column — live summary and the publish controls — plus the two
 * panels that replace the builder outright: the receipt, and the refusal to
 * build a survey no connected wallet could own.
 */

import { Show, type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";

import type { DefinitionMeta } from "~/domain/create";
import { formatRevealDate } from "~/tlock/drand";
import { roleLabel, shortHash, shortRef } from "~/ui/format";
import { TxLink } from "~/ui/components/TxLink";
import { t, n } from "~/i18n";
import css from "./create.module.css";

export const SummaryCard: Component<{
  meta: DefinitionMeta;
  qCount: number;
}> = (props) => {
  const roleList = () =>
    props.meta.eligibleRoles.length === 0
      ? t("create.noRolesSelected")
      : [...props.meta.eligibleRoles]
          .sort((a, b) => a - b)
          .map(roleLabel)
          .join(", ");
  const ends = () =>
    props.meta.endEpoch.trim() === ""
      ? t("create.endsNone")
      : t("create.endsEpoch", { epoch: props.meta.endEpoch.trim() });
  const visibility = () =>
    props.meta.mode === "sealed"
      ? props.meta.sealedRound > 0
        ? t("create.summarySealedReveals", {
            date: formatRevealDate(props.meta.sealedRound),
          })
        : t("create.summarySealed")
      : t("create.summaryPublic");
  return (
    <div class={css.summaryCard}>
      <div class={css.numberedHead}>{t("create.summary")}</div>
      <h3 class={css.summaryTitle}>
        {props.meta.title.trim() || t("create.untitledSurvey")}
      </h3>
      <div class={css.summaryRows}>
        <SummaryRow
          label={t("create.summaryQuestions")}
          value={n(props.qCount)}
        />
        <SummaryRow label={t("create.summaryWhoResponds")} value={roleList()} />
        <SummaryRow label={t("create.summaryEnds")} value={ends()} />
        <SummaryRow
          label={t("create.summaryVisibility")}
          value={visibility()}
        />
      </div>
    </div>
  );
};

const SummaryRow: Component<{ label: string; value: string }> = (props) => (
  <div class={css.summaryRow}>
    <span class={css.summaryRowLabel}>{props.label}</span>
    <span class={css.summaryRowValue}>{props.value}</span>
  </div>
);

export const PublishButton: Component<{
  problemCount: number;
  blockedReason: string | null;
  submitting: boolean;
  busyText: string;
  paymentHashHex: string;
  /** True when publishing would queue the survey rather than sign it now. */
  queueing: boolean;
  onPublish: () => void;
  onQueue: () => void;
}> = (props) => {
  const ok = () => props.problemCount === 0 && !props.blockedReason;
  return (
    <>
      <button
        type="button"
        onClick={() => (props.queueing ? props.onQueue() : props.onPublish())}
        disabled={props.submitting || !!props.blockedReason}
        class={css.publishBtn}
        classList={{ [css.publishBtnEnabled]: ok() && !props.submitting }}
      >
        {props.submitting
          ? props.busyText
          : props.queueing
            ? t("cart.addToCart")
            : t("create.signAndPublish")}{" "}
        <span class={css.publishArrow}>→</span>
      </button>
      <Show when={!props.queueing}>
        <button
          type="button"
          onClick={() => props.onQueue()}
          disabled={props.submitting || !!props.blockedReason}
          class={css.queueBtn}
        >
          {t("cart.addToCart")}
        </button>
      </Show>
      <p class={css.publishNote} classList={{ [css.publishNoteOk]: ok() }}>
        <Show
          when={ok()}
          fallback={
            props.blockedReason ??
            t("create.publishNoteProblems", {
              count: props.problemCount,
              plural:
                props.problemCount === 1 ? "" : t("create.problemPluralSuffix"),
            })
          }
        >
          {t("create.publishNoteOkPre")}
          <span class={css.mono}>key:{shortHash(props.paymentHashHex)}</span>
          {t("create.publishNoteOkPost")}
        </Show>
      </p>
    </>
  );
};

export const SubmittedPanel: Component<{ hash: string }> = (props) => {
  const navigate = useNavigate();
  const surveyKey = `${props.hash}:0`;
  return (
    <div class={css.submittedCard}>
      <span class={css.submittedTick}>✓</span>
      <h3 class={css.submittedTitle}>{t("create.surveyPublished")}</h3>
      <p class={css.submittedBody}>{t("create.submittedBody")}</p>
      <div class={css.submittedRef}>
        <TxLink hash={props.hash} /> ·{" "}
        {t("create.submittedRef", { ref: shortRef(surveyKey) })}
      </div>
      <div class={css.submittedActions}>
        <button
          type="button"
          onClick={() => navigate(`/survey/${encodeURIComponent(surveyKey)}`)}
          class={css.submittedPrimary}
        >
          {t("create.viewSurvey")}
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          class={css.submittedSecondary}
        >
          {t("create.allSurveysButton")}
        </button>
      </div>
    </div>
  );
};

/**
 * Shown instead of the builder when no wallet can own the survey: none
 * connected, or one whose payment credential is script-based — the only way to
 * have a wallet but no owner credential.
 */
export const NoOwnerPanel: Component<{ connected: boolean }> = (props) => (
  <div class={css.connectCard}>
    <div class={css.connectTitle}>
      {props.connected
        ? t("create.scriptOwnerTitle")
        : t("create.connectTitle")}
    </div>
    <p class={css.connectBody}>
      {props.connected ? t("create.scriptOwnerBody") : t("create.connectBody")}
    </p>
  </div>
);
