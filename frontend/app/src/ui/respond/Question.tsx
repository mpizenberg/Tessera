/**
 * The answerable body of the screen: one card per question, wrapped in the two
 * contexts the shared question bodies read from.
 */

import { For, Show, type Component } from "solid-js";
import type { Question } from "cip-179";
import type { Draft, DraftValue, I18n } from "cardano-tessera-respond-core";
import {
  ClassesContext,
  I18nContext,
  QuestionBody,
  typeMeta,
  useI18n,
  type BodyClasses,
} from "cardano-tessera-respond-ui";

import { t, n, d } from "~/i18n";
import css from "./respond.module.css";

/**
 * The shared question bodies render class names through {@link ClassesContext};
 * this maps each one to this screen's CSS module. Keys are checked complete by
 * `BodyClasses`, so a body can't render a class this screen doesn't style.
 */
const bodyClasses: BodyClasses = {
  optionGroup: css.optionGroup,
  optionRow: css.optionRow,
  optionRowOn: css.optionRowOn,
  radio: css.radio,
  radioOn: css.radioOn,
  radioDot: css.radioDot,
  multiGrid: css.multiGrid,
  checkbox: css.checkbox,
  checkboxOn: css.checkboxOn,
  multiCount: css.multiCount,
  noneNote: css.noneNote,
  noneNoteText: css.noneNoteText,
  noneNoteLead: css.noneNoteLead,
  rankedList: css.rankedList,
  rankedRow: css.rankedRow,
  rankNum: css.rankNum,
  rankLabel: css.rankLabel,
  rankBtn: css.rankBtn,
  rankBtnDanger: css.rankBtnDanger,
  rankPoolHint: css.rankPoolHint,
  rankPool: css.rankPool,
  poolBtn: css.poolBtn,
  poolBtnDisabled: css.poolBtnDisabled,
  numHero: css.numHero,
  numValue: css.numValue,
  numberInput: css.numberInput,
  rangeFull: css.rangeFull,
  rangeBounds: css.rangeBounds,
  pointsHeader: css.pointsHeader,
  pointsRemainLabel: css.pointsRemainLabel,
  pointsRemain: css.pointsRemain,
  pointsRemainDone: css.pointsRemainDone,
  pointsRow: css.pointsRow,
  pointsRowHead: css.pointsRowHead,
  pointsOptLabel: css.pointsOptLabel,
  pointsControls: css.pointsControls,
  stepBtn: css.stepBtn,
  pointsInput: css.pointsInput,
  rangeFullBlock: css.rangeFullBlock,
  pointsFooter: css.pointsFooter,
  ratingList: css.ratingList,
  ratingRow: css.ratingRow,
  ratingOptLabel: css.ratingOptLabel,
  ratingNumberInput: css.ratingNumberInput,
  ratingLevels: css.ratingLevels,
  ratingBtn: css.ratingBtn,
  ratingBtnOn: css.ratingBtnOn,
  ratHint: css.ratHint,
  customSchema: css.customSchema,
  customSchemaTag: css.customSchemaTag,
  customSchemaUri: css.customSchemaUri,
  customInput: css.customInput,
  customHint: css.customHint,
};

/**
 * i18n for the shared question bodies: the app's own engine wearing
 * respond-core's `I18n` interface — compile-time sound because the app's
 * respond/roles/validation namespaces spread respond-core's catalogs, so every
 * core key is an app key. `t`/`n`/`d` each read the locale signal, so calls stay
 * reactive behind a constant instance.
 */
const bodiesI18n: I18n = { t, n, d };

export const QuestionList: Component<{
  questions: readonly Question[];
  drafts: readonly Draft[];
  onChange: (index: number, value: DraftValue) => void;
  onSkip: (index: number, skipped: boolean) => void;
}> = (props) => (
  <I18nContext.Provider value={() => bodiesI18n}>
    <ClassesContext.Provider value={bodyClasses}>
      <div class={css.questionList}>
        <For each={props.questions}>
          {(q, i) => (
            <QuestionCard
              q={q}
              index={i()}
              draft={props.drafts[i()]}
              onChange={(v) => props.onChange(i(), v)}
              onSkip={(sk) => props.onSkip(i(), sk)}
            />
          )}
        </For>
      </div>
    </ClassesContext.Provider>
  </I18nContext.Provider>
);

const QuestionCard: Component<{
  q: Question;
  index: number;
  draft: Draft | undefined;
  onChange: (v: DraftValue) => void;
  onSkip: (skipped: boolean) => void;
}> = (props) => {
  const i18n = useI18n();
  const skipped = () => props.draft?.skipped ?? false;
  return (
    <div class={css.card}>
      <div class={css.qHead}>
        <div class={css.qHeadLeft}>
          <span class={css.qChip}>
            {t("respond.questionChip", { n: n(props.index + 1) })}
          </span>
          <span class={css.qType}>{typeMeta(i18n, props.q)}</span>
          <Show when={props.q.required}>
            <span class={css.qRequired}>{t("respond.required")}</span>
          </Show>
        </div>
        <Show when={!props.q.required}>
          <button
            onClick={() => props.onSkip(!skipped())}
            class={css.skipBtn}
            classList={{ [css.skipBtnOn]: skipped() }}
          >
            {skipped() ? t("respond.skipped") : t("respond.skip")}
          </button>
        </Show>
      </div>
      <h3 class={css.qPrompt}>{props.q.prompt || t("respond.noPrompt")}</h3>

      <Show
        when={!skipped()}
        fallback={<p class={css.qSkipped}>{t("respond.skippedNote")}</p>}
      >
        <div class={css.qBody}>
          <Show when={props.draft}>
            <QuestionBody
              q={props.q}
              value={props.draft!.value}
              onChange={props.onChange}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};
