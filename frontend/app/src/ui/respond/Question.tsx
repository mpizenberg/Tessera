/**
 * The answerable body of the screen: one card per question, wrapped in the two
 * contexts the shared question card reads from.
 */

import { For, type Component } from "solid-js";
import type { Question } from "cip-179";
import type { Draft, DraftValue, I18n } from "cardano-tessera-respond-core";
import {
  ClassesContext,
  I18nContext,
  QuestionCard,
  focusPrompt,
  type BodyClasses,
} from "cardano-tessera-respond-ui";

import { t, n, d } from "~/i18n";
import css from "./respond.module.css";

/**
 * The shared question card renders class names through {@link ClassesContext};
 * this maps each one to this screen's CSS module. Keys are checked complete by
 * `BodyClasses`, so the card can't render a class this screen doesn't style.
 */
const bodyClasses: BodyClasses = {
  card: css.card,
  qHead: css.qHead,
  qHeadLeft: css.qHeadLeft,
  qChip: css.qChip,
  qType: css.qType,
  qRequired: css.qRequired,
  skipBtn: css.skipBtn,
  skipBtnOn: css.skipBtnOn,
  qPrompt: css.qPrompt,
  qSkipped: css.qSkipped,
  qBody: css.qBody,
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
  rangeUnset: css.rangeUnset,
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
  customBytes: css.customBytes,
  customBytesOver: css.customBytesOver,
  customHint: css.customHint,
};

/**
 * i18n for the shared question card: the app's own engine wearing
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
  /** Takes focus past the last question, as a skip there moves on. */
  focusSubmit: () => void;
}> = (props) => {
  const prompts: HTMLElement[] = [];
  const skip = (i: number, skipped: boolean): void => {
    props.onSkip(i, skipped);
    if (!skipped) return;
    if (i + 1 < props.questions.length) focusPrompt(prompts[i + 1]);
    else props.focusSubmit();
  };
  return (
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
                onSkip={(sk) => skip(i(), sk)}
                promptRef={(el) => (prompts[i()] = el)}
              />
            )}
          </For>
        </div>
      </ClassesContext.Provider>
    </I18nContext.Provider>
  );
};
