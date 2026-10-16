/**
 * The submit bar's shared parts: the line beside the button naming what is
 * left, and the confirmation that skips the questions left unanswered.
 */

import { For, Show, onMount, type Component } from "solid-js";

import type { MsgKey } from "cardano-tessera-respond-core";

import { useClasses } from "./classes-context";
import { useI18n } from "./i18n-context";
import type { Left } from "./response-draft";

/** A longer list shows as its count and a link to its first question. */
const LISTED = 5;

/**
 * The line beside the submit button: what is left, each question a link. It is
 * gone once nothing is.
 */
export const LeftNote: Component<{
  left: Left;
  answered: boolean;
  /** The submit button was pressed with nothing answered. */
  calling: boolean;
  onGoTo: (index: number) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const any = () => Object.values(props.left).some((ids) => ids.length > 0);
  const call = () => props.calling || (!any() && !props.answered);
  return (
    <Show when={call() || any()}>
      <p class={cls.leftNote}>
        <Show
          when={!call()}
          fallback={
            <span role="alert" class={cls.leftCall}>
              {i18n.t("respond.answerOne")}
            </span>
          }
        >
          <LeftGroup
            ids={props.left.unseen}
            label="respond.leftUnseen"
            many="respond.leftUnseenMany"
            onGoTo={props.onGoTo}
          />
          <LeftGroup
            ids={props.left.required}
            label="respond.leftRequired"
            many="respond.leftRequiredMany"
            onGoTo={props.onGoTo}
          />
          <LeftGroup
            ids={props.left.unfinished}
            label="respond.leftUnfinished"
            many="respond.leftUnfinishedMany"
            onGoTo={props.onGoTo}
          />
          <LeftGroup
            ids={props.left.unanswered}
            label="respond.leftUnanswered"
            many="respond.leftUnansweredMany"
            onGoTo={props.onGoTo}
          />
        </Show>
      </p>
    </Show>
  );
};

const LeftGroup: Component<{
  ids: readonly number[];
  label: MsgKey;
  many: MsgKey;
  onGoTo: (index: number) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const long = () => props.ids.length > LISTED;
  return (
    <Show when={props.ids.length > 0}>
      <span class={cls.leftGroup}>
        {long()
          ? i18n.t(props.many, { count: i18n.n(props.ids.length) })
          : i18n.t(props.label)}{" "}
        <QuestionLinks
          ids={long() ? props.ids.slice(0, 1) : props.ids}
          onGoTo={props.onGoTo}
        />
      </span>{" "}
    </Show>
  );
};

const QuestionLinks: Component<{
  ids: readonly number[];
  onGoTo: (index: number) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  return (
    <For each={props.ids}>
      {(i, at) => (
        <>
          {at() > 0 ? " · " : ""}
          <button
            type="button"
            class={cls.qLink}
            aria-label={i18n.t("respond.goToQuestion", { n: i18n.n(i + 1) })}
            onClick={() => props.onGoTo(i)}
          >
            {i18n.t("respond.questionChip", { n: i18n.n(i + 1) })}
          </button>
        </>
      )}
    </For>
  );
};

/** In place of the submit row: the questions left unanswered, to skip or visit. */
export const SkipConfirm: Component<{
  unanswered: readonly number[];
  onSkip: () => void;
  onGoTo: (index: number) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const one = () => props.unanswered.length === 1;
  const first = () => props.unanswered[0] ?? 0;
  let text: HTMLParagraphElement | undefined;
  // The focus was on the button this replaces. On the text, a screen reader
  // reads the question first, and an Enter still held cannot skip.
  onMount(() => text?.focus());
  return (
    <div class={cls.skipConfirm}>
      <p ref={text} tabindex={-1} class={cls.skipConfirmText}>
        {one()
          ? i18n.t("respond.skipConfirmOne")
          : i18n.t("respond.skipConfirmMany", {
              count: i18n.n(props.unanswered.length),
            })}{" "}
        <QuestionLinks
          ids={props.unanswered.slice(0, LISTED)}
          onGoTo={props.onGoTo}
        />
        {props.unanswered.length > LISTED ? " …" : ""}
      </p>
      <div class={cls.skipConfirmActions}>
        <button
          type="button"
          class={cls.goToBtn}
          onClick={() => props.onGoTo(first())}
        >
          {i18n.t("respond.goToQuestion", { n: i18n.n(first() + 1) })}
        </button>
        <button
          type="button"
          class={cls.skipFinishBtn}
          onClick={() => props.onSkip()}
        >
          {one()
            ? i18n.t("respond.skipItAndFinish")
            : i18n.t("respond.skipThemAndFinish")}
        </button>
      </div>
    </div>
  );
};
