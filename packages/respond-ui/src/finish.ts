/**
 * Finishing a form, shared by the widget's submit bar and the app's: when the
 * submit button can be pressed, what the press does, and what it asks first.
 * Its line and confirmation are in `finish-bar.tsx`.
 *
 * The button waits, disabled, until every question has been on screen. It
 * doesn't wait for every answer: a required or unfinished question stops it,
 * and the focus goes there. Optional questions seen and left unanswered are
 * skipped once confirmed, which records what skipping each by hand would: in
 * CIP-179 a question left out of a response is an abstention.
 */

import { createEffect, createSignal, on, type Accessor } from "solid-js";

import type { ResponseDraft } from "./response-draft";

export interface Finish {
  /** No question is left unseen: the submit button can be pressed. */
  readonly ready: Accessor<boolean>;
  /** What the press asks in place of the bar's row or line, if anything. */
  readonly asking: Accessor<"skip" | "answerOne" | undefined>;
  /** The submit button's press: runs `submit` now, after the confirmation, or not. */
  readonly finish: (submit: () => void) => void;
  /** Skips the questions left unanswered, then runs the press's `submit`. */
  readonly skipAndFinish: () => void;
  /** Steps to a question, closing what was asked. */
  readonly goTo: (index: number) => void;
  /** Closes what was asked, as any step or edit does. */
  readonly close: () => void;
  /** Past the last question: the submit button, or the first question unseen. */
  readonly pastLast: () => void;
}

export function createFinish(
  draft: Pick<ResponseDraft, "answers" | "answered" | "left" | "setSkipped">,
  goTo: (index: number) => void,
  focusButton: () => void,
): Finish {
  const [asking, setAsking] = createSignal<"skip" | "answerOne">();
  let pending: (() => void) | undefined;
  const close = () => void setAsking(undefined);
  createEffect(on(draft.answers, close, { defer: true }));
  const goToClosing = (index: number) => {
    close();
    goTo(index);
  };
  return {
    ready: () => draft.left().unseen.length === 0,
    asking,
    finish: (submit) => {
      const { unanswered, unseen, unfinished, required } = draft.left();
      const stops = [...required, ...unfinished, ...unseen];
      if (stops.length > 0) goToClosing(Math.min(...stops));
      else if (!draft.answered()) setAsking("answerOne");
      else if (unanswered.length > 0) {
        pending = submit;
        setAsking("skip");
      } else {
        close();
        submit();
      }
    },
    skipAndFinish: () => {
      for (const i of draft.left().unanswered) draft.setSkipped(i, true);
      close();
      pending?.();
    },
    goTo: goToClosing,
    close,
    pastLast: () => {
      const unseen = draft.left().unseen[0];
      if (unseen === undefined) focusButton();
      else goToClosing(unseen);
    },
  };
}
