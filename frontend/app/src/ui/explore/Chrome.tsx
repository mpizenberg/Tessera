/**
 * Everything the register is built from except the survey rows themselves: the
 * column header, section labels, loading skeletons, the line that stands in
 * when there are no rows, the legend, and the first-visit intro.
 */

import { For, Show, type Component, type JSX } from "solid-js";

import { FormMosaic, VisGlyph } from "~/ui/components/glyphs";
import { t } from "~/i18n";
import css from "./explore.module.css";

export const HeaderRow: Component = () => {
  const cell = (label: string, align?: "center" | "right"): JSX.Element => (
    <span
      class={css.headerCell}
      classList={{
        [css.cellCenter]: align === "center",
        [css.cellRight]: align === "right",
      }}
    >
      {label}
    </span>
  );
  return (
    <div class={css.header}>
      {cell(t("explore.headerForm"), "center")}
      <span />
      <span title={t("explore.headerAnsweredTitle")} class={css.cellCenter}>
        {cell("✓", "center")}
      </span>
      {cell(t("explore.headerSurvey"))}
      {cell(t("explore.headerEligible"))}
      {cell(t("explore.headerEnds"))}
      {cell(t("explore.headerReplies"), "right")}
    </div>
  );
};

export const SectionLabel: Component<{
  dot: JSX.Element;
  color: string;
  label: string;
  note?: string;
  topBorder?: boolean;
}> = (props) => (
  <div class={css.section} classList={{ [css.sectionTop]: props.topBorder }}>
    {/* Per-section accent is a free-form prop, so it rides in on a CSS var. */}
    <span class={css.sectionTag} style={{ "--section-color": props.color }}>
      {props.dot}
      {props.label}
    </span>
    <Show when={props.note}>
      <span class={css.sectionNote}>{props.note}</span>
    </Show>
  </div>
);

// Width/height are computed per-instance, so they ride in on CSS vars consumed
// by `.skeletonBar`; everything else is static.
function skeletonBar(width: string, height = "12px"): JSX.Element {
  return (
    <span
      class={css.skeletonBar}
      style={{ "--bar-w": width, "--bar-h": height }}
    />
  );
}

/** Placeholder rows shown while the snapshot loads (mirrors the register grid). */
export const SkeletonRows: Component<{ narrow: boolean }> = (props) => (
  <For each={[0, 1, 2, 3, 4, 5]}>
    {(i) => (
      <Show
        when={!props.narrow}
        fallback={
          <div class={css.skeletonCard}>
            {skeletonBar("58%", "14px")}
            {skeletonBar("38%")}
          </div>
        }
      >
        <div class={css.skeletonRow}>
          <span class={css.skeletonForm} />
          <span class={css.skeletonDot} />
          <span />
          {skeletonBar(`${74 - (i % 3) * 14}%`, "13px")}
          {skeletonBar("72%")}
          {skeletonBar("60%")}
          <span class={css.skeletonReplies} />
        </div>
      </Show>
    )}
  </For>
);

/** A single muted line where rows would be: load failed, or nothing matched. */
export const GridNotice: Component<{ text: string; tone?: "danger" }> = (
  props,
) => (
  <div
    class={css.notice}
    classList={{ [css.noticeDanger]: props.tone === "danger" }}
  >
    {props.text}
  </div>
);

export const Legend: Component = () => (
  <div class={css.legend}>
    <FormMosaic count={4} size={14} />
    <span class={css.legendText}>{t("explore.legendForm")}</span>
    <span class={css.legendGroup}>
      <span class={css.legendDot} />
      <span class={css.legendText}>{t("explore.legendPublic")}</span>
      <span class={css.legendSealed}>
        <VisGlyph status="sealed" />
      </span>
      <span class={css.legendText}>{t("explore.legendSealed")}</span>
      <span class={css.legendCheck}>✓</span>
      <span class={css.legendText}>{t("explore.legendAnswered")}</span>
    </span>
  </div>
);

const INTRO_DISMISSED_KEY = "tessera.introDismissed";

export function introIsDismissed(): boolean {
  try {
    return localStorage.getItem(INTRO_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberIntroDismissed(): void {
  try {
    localStorage.setItem(INTRO_DISMISSED_KEY, "1");
  } catch {
    // storage unavailable — the intro just shows again next load
  }
}

/** Dismissible first-visit explainer, shown until a wallet connects. */
export const IntroHero: Component<{ onDismiss: () => void }> = (props) => (
  <div class={css.intro}>
    <button
      onClick={() => props.onDismiss()}
      title={t("explore.introDismiss")}
      class={css.introDismiss}
    >
      ×
    </button>
    <h2 class={css.introTitle}>{t("explore.introTitle")}</h2>
    <p class={css.introBody}>{t("explore.introBody")}</p>
  </div>
);
