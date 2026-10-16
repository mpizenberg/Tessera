/**
 * Finishing a form, shared by the widget's submit bar and the app's: what the
 * press on the submit button does, and what it asks first. Its line and
 * confirmation are in `finish-bar.tsx`.
 *
 * The button never waits for every question. A required or unfinished one
 * stops it, and the focus goes there. Optional questions left unanswered are
 * skipped once confirmed, which records what skipping each by hand would: in
 * CIP-179 a question left out of a response is an abstention.
 */

import { createEffect, createSignal, on, type Accessor } from "solid-js";

import type { ResponseDraft } from "./response-draft";

export interface Finish {
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
}

export function createFinish(
  draft: Pick<ResponseDraft, "answers" | "answered" | "left" | "setSkipped">,
  goTo: (index: number) => void,
): Finish {
  const [asking, setAsking] = createSignal<"skip" | "answerOne">();
  let pending: (() => void) | undefined;
  const close = () => void setAsking(undefined);
  createEffect(on(draft.answers, close, { defer: true }));
  return {
    asking,
    finish: (submit) => {
      const { unanswered, unfinished, required } = draft.left();
      const stops = [...required, ...unfinished];
      if (stops.length > 0) {
        close();
        goTo(Math.min(...stops));
      } else if (!draft.answered()) setAsking("answerOne");
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
    goTo: (index) => {
      close();
      goTo(index);
    },
    close,
  };
}
