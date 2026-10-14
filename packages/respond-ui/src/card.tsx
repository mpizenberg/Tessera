/**
 * The card around a question's body: its number, kind and Skip toggle, then
 * the prompt. It takes the shortcut keys pressed inside it. Moving on, after
 * a skip or on Enter, and going back are the host's to carry out, since only
 * the host knows which question is next and where its submit button is.
 */

import { Show, createUniqueId, type Component } from "solid-js";

import type { Question } from "cip-179";
import type { Draft, DraftValue } from "cardano-tessera-respond-core";

import { QuestionBody, type Shortcut, type ShortcutHandler } from "./bodies";
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
  /** A multi-select's None box label, in place of the catalog's. */
  noneLabel?: string | undefined;
  /** Letters, digits, Enter and Shift+Enter; on unless false. */
  shortcuts?: boolean | undefined;
  onChange: (v: DraftValue) => void;
  onSkip: (skipped: boolean) => void;
  /** Moves on from this question, after a skip or on Enter. */
  onNext: () => void;
  /** Goes back from this question, on Shift+Enter. */
  onPrev: () => void;
  /** Receives the prompt, which takes focus from script only. */
  promptRef?: (el: HTMLElement) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const promptId = createUniqueId();
  const skipped = () => props.draft?.skipped ?? false;
  const hideSchema = () =>
    props.q.type === "custom" &&
    (props.hiddenSchemas?.includes(props.q.methodSchema.uri) ?? false);
  const keysOn = () => props.shortcuts !== false;
  let bodyKeys: ShortcutHandler | undefined;
  const onKeyDown = (e: KeyboardEvent) => {
    if (!keysOn() || e.repeat) return;
    const target = e.target as Element;
    if (e.key === "Enter") {
      // A button keeps Enter, and a text area its line breaks.
      if (target instanceof HTMLButtonElement) return;
      if (target instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey))
        return;
      e.preventDefault();
      if (e.shiftKey) props.onPrev();
      else props.onNext();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = shortcutOf(e);
    if (key && !skipped() && bodyKeys?.(key, target)) e.preventDefault();
  };
  return (
    <div
      class={cls.card}
      classList={{ [cls.keysOn]: keysOn() }}
      onKeyDown={onKeyDown}
    >
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
            onClick={() => {
              const skip = !skipped();
              props.onSkip(skip);
              if (skip) props.onNext();
            }}
            class={cls.skipBtn}
            classList={{ [cls.skipBtnOn]: skipped() }}
          >
            {skipped() ? i18n.t("respond.skipped") : i18n.t("respond.skip")}
          </button>
        </Show>
      </div>
      <h3
        id={promptId}
        ref={(el) => props.promptRef?.(el)}
        tabindex={-1}
        class={cls.qPrompt}
      >
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
              labelId={promptId}
              maxTextBytes={props.maxTextBytes}
              hideSchema={hideSchema()}
              noneLabel={props.noneLabel}
              shortcuts={(handler) => (bodyKeys = handler)}
              onChange={props.onChange}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};

/**
 * The letter or digit a key types. A letter in another script stands for the
 * Latin letter on its key, so the badges work on a Cyrillic layout too.
 */
function shortcutOf(e: KeyboardEvent): Shortcut | undefined {
  if (/^[0-9]$/.test(e.key)) return { digit: Number(e.key) };
  const latin = /^[a-z]$/i.test(e.key)
    ? e.key.toUpperCase()
    : /^\p{L}$/u.test(e.key) && /^Key[A-Z]$/.test(e.code)
      ? e.code.slice(3)
      : undefined;
  return latin === undefined ? undefined : { letter: latin.charCodeAt(0) - 65 };
}

/**
 * Moves focus to a prompt further down a list of cards, scrolled to the middle
 * of the viewport, clear of a sticky bar at either edge.
 */
export function focusPrompt(el: HTMLElement | undefined): void {
  el?.focus({ preventScroll: true });
  el?.scrollIntoView({ block: "center" });
}
