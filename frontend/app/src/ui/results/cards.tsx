/**
 * Per-question result widgets: one card per question, for both the live
 * (count-based) and final (artifact) tallies.
 */

import { For, Show, type Component, type JSX } from "solid-js";
import type { Question } from "cip-179";

import { formatAda, type WeightedQuestionView } from "~/domain/artifactView";
import type { QuestionTally } from "~/domain/displayTally";
import { ResultBarCard } from "~/ui/components/ResultBarCard";
import { t, n } from "~/i18n";
import css from "./results.module.css";

const BASE_TYPE_KEY: Record<Question["type"], string> = {
  custom: "typeCustom",
  singleChoice: "typeSingleChoice",
  multiSelect: "typeMultiSelect",
  ranking: "typeRanking",
  numericRange: "typeNumericRange",
  pointsAllocation: "typePointsAllocation",
  rating: "typeRating",
};

/** Localized base type label; resolved at render time so it tracks the locale. */
const baseType = (type: Question["type"]): string =>
  t(`survey.${BASE_TYPE_KEY[type]}` as Parameters<typeof t>[0]);

// ----------------------------------------------------------------------------
// Per-question result widgets
// ----------------------------------------------------------------------------

export const QuestionResult: Component<{
  q: Question;
  index: number;
  tally: QuestionTally | undefined;
}> = (props) => {
  const qLabel = () => t("survey.qLabel", { n: props.index + 1 });
  const join = (suffix: string): string =>
    t("survey.typeLabelJoined", { base: baseType(props.q.type), suffix });
  return (
    // `keyed` matters: the tally is swapped for a new object on every role-
    // filter change while staying truthy, and only a keyed Show re-renders
    // its children on a value (not truthiness) change.
    <Show when={props.tally} keyed>
      {(tally) => {
        switch (tally.kind) {
          case "bars": {
            const typeLabel =
              tally.unit === "responders"
                ? join(t("survey.typeSuffixResponders"))
                : tally.unit === "first preferences"
                  ? join(t("survey.typeSuffixFirstPreferences"))
                  : baseType(props.q.type);
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={typeLabel}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.abstained", { n: n(tally.abstained) })}
                bars={tally.bars.map((b) => ({
                  label: b.label,
                  meta:
                    tally.unit === "responders" && tally.answered > 0
                      ? `${Math.round((b.count / tally.answered) * 100)}%`
                      : String(b.count),
                  pct: b.pct,
                }))}
              />
            );
          }
          case "histogram":
            return (
              <HistogramCard
                qLabel={qLabel()}
                typeLabel={join(t("survey.typeSuffixDistribution"))}
                prompt={props.q.prompt}
                t={tally}
              />
            );
          case "points": {
            // One bar per option, like multi-select. Bars are normalized to the
            // leading option's average so the longest fills the track; the meta
            // shows the average points allocated (out of the question's budget).
            const max = Math.max(0, ...tally.rows.map((r) => r.avg));
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={join(t("survey.typeSuffixAverageAllocation"))}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.abstained", { n: n(tally.abstained) })}
                bars={tally.rows.map((row) => ({
                  label: row.label,
                  meta: t("survey.pointsMeta", { avg: row.avg.toFixed(1) }),
                  pct: max > 0 ? row.avg / max : 0,
                }))}
              />
            );
          }
          case "rating":
            return (
              <RatingCard
                qLabel={qLabel()}
                typeLabel={join(
                  tally.numeric
                    ? t("survey.typeSuffixNumericGrid")
                    : t("survey.typeSuffixLabelledScale"),
                )}
                prompt={props.q.prompt}
                t={tally}
              />
            );
          case "custom":
            return (
              <CustomCard
                qLabel={qLabel()}
                typeLabel={join(t("survey.typeSuffixInterpretedOffchain"))}
                prompt={props.q.prompt}
                t={tally}
              />
            );
        }
      }}
    </Show>
  );
};

const CardShell: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  abstain?: string;
  children: JSX.Element;
}> = (props) => (
  <div class={css.card}>
    <div class={css.cardHead}>
      <div class={css.cardHeadLeft}>
        <span class={css.qChip}>{props.qLabel}</span>
        <div class={css.typeLabel}>{props.typeLabel}</div>
      </div>
      <Show when={props.abstain}>
        <span class={css.abstain}>{props.abstain}</span>
      </Show>
    </div>
    <h3 class={css.cardTitle}>{props.prompt || t("survey.noPrompt")}</h3>
    {props.children}
  </div>
);

const HistogramCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "histogram" }>;
}> = (props) => {
  const max = () => Math.max(1, ...props.t.bins.map((b) => b.count));
  return (
    <CardShell
      qLabel={props.qLabel}
      typeLabel={props.typeLabel}
      prompt={props.prompt}
      abstain={t("survey.abstained", { n: n(props.t.abstained) })}
    >
      <div class={css.histStats}>
        <span class={css.histStat}>
          {t("survey.histMean")}{" "}
          <b class={css.histStatValue}>{props.t.mean.toFixed(2)}</b>
        </span>
        <span class={css.histStat}>
          {t("survey.histMedian")}{" "}
          <b class={css.histStatValue}>{n(props.t.median)}</b>
        </span>
      </div>
      <Show when={props.t.bins.length > 0} fallback={<NoData />}>
        <div class={css.histBars}>
          <For each={props.t.bins}>
            {(b) => (
              <div class={css.histCol}>
                <span class={css.histCount}>{n(b.count)}</span>
                <div class={css.histColTrack}>
                  <div
                    class={css.histBar}
                    style={{
                      "--hist-h": `${Math.round((b.count / max()) * 100)}%`,
                    }}
                  />
                </div>
                <span class={css.histLabel}>{b.label}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </CardShell>
  );
};

const RatingCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "rating" }>;
}> = (props) => {
  const top = () => props.t.baseMin + (props.t.levels - 1) * props.t.step;
  const avgLabel = (avg: number): string => {
    if (props.t.numeric) return avg.toFixed(2);
    const labels = props.t.levelLabels;
    if (!labels) return avg.toFixed(2);
    return `${labels[Math.round(avg)] ?? "—"} (${avg.toFixed(2)})`;
  };
  return (
    <CardShell
      qLabel={props.qLabel}
      typeLabel={props.typeLabel}
      prompt={props.prompt}
      abstain={t("survey.abstained", { n: n(props.t.abstained) })}
    >
      <Show when={props.t.levelLabels}>
        <div class={css.ratingLegend}>
          <For each={props.t.levelLabels!}>
            {(label, i) => (
              <span class={css.ratingLegendItem}>
                <span class={css.ratingLegendIndex}>{i()}</span>
                {label}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.t.answered > 0} fallback={<NoData />}>
        <div class={css.ratingRows}>
          <For each={props.t.rows}>
            {(row) => (
              <div class={css.ratingRow}>
                <span class={css.ratingRowLabel}>{row.label}</span>
                <div class={css.ratingTrack}>
                  <div
                    class={css.ratingBar}
                    style={{
                      "--rating-pct": `${pctOf(row.avg, props.t.baseMin, top())}%`,
                    }}
                  />
                </div>
                <span class={css.ratingAvg}>{avgLabel(row.avg)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </CardShell>
  );
};

const CustomCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "custom" }>;
}> = (props) => (
  <CardShell
    qLabel={props.qLabel}
    typeLabel={props.typeLabel}
    prompt={props.prompt}
  >
    <div class={css.customCount}>
      <span class={css.customCountValue}>{n(props.t.answered)}</span>
      <span class={css.customCountLabel}>{t("survey.customCountLabel")}</span>
    </div>
    <Show when={props.t.samples.length > 0}>
      <div class={css.customSamples}>
        <For each={props.t.samples}>
          {(x) => <span class={css.customSample}>“{x}”</span>}
        </For>
      </div>
    </Show>
  </CardShell>
);

const NoData: Component = () => (
  <p class={css.noData}>{t("survey.noResponsesYet")}</p>
);

/**
 * One question's weighted result. Every kind maps onto {@link ResultBarCard}:
 * option weights as bars, numeric values as a per-value bar list with the
 * weighted mean in the type label, per-option means as average bars. Bar meta
 * shows ada weight + responder count for stake-weighted roles, plain counts
 * for count-only roles (Keyholder).
 */
export const WeightedQuestionResult: Component<{
  q: Question;
  index: number;
  view: WeightedQuestionView | undefined;
  countOnly: boolean;
}> = (props) => {
  const qLabel = () => t("survey.qLabel", { n: props.index + 1 });
  const meta = (weight: bigint, count: number): string =>
    props.countOnly
      ? String(count)
      : t("survey.weightedBarMeta", { ada: formatAda(weight), n: n(count) });
  return (
    // `keyed` for the same reason as QuestionResult: the view object is
    // replaced (weighting switch) while staying truthy.
    <Show when={props.view} keyed>
      {(v) => {
        switch (v.kind) {
          case "bars":
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={baseType(props.q.type)}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.counted", { n: n(v.answeredCount) })}
                bars={v.bars.map((b) => ({
                  label: b.label,
                  meta: meta(b.weight, b.count),
                  pct: b.frac,
                }))}
              />
            );
          case "histogram":
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={
                  v.mean !== null
                    ? t("survey.typeLabelJoined", {
                        base: baseType(props.q.type),
                        suffix: `${t("survey.weightedMean")} ${n(v.mean)}`,
                      })
                    : baseType(props.q.type)
                }
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.counted", { n: n(v.answeredCount) })}
                bars={v.bins.map((b) => ({
                  label: b.label,
                  meta: meta(b.weight, b.count),
                  pct: b.frac,
                }))}
              />
            );
          case "rows": {
            const max = Math.max(0, ...v.rows.map((r) => r.avg ?? 0));
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={t("survey.typeLabelJoined", {
                  base: baseType(props.q.type),
                  suffix: t("survey.weightedMean"),
                })}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.counted", { n: n(v.answeredCount) })}
                bars={v.rows.map((row) => ({
                  label: row.label,
                  meta: row.avg === null ? "—" : n(row.avg),
                  pct: max > 0 && row.avg !== null ? row.avg / max : 0,
                }))}
              />
            );
          }
          case "custom":
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={baseType(props.q.type)}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.counted", { n: n(v.answeredCount) })}
                bars={[]}
              />
            );
        }
      }}
    </Show>
  );
};

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function pctOf(avg: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((avg - min) / (max - min)) * 100));
}
