/**
 * The card around a question's body: its number, kind and Skip toggle, then
 * the prompt. Where focus goes after a skip is the host's call, since only the
 * host knows which question comes next and where its submit button is.
 */

import { Show, type Component } from "solid-js";

import type { Question } from "cip-179";
import type { Draft, DraftValue } from "cardano-tessera-respond-core";

import { QuestionBody } from "./bodies";
import { useClasses } from "./classes-context";
import { useI18n } from "./i18n-context";
import { typeMeta } from "./shared";

export const QuestionCard: Component<{
  q: Question;
  index: number;
  draft: Draft | undefined;
  /** Cap on a custom answer's UTF-8 length, shown as a byte count. */
  maxTextBytes?: number | undefined;
  /** Schema URIs whose anchor a custom question leaves out. */
  hiddenSchemas?: readonly string[] | undefined;
  onChange: (v: DraftValue) => void;
  onSkip: (skipped: boolean) => void;
  /** Receives the prompt, which takes focus from script only. */
  promptRef?: (el: HTMLElement) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const skipped = () => props.draft?.skipped ?? false;
  const hideSchema = () =>
    props.q.type === "custom" &&
    (props.hiddenSchemas?.includes(props.q.methodSchema.uri) ?? false);
  return (
    <div class={cls.card}>
      <div class={cls.qHead}>
        <div class={cls.qHeadLeft}>
          <span class={cls.qChip}>
            {i18n.t("respond.questionChip", { n: i18n.n(props.index + 1) })}
          </span>
          <span class={cls.qType}>{typeMeta(i18n, props.q)}</span>
          <Show when={props.q.required}>
            <span class={cls.qRequired}>{i18n.t("respond.required")}</span>
          </Show>
        </div>
        <Show when={!props.q.required}>
          <button
            onClick={() => props.onSkip(!skipped())}
            class={cls.skipBtn}
            classList={{ [cls.skipBtnOn]: skipped() }}
          >
            {skipped() ? i18n.t("respond.skipped") : i18n.t("respond.skip")}
          </button>
        </Show>
      </div>
      <h3 ref={(el) => props.promptRef?.(el)} tabindex={-1} class={cls.qPrompt}>
        {props.q.prompt || i18n.t("respond.noPrompt")}
      </h3>

      <Show
        when={!skipped()}
        fallback={<p class={cls.qSkipped}>{i18n.t("respond.skippedNote")}</p>}
      >
        <div class={cls.qBody}>
          <Show when={props.draft}>
            <QuestionBody
              q={props.q}
              value={props.draft!.value}
              maxTextBytes={props.maxTextBytes}
              hideSchema={hideSchema()}
              onChange={props.onChange}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};

/**
 * Moves focus to a prompt further down a list of cards, scrolled to the middle
 * of the viewport, clear of a sticky bar at either edge.
 */
export function focusPrompt(el: HTMLElement | undefined): void {
  el?.focus({ preventScroll: true });
  el?.scrollIntoView({ block: "center" });
}
