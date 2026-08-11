/**
 * One survey, in the two presentations the register switches between: a row in
 * the seven-column grid, or a self-contained card once the viewport is too
 * narrow to hold the columns.
 */

import { For, Show, type Component, type JSX } from "solid-js";
import { A } from "@solidjs/router";

import type { ChainTip, SurveyAggregate } from "cip-179/domain";

import { useApp } from "~/state";
import {
  endsText,
  fullRef,
  isClosed,
  shortGovId,
  viewStatus,
} from "~/ui/format";
import { FormMosaic, RoleChips, VisGlyph } from "~/ui/components/glyphs";
import { t } from "~/i18n";
import { COLS } from "./Chrome";
import css from "./explore.module.css";

/** Per-survey row flags (wallet relationship + optimistic-entry state). */
export interface Flags {
  readonly mine: boolean;
  readonly responded: boolean;
  /** Optimistic entry whose defining tx still hasn't been seen in a block. */
  readonly stuck: boolean;
}

export interface EntryProps {
  a: SurveyAggregate;
  tip: ChainTip | undefined;
  secondsPerEpoch: number;
  nowUnix: number;
  pro: boolean;
  flags: Flags;
  narrow: boolean;
}

/** Pick the card or table-row presentation for the current viewport. */
export const Entry: Component<EntryProps> = (props) => (
  <Show when={props.narrow} fallback={<GridRow {...props} />}>
    <CardRow {...props} />
  </Show>
);

/**
 * Everything both presentations read off a survey. The row and the card differ
 * in layout, not in what they derive, so they derive it once here.
 */
function rowView(props: EntryProps) {
  const app = useApp();
  // Enriched from the session cache when we hold the doc (e.g. just authored);
  // otherwise the on-chain definition, where external labels are absent.
  const def = () => app.displayDefinition(props.a.record.definition);
  const status = () => viewStatus(props.a);
  return {
    def,
    status,
    labelsMissing: () => !!def().contentAnchor && def().title.trim() === "",
    closed: () => isClosed(status()),
    ends: (): string =>
      props.tip
        ? endsText(props.a, props.tip, props.secondsPerEpoch, props.nowUnix)
        : "—",
  };
}

/** Inline check shown on surveys the connected wallet has answered. */
const AnsweredCheck: Component = () => (
  <span
    title={t("explore.answeredTitle")}
    aria-label={t("explore.answeredAria")}
    class={css.answered}
  >
    ✓
  </span>
);

const YoursBadge: Component = () => (
  <span class={css.badge}>{t("explore.badgeYours")}</span>
);

const OffChainBadge: Component = () => (
  <span class={css.badge}>{t("explore.badgeOffChain")}</span>
);

/** Marks a survey whose on-chain definition is spec-invalid (untalliable). */
const InvalidBadge: Component = () => (
  <span class={css.badge}>{t("explore.badgeUntalliable")}</span>
);

/** Marks an optimistic survey whose defining tx may never land (finding 61). */
const StuckBadge: Component = () => (
  <span class={css.badge}>{t("explore.badgeNotOnChain")}</span>
);

const GovLine: Component<{ actionId: string; title: string | null }> = (
  props,
) => (
  <div class={css.govLine}>
    {"◇ "}
    {t("explore.govLinkedAction", { id: shortGovId(props.actionId) })}
    {props.title
      ? t("explore.govLinkedActionTitle", { title: props.title })
      : ""}
  </div>
);

