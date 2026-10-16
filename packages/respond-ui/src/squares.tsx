/**
 * One square per question, each a button to its question: how far the form
 * got at a glance, and a way to reach any question. The squares are one Tab
 * stop; the arrow keys, Home and End move between them.
 */

import {
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js";

import type { KeptDraft, MsgKey } from "cardano-tessera-respond-core";

import { useClasses, type BodyClassName } from "./classes-context";
import { useI18n } from "./i18n-context";
import type { QuestionProgress } from "./response-draft";
import { squaresRules } from "./squares-layout";

/** A question left unanswered is told apart by whether it was seen. */
type SquareState =
  Exclude<QuestionProgress, "unanswered"> | "unseen" | "passed";

const LOOK: Record<SquareState, { cls: BodyClassName; name: MsgKey }> = {
  unseen: { cls: "sqUnseen", name: "respond.squareUnseen" },
  passed: { cls: "sqPassed", name: "respond.squarePassed" },
  answered: { cls: "sqAnswered", name: "respond.squareAnswered" },
  skipped: { cls: "sqSkipped", name: "respond.squareSkipped" },
  unfinished: { cls: "sqUnfinished", name: "respond.squareUnfinished" },
  hidden: { cls: "sqHidden", name: "respond.squareHidden" },
};

export const ProgressSquares: Component<{
  progress: readonly QuestionProgress[];
  /** Index-aligned with `progress`, for whether each question was seen. */
  drafts: readonly Pick<KeptDraft, "seen">[];
  /** The question on screen, ringed. */
  current?: number | undefined;
  onGoTo: (index: number) => void;
  /**
   * Width kept for `prev` and `next` either side of the squares. Without
   * that room, the squares go above them, and `count` shows between them.
   */
  room?: number | undefined;
  prev?: JSX.Element;
  next?: JSX.Element;
  /** Read by a screen reader only while the squares are between the buttons. */
  count?: JSX.Element;
  /** On a touch screen, one line scrolling sideways in place of lines. */
  scroll?: boolean | undefined;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const name = `tessera-squares-${createUniqueId()}`;

  const state = (i: number): SquareState => {
    const p = props.progress[i] ?? "unanswered";
    if (p !== "unanswered") return p;
    return props.drafts[i]?.seen ? "passed" : "unseen";
  };
  const shows = (i: number) => props.progress[i] !== "hidden";
  const shownFrom = (from: number, dir: 1 | -1): number | undefined => {
    for (let i = from + dir; i >= 0 && i < props.progress.length; i += dir)
      if (shows(i)) return i;
    return undefined;
  };

  // The one square Tab reaches: the last focused, or the current question.
  const [active, setActive] = createSignal(0);
  createEffect(() => {
    if (props.current !== undefined) setActive(props.current);
  });
  const tabStop = createMemo(() => {
    let i = Math.min(active(), props.progress.length - 1);
    while (i > 0 && !shows(i)) i--;
    return i;
  });
  const buttons: HTMLButtonElement[] = [];
  const onKeyDown = (e: KeyboardEvent) => {
    const from = tabStop();
    const to =
      e.key === "ArrowRight"
        ? shownFrom(from, 1)
        : e.key === "ArrowLeft"
          ? shownFrom(from, -1)
          : e.key === "Home"
            ? shownFrom(-1, 1)
            : e.key === "End"
              ? shownFrom(props.progress.length, -1)
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    setActive(to);
    buttons[to]?.focus();
  };

  let row!: HTMLDivElement;
  let line!: HTMLDivElement;
  // A constructed sheet, unlike a `<style>` element, passes a host's
  // Content-Security-Policy without 'unsafe-inline'. Where there is none,
  // the squares wrap as inline buttons.
  const sheet = constructedSheet();
  const count = createMemo(() => props.progress.length);
  createEffect(() =>
    sheet?.replaceSync(
      squaresRules({
        name,
        count: count(),
        room: props.room,
        scroll: props.scroll,
      }),
    ),
  );
  onMount(() => {
    const root = row.getRootNode();
    if (!sheet || !(root instanceof Document || root instanceof ShadowRoot))
      return;
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    onCleanup(() => {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter(
        (s) => s !== sheet,
      );
    });
  });

  // A scrolling line: which edges hide squares, and the square just answered
  // or skipped brought to the middle, unless a finger holds the line.
  const [scrolled, setScrolled] = createSignal(false);
  const [atEnd, setAtEnd] = createSignal(false);
  let touching = false;
  const onScroll = () => {
    setScrolled(line.scrollLeft > 1);
    setAtEnd(line.scrollLeft + line.clientWidth >= line.scrollWidth - 1);
  };
  createEffect(
    on(
      () => props.progress,
      (now, before) => {
        if (!props.scroll || touching || now.length !== before?.length) return;
        const changed = now.flatMap((p, i) => (p === before[i] ? [] : [i]));
        const sq = changed.length === 1 ? buttons[changed[0]!] : undefined;
        if (!sq) return;
        const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
        line.scrollTo({
          left: sq.offsetLeft + sq.offsetWidth / 2 - line.clientWidth / 2,
          behavior: still ? "auto" : "smooth",
        });
      },
    ),
  );

  const squares = () => (
    <div
      ref={line}
      role="toolbar"
      aria-label={i18n.t("respond.squares")}
      data-squares=""
      data-scrolled={scrolled() ? "" : undefined}
      data-end={atEnd() ? "" : undefined}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onTouchStart={() => (touching = true)}
      onTouchEnd={() => (touching = false)}
      onTouchCancel={() => (touching = false)}
    >
      <Index each={props.progress}>
        {(_, i) => {
          const look = () => LOOK[state(i)];
          const label = () => i18n.t(look().name, { n: i18n.n(i + 1) });
          const classes = () =>
            `${cls.sq} ${cls[look().cls]}${i >= 99 ? ` ${cls.sqLong}` : ""}`;
          return (
            <Show
              when={shows(i)}
              fallback={
                <span
                  role="img"
                  class={classes()}
                  aria-label={label()}
                  title={label()}
                />
              }
            >
              <button
                ref={(el) => (buttons[i] = el)}
                type="button"
                class={classes()}
                tabindex={i === tabStop() ? 0 : -1}
                aria-current={i === props.current ? "step" : undefined}
                aria-label={label()}
                title={label()}
                onFocus={() => setActive(i)}
                onClick={() => props.onGoTo(i)}
              >
                {i18n.n(i + 1)}
              </button>
            </Show>
          );
        }}
      </Index>
    </div>
  );

  return (
    <div ref={row} data-squares-row={name}>
      <Show when={props.room !== undefined} fallback={squares()}>
        <div data-squares-nav="">
          <div data-squares-prev="">{props.prev}</div>
          {squares()}
          <div data-squares-count="">{props.count}</div>
          <div data-squares-next="">{props.next}</div>
        </div>
      </Show>
    </div>
  );
};

function constructedSheet(): CSSStyleSheet | undefined {
  try {
    return new CSSStyleSheet();
  } catch {
    return undefined;
  }
}
