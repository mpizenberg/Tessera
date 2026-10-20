/**
 * The answerable body of the screen: one card per question, wrapped in the two
 * contexts respond-ui's components read from.
 */

import { For, type Component, type ParentComponent } from "solid-js";
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
import body from "./body.module.css";
import css from "./respond.module.css";

/**
 * respond-ui renders class names through {@link ClassesContext}, styled by its
 * own sheet; respond-ui's tests check that sheet styles every one.
 */
const bodyClasses = body as BodyClasses;

/**
 * i18n for the shared question card: the app's own engine wearing
 * respond-core's `I18n` interface — compile-time sound because the app's
 * respond/roles/validation namespaces spread respond-core's catalogs, so every
 * core key is an app key. `t`/`n`/`d` each read the locale signal, so calls stay
 * reactive behind a constant instance.
 */
const bodiesI18n: I18n = { t, n, d };

/** The contexts respond-ui's components read from. */
export const RespondContexts: ParentComponent = (props) => (
  <I18nContext.Provider value={() => bodiesI18n}>
    <ClassesContext.Provider value={bodyClasses}>
      {props.children}
    </ClassesContext.Provider>
  </I18nContext.Provider>
);

export const QuestionList: Component<{
  questions: readonly Question[];
  drafts: readonly Draft[];
  /** Filled with each question's prompt, index-aligned. */
  prompts: HTMLElement[];
  onChange: (index: number, value: DraftValue) => void;
  onSkip: (index: number, skipped: boolean) => void;
  onSeen: (index: number) => void;
  /** Takes focus past the last question, as a skip or Enter there moves on. */
  pastLast: () => void;
}> = (props) => {
  const next = (i: number): void => {
    if (i + 1 < props.questions.length) focusPrompt(props.prompts[i + 1]);
    else props.pastLast();
  };
  return (
    <RespondContexts>
      <div class={css.questionList}>
        <For each={props.questions}>
          {(q, i) => (
            <QuestionCard
              q={q}
              index={i()}
              draft={props.drafts[i()]}
              onChange={(v) => props.onChange(i(), v)}
              onSkip={(sk) => props.onSkip(i(), sk)}
              onNext={() => next(i())}
              onPrev={() => i() > 0 && focusPrompt(props.prompts[i() - 1])}
              promptRef={(el) => (props.prompts[i()] = el)}
              onSeen={() => props.onSeen(i())}
            />
          )}
        </For>
      </div>
    </RespondContexts>
  );
};