const GridRow: Component<EntryProps> = (props) => {
  const { def, status, labelsMissing, closed, ends } = rowView(props);
  return (
    // A router link, not a div+navigate: a plain click stays client-side (no
    // reload — wallet connection and snapshot survive), while cmd/ctrl/middle
    // click still opens the survey in a new tab natively.
    <A
      href={`/survey/${encodeURIComponent(props.a.key)}`}
      class={css.row}
      style={{ "--cols": COLS }}
    >
      <div class={css.formCell}>
        <FormMosaic count={def().questions.length} />
        <span
          class={css.formCount}
          classList={{ [css.formCountClosed]: closed() }}
        >
          {def().questions.length}
        </span>
      </div>
      <div class={css.centerCell}>
        <VisGlyph status={status()} />
      </div>
      <div class={css.centerCell}>
        <Show when={props.flags.responded}>
          <AnsweredCheck />
        </Show>
      </div>
      <div class={css.titleCell}>
        <div class={css.titleLine}>
          <span
            class={css.surveyTitle}
            classList={{ [css.surveyTitleClosed]: closed() }}
          >
            {def().title || t("explore.untitled")}
          </span>
          <Show when={props.flags.mine}>
            <YoursBadge />
          </Show>
          <Show when={labelsMissing()}>
            <OffChainBadge />
          </Show>
          <Show when={!props.a.talliable}>
            <InvalidBadge />
          </Show>
          <Show when={props.flags.stuck}>
            <StuckBadge />
          </Show>
        </div>
        <div class={css.desc}>
          {def().description || t("explore.noPresentation")}
        </div>
        <For each={props.a.govLinks}>
          {(link) => <GovLine actionId={link.actionId} title={link.title} />}
        </For>
      </div>
      <RoleChips roles={def().eligibleRoles} />
      <div>
        <div class={css.ends} classList={{ [css.endsClosed]: closed() }}>
          {ends()}
        </div>
        <Show when={props.pro}>
          <div
            title={t("explore.refTitle")}
            class={css.ref}
            classList={{ [css.refClosed]: closed() }}
          >
            {t("explore.refEpoch", { epoch: def().endEpoch })}
            <br />
            {fullRef(props.a.key)}
          </div>
        </Show>
      </div>
      <div class={css.repliesCell}>
        <span class={css.replies} classList={{ [css.repliesClosed]: closed() }}>
          {status() === "cancelled" || status() === "invalid"
            ? "—"
            : props.a.responseCount}
        </span>
      </div>
    </A>
  );
};

/** A single labelled meta pair in the card's footer row. */
const MetaChip: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <span class={css.metaChip}>
    <span class={css.metaLabel}>{props.label}</span>
    <span class={css.metaValue}>{props.children}</span>
  </span>
);

const CardRow: Component<EntryProps> = (props) => {
  const { def, status, labelsMissing, closed, ends } = rowView(props);
  return (
    <A href={`/survey/${encodeURIComponent(props.a.key)}`} class={css.card}>
      <div class={css.cardHead}>
        <span class={css.cardGlyph}>
          <VisGlyph status={status()} />
        </span>
        <Show when={props.flags.responded}>
          <AnsweredCheck />
        </Show>
        <span
          class={css.cardTitle}
          classList={{ [css.cardTitleClosed]: closed() }}
        >
          {def().title || t("explore.untitled")}
        </span>
        <Show when={props.flags.mine}>
          <YoursBadge />
        </Show>
      </div>

      <div class={css.cardDesc}>
        {def().description || t("explore.noPresentation")}
      </div>

      <Show when={labelsMissing() || !props.a.talliable}>
        <div class={css.cardBadgeRow}>
          <Show when={labelsMissing()}>
            <OffChainBadge />
          </Show>
          <Show when={!props.a.talliable}>
            <InvalidBadge />
          </Show>
          <Show when={props.flags.stuck}>
            <StuckBadge />
          </Show>
        </div>
      </Show>
      <For each={props.a.govLinks}>
        {(link) => <GovLine actionId={link.actionId} title={link.title} />}
      </For>

      <div class={css.cardMeta}>
        <MetaChip label={t("explore.metaForm")}>
          <span class={css.cardFormInline}>
            <FormMosaic count={def().questions.length} size={16} />
            {def().questions.length}
          </span>
        </MetaChip>
        <Show when={def().eligibleRoles.length > 0}>
          <MetaChip label={t("explore.metaEligible")}>
            <RoleChips roles={def().eligibleRoles} />
          </MetaChip>
        </Show>
        <MetaChip label={t("explore.metaEnds")}>
          <span
            class={css.cardEnds}
            classList={{ [css.cardEndsClosed]: closed() }}
          >
            {ends()}
          </span>
        </MetaChip>
        <MetaChip label={t("explore.metaReplies")}>
          {status() === "cancelled" || status() === "invalid"
            ? "—"
            : String(props.a.responseCount)}
        </MetaChip>
        <Show when={props.pro}>
          <MetaChip label={t("explore.metaEpoch")}>
            {String(def().endEpoch)}
          </MetaChip>
        </Show>
      </div>
      <Show when={props.pro}>
        <div title={t("explore.refTitle")} class={css.cardRef}>
          {t("explore.refLabel", { ref: fullRef(props.a.key) })}
        </div>
      </Show>
    </A>
  );
};
