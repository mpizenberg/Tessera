/**
 * The per-question body components — the single implementation of the CIP-179
 * answering controls, consumed by both the Tessera app and the
 * `<tessera-respond>` widget so their behavior cannot drift. Each takes
 * `(q, v, onChange)` and the id of the prompt that names its controls; the
 * drafts and their `draftState()` come from
 * `cardano-tessera-respond-core`. Strings come from the injected i18n (`useI18n()`),
 * class names from the injected map (`useClasses()`, identity by default).
 * A body with shortcut keys hands their handler to its card, which listens.
 */

import {
  For,
  Show,
  createMemo,
  createUniqueId,
  type Component,
} from "solid-js";

import { utf8ByteLength, type Question } from "cip-179";
import {
  hasNoneBox,
  initDraft,
  optionCount,
  type DraftValue,
} from "cardano-tessera-respond-core";

import { useI18n } from "./i18n-context";
import { useClasses } from "./classes-context";
import {
  clampStep,
  labelFor,
  pointsStride,
  range,
  ratingLevels,
} from "./shared";

/** A shortcut key: a letter by its position from A as 0, or a digit. */
export type Shortcut = { letter: number } | { digit: number };

/**
 * Acts on a shortcut pressed with the focus on `target`, in the body or on its
 * prompt. False when the key means nothing to the body.
 */
export type ShortcutHandler = (key: Shortcut, target: Element) => boolean;

/** The letter that picks the option at position `at`; past Z, none. */
const KeyBadge: Component<{ at: number }> = (props) => {
  const cls = useClasses();
  return (
    <Show when={props.at < 26}>
      <kbd aria-hidden="true" class={cls.keyBadge}>
        {String.fromCharCode(65 + props.at)}
      </kbd>
    </Show>
  );
};

const SingleChoiceBody: Component<{
  q: Extract<Question, { type: "singleChoice" }>;
  v: Extract<DraftValue, { type: "singleChoice" }>;
  labelId: string;
  shortcuts: (handler: ShortcutHandler) => void;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const name = createUniqueId();
  const inputs: HTMLInputElement[] = [];
  let group!: HTMLDivElement;
  props.shortcuts((key, target) => {
    if (!("letter" in key) || key.letter >= optionCount(props.q.options))
      return false;
    props.onChange({ type: "singleChoice", optionIndex: key.letter });
    // In the group, the focus goes with the check, as an arrow key takes it.
    if (group.contains(target)) inputs[key.letter]?.focus();
    return true;
  });
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-labelledby={props.labelId}
      aria-required={props.q.required}
      class={cls.optionGroup}
    >
      <For each={range(optionCount(props.q.options))}>
        {(i) => {
          const on = () => props.v.optionIndex === i;
          return (
            <label
              class={cls.optionRow}
              classList={{ [cls.optionRowOn]: on() }}
            >
              <input
                ref={(el) => (inputs[i] = el)}
                type="radio"
                name={name}
                checked={on()}
                onChange={() =>
                  props.onChange({ type: "singleChoice", optionIndex: i })
                }
                class={cls.choiceInput}
              />
              <span
                aria-hidden="true"
                class={cls.radio}
                classList={{ [cls.radioOn]: on() }}
              >
                <Show when={on()}>
                  <span class={cls.radioDot} />
                </Show>
              </span>
              <span>{labelFor(i18n, props.q.options, i)}</span>
              <KeyBadge at={i} />
            </label>
          );
        }}
      </For>
    </div>
  );
};

const MultiSelectBody: Component<{
  q: Extract<Question, { type: "multiSelect" }>;
  v: Extract<DraftValue, { type: "multiSelect" }>;
  labelId: string;
  noneLabel: string | undefined;
  shortcuts: (handler: ShortcutHandler) => void;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const count = optionCount(props.q.options);
  const selected = () => props.v.selected ?? [];
  const noneChosen = () => props.v.selected?.length === 0;
  const set = (next: readonly number[] | null) =>
    props.onChange({ type: "multiSelect", selected: next });
  const toggle = (i: number) => {
    const picked = new Set(selected());
    if (picked.has(i)) picked.delete(i);
    else if (picked.size < props.q.maxSelections) picked.add(i);
    else return;
    // `[]` belongs to "None of these": unchecking the last option unsets.
    set(picked.size > 0 ? [...picked].sort((a, b) => a - b) : null);
  };
  const toggleNone = () => set(noneChosen() ? null : []);
  // The None box takes the letter after the last option.
  props.shortcuts((key) => {
    if (!("letter" in key)) return false;
    if (key.letter < count) toggle(key.letter);
    else if (key.letter === count && hasNoneBox(props.q)) toggleNone();
    else return false;
    return true;
  });
  return (
    <>
      <div role="group" aria-labelledby={props.labelId} class={cls.multiGrid}>
        <For each={range(count)}>
          {(i) => (
            <CheckRow
              on={selected().includes(i)}
              onToggle={() => toggle(i)}
              label={labelFor(i18n, props.q.options, i)}
              at={i}
            />
          )}
        </For>
        <Show when={hasNoneBox(props.q)}>
          <CheckRow
            on={noneChosen()}
            onToggle={toggleNone}
            label={props.noneLabel ?? i18n.t("respond.noneOfThese")}
            at={count}
          />
        </Show>
      </div>
      <div class={cls.multiCount}>
        {i18n.t("respond.multiSelectCount", {
          min: i18n.n(props.q.minSelections),
          max: i18n.n(props.q.maxSelections),
          chosen: i18n.n(selected().length),
        })}
      </div>
    </>
  );
};

const CheckRow: Component<{
  on: boolean;
  onToggle: () => void;
  label: string;
  /** The row's position, which names its letter key. */
  at: number;
}> = (props) => {
  const cls = useClasses();
  return (
    <label class={cls.optionRow} classList={{ [cls.optionRowOn]: props.on }}>
      <input
        type="checkbox"
        checked={props.on}
        onChange={(e) => {
          props.onToggle();
          // The box flips itself first, and a pick past the maximum is
          // refused: it takes the state back.
          e.currentTarget.checked = props.on;
        }}
        class={cls.choiceInput}
      />
      <span
        aria-hidden="true"
        class={cls.checkbox}
        classList={{ [cls.checkboxOn]: props.on }}
      >
        <Show when={props.on}>✓</Show>
      </span>
      <span>{props.label}</span>
      <KeyBadge at={props.at} />
    </label>
  );
};

const RankingBody: Component<{
  q: Extract<Question, { type: "ranking" }>;
  v: Extract<DraftValue, { type: "ranking" }>;
  labelId: string;
  shortcuts: (handler: ShortcutHandler) => void;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const count = optionCount(props.q.options);
  const ranked = () => props.v.ranked;
  const full = () => ranked().length >= props.q.maxRanked;
  const pool = () => range(count).filter((i) => !ranked().includes(i));
  const set = (next: number[]) =>
    props.onChange({ type: "ranking", ranked: next });
  // A pressed button that leaves its list takes the focus with it: the one
  // now in its place takes it, or else the one before, or else the item's
  // button in the other list. Both lists are keyed by option index. A letter
  // key adds an item without its button, and the focus stays where it is.
  const removeBtns = new Map<number, HTMLButtonElement>();
  const poolBtns = new Map<number, HTMLButtonElement>();
  const near = (list: readonly number[], at: number) =>
    list[Math.min(at, list.length - 1)];
  const focused = (el: HTMLElement | undefined) =>
    el !== undefined &&
    (el.getRootNode() as Document | ShadowRoot).activeElement === el;
  const add = (i: number) => {
    if (full()) return;
    const held = focused(poolBtns.get(i));
    const at = pool().indexOf(i);
    set([...ranked(), i]);
    if (!held) return;
    const next = full() ? undefined : near(pool(), at);
    (next === undefined ? removeBtns.get(i) : poolBtns.get(next))?.focus();
  };
  const remove = (i: number) => {
    const at = ranked().indexOf(i);
    set(ranked().filter((x) => x !== i));
    const next = near(ranked(), at);
    (next === undefined ? poolBtns.get(i) : removeBtns.get(next))?.focus();
  };
  props.shortcuts((key) => {
    if (!("letter" in key) || key.letter >= count) return false;
    if (!ranked().includes(key.letter)) add(key.letter);
    return true;
  });
  // Reordering moves the row's element, which drops the focus it holds.
  const move = (btn: HTMLButtonElement, idx: number, delta: number) => {
    const next = [...ranked()];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    set(next);
    btn.focus();
  };
  return (
    <div role="group" aria-labelledby={props.labelId}>
      <Show when={ranked().length > 0}>
        <div class={cls.rankedList}>
          <For each={ranked()}>
            {(optIdx, pos) => (
              <div class={cls.rankedRow}>
                <span class={cls.rankNum}>{pos() + 1}</span>
                <span class={cls.rankLabel}>
                  {labelFor(i18n, props.q.options, optIdx)}
                </span>
                <button
                  class={cls.rankBtn}
                  onClick={(e) => move(e.currentTarget, pos(), -1)}
                  aria-label={i18n.t("respond.rankMoveUp")}
                >
                  ↑
                </button>
                <button
                  class={cls.rankBtn}
                  onClick={(e) => move(e.currentTarget, pos(), 1)}
                  aria-label={i18n.t("respond.rankMoveDown")}
                >
                  ↓
                </button>
                <button
                  ref={(el) => removeBtns.set(optIdx, el)}
                  class={`${cls.rankBtn} ${cls.rankBtnDanger}`}
                  onClick={() => remove(optIdx)}
                  aria-label={i18n.t("respond.rankRemove")}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={pool().length > 0}>
        <div class={cls.rankPoolHint}>
          {i18n.t("respond.rankPoolHint", {
            min: i18n.n(props.q.minRanked),
            max: i18n.n(props.q.maxRanked),
          })}
        </div>
        <div class={cls.rankPool}>
          <For each={pool()}>
            {(i) => (
              <button
                ref={(el) => poolBtns.set(i, el)}
                onClick={() => add(i)}
                disabled={full()}
                class={cls.poolBtn}
                classList={{ [cls.poolBtnDisabled]: full() }}
              >
                + {labelFor(i18n, props.q.options, i)}
                <KeyBadge at={i} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

const NumericBody: Component<{
  q: Extract<Question, { type: "numericRange" }>;
  v: Extract<DraftValue, { type: "numeric" }>;
  labelId: string;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const { min, max } = props.q.constraints;
  const step = props.q.constraints.step ?? 1n;
  // The slider is the only control, so it must offer every step: position p is
  // min + p × step, which keeps the input's JS numbers small at any bounds. Past
  // 100 000 positions the track is too fine to aim and a number field takes over.
  const positions = step > 0n ? (max - min) / step : 0n;
  // A range input fires no input event for a value it already holds, so an
  // unset slider rests mid-track: either bound is then one click or key away.
  const rest = positions / 2n;
  const unset = () => props.v.value === null;
  const set = (value: bigint | null) =>
    props.onChange({ type: "numeric", value });
  return (
    <>
      <div class={cls.numHero}>
        <span class={cls.numValue}>{props.v.value?.toString() ?? "—"}</span>
      </div>
      <Show
        when={positions > 0n && positions <= 100000n}
        fallback={
          <input
            type="number"
            aria-labelledby={props.labelId}
            aria-required={props.q.required}
            value={props.v.value?.toString() ?? ""}
            min={min.toString()}
            max={max.toString()}
            step={step.toString()}
            onInput={(e) => {
              const raw = e.currentTarget.value.trim();
              if (raw === "") return set(null);
              try {
                set(clampStep(BigInt(raw), min, max, step));
              } catch {
                /* ignore non-integer input */
              }
            }}
            class={cls.numberInput}
          />
        }
      >
        <input
          type="range"
          aria-labelledby={props.labelId}
          min={0}
          max={Number(positions)}
          step={1}
          value={Number(
            props.v.value === null ? rest : (props.v.value - min) / step,
          )}
          aria-valuetext={
            unset() ? i18n.t("respond.numericUnset") : props.v.value?.toString()
          }
          onInput={(e) => set(min + BigInt(e.currentTarget.value) * step)}
          class={cls.rangeFull}
          classList={{ [cls.rangeUnset]: unset() }}
        />
        <div class={cls.rangeBounds}>
          <span>{min.toString()}</span>
          <span>{max.toString()}</span>
        </div>
      </Show>
    </>
  );
};

const PointsBody: Component<{
  q: Extract<Question, { type: "pointsAllocation" }>;
  v: Extract<DraftValue, { type: "pointsAllocation" }>;
  labelId: string;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const pointsAt = (i: number): bigint => props.v.points[i] ?? 0n;
  const sum = () => props.v.points.reduce((s, p) => s + p, 0n);
  const remaining = () => props.q.budget - sum();
  // Clamp to [0, budget − others] so a single field can never push the total
  // over budget — the same invariant the +/- buttons enforce.
  const capped = (i: number, raw: bigint): bigint => {
    const cap = props.q.budget - (sum() - pointsAt(i));
    return raw < 0n ? 0n : raw > cap ? cap : raw;
  };
  const setPoints = (i: number, raw: bigint) => {
    const next = [...props.v.points];
    next[i] = capped(i, raw);
    props.onChange({ type: "pointsAllocation", points: next });
  };
  const stride = pointsStride(props.q.budget);
  const positions = (props.q.budget + stride - 1n) / stride;
  const positionOf = (points: bigint): bigint =>
    (points + stride / 2n) / stride;
  const budgetDigits = props.q.budget.toString().length;
  const bump = (i: number, delta: bigint) => setPoints(i, pointsAt(i) + delta);
  // Capped slider: the track keeps its full 0..budget range, but the thumb is
  // blocked past the remaining budget. We clamp the dragged value and write its
  // position back onto the element so the thumb snaps to the cap — Solid won't
  // re-render the input if the clamped value matches state.
  const slideTo = (i: number, el: HTMLInputElement) => {
    const value = capped(i, BigInt(el.value) * stride);
    el.value = positionOf(value).toString();
    setPoints(i, value);
  };
  return (
    <div role="group" aria-labelledby={props.labelId}>
      <div class={cls.pointsHeader}>
        <span class={cls.pointsRemainLabel}>
          {i18n.t("respond.pointsRemainLabel")}
        </span>
        <span
          class={cls.pointsRemain}
          classList={{ [cls.pointsRemainDone]: remaining() === 0n }}
        >
          {i18n.t("respond.pointsRemain", { n: i18n.n(remaining()) })}
        </span>
      </div>
      <For each={range(optionCount(props.q.options))}>
        {(i) => {
          const optId = createUniqueId();
          return (
            <div class={cls.pointsRow}>
              <div class={cls.pointsRowHead}>
                <span id={optId} class={cls.pointsOptLabel}>
                  {labelFor(i18n, props.q.options, i)}
                </span>
                <div class={cls.pointsControls}>
                  <button class={cls.stepBtn} onClick={() => bump(i, -stride)}>
                    −
                  </button>
                  <input
                    type="number"
                    aria-labelledby={optId}
                    min="0"
                    max={props.q.budget.toString()}
                    value={pointsAt(i).toString()}
                    style={{ width: `calc(${budgetDigits}ch + 25px)` }}
                    onInput={(e) => {
                      const raw = e.currentTarget.value.trim();
                      if (raw === "") return setPoints(i, 0n);
                      try {
                        setPoints(i, BigInt(raw));
                      } catch {
                        /* ignore non-integer input */
                      }
                    }}
                    class={cls.pointsInput}
                  />
                  <button class={cls.stepBtn} onClick={() => bump(i, stride)}>
                    +
                  </button>
                </div>
              </div>
              <input
                type="range"
                aria-labelledby={optId}
                min={0}
                max={Number(positions)}
                step={1}
                value={Number(positionOf(pointsAt(i)))}
                aria-valuetext={pointsAt(i).toString()}
                onInput={(e) => slideTo(i, e.currentTarget)}
                class={cls.rangeFullBlock}
              />
            </div>
          );
        }}
      </For>
      <div class={cls.pointsFooter}>
        {i18n.t("respond.pointsFooter", { budget: i18n.n(props.q.budget) })}
      </div>
    </div>
  );
};

const RatingBody: Component<{
  q: Extract<Question, { type: "rating" }>;
  v: Extract<DraftValue, { type: "rating" }>;
  labelId: string;
  shortcuts: (handler: ShortcutHandler) => void;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const count = optionCount(props.q.options);
  const levels = ratingLevels(props.q.scale);
  // Each item must be rated only when the question can't be skipped and
  // takes no subset.
  const itemRequired = () => props.q.required && props.q.requireAll;
  // `null` clears the option back to unrated — meaningful when a subset answer
  // is valid (require_all = false), and harmless otherwise.
  const setRating = (optIdx: number, rating: bigint | null) => {
    const next = [...props.v.ratings];
    next[optIdx] = rating;
    props.onChange({ type: "rating", ratings: next });
  };
  // A digit sets the level it labels, or on a scale of words the level at its
  // position. A scale with a label that is not one digit takes none, so that
  // typing 10 can't set the level labelled 0.
  const digits =
    levels === null
      ? []
      : props.q.scale.type === "labels"
        ? levels.length <= 9
          ? levels.map((_, i) => String(i + 1))
          : []
        : levels.every((l) => /^[0-9]$/.test(l.label))
          ? levels.map((l) => l.label)
          : [];
  const groups: HTMLDivElement[] = [];
  props.shortcuts((key, target) => {
    if (!("digit" in key)) return false;
    const level = digits.indexOf(String(key.digit));
    const held = groups.findIndex((g) => g.contains(target));
    const item = held === -1 && count === 1 ? 0 : held;
    if (level === -1 || item === -1) return false;
    setRating(item, levels![level]!.value);
    if (held !== -1) groups[held]!.querySelectorAll("input")[level]?.focus();
    return true;
  });
  return (
    <div role="group" aria-labelledby={props.labelId} class={cls.ratingList}>
      <For each={range(count)}>
        {(optIdx) => {
          const itemId = createUniqueId();
          return (
            <div class={cls.ratingRow}>
              <span id={itemId} class={cls.ratingOptLabel}>
                {labelFor(i18n, props.q.options, optIdx)}
              </span>
              <Show
                when={levels}
                fallback={
                  <input
                    type="number"
                    aria-labelledby={itemId}
                    aria-required={itemRequired()}
                    value={props.v.ratings[optIdx]?.toString() ?? ""}
                    onInput={(e) => {
                      const raw = e.currentTarget.value.trim();
                      if (raw === "") {
                        setRating(optIdx, null); // emptied → unrated
                        return;
                      }
                      try {
                        setRating(optIdx, BigInt(raw));
                      } catch {
                        /* ignore */
                      }
                    }}
                    class={cls.ratingNumberInput}
                  />
                }
              >
                {/* Takes the focus Safari gives no clicked level, so its
                    keys reach this item. */}
                <div
                  ref={(el) => (groups[optIdx] = el)}
                  tabindex={-1}
                  role="radiogroup"
                  aria-labelledby={itemId}
                  aria-required={itemRequired()}
                  onKeyDown={(e) => {
                    if (e.key !== "Delete" && e.key !== "Backspace") return;
                    e.preventDefault();
                    setRating(optIdx, null);
                  }}
                  class={cls.ratingLevels}
                >
                  <For each={levels!}>
                    {(lvl) => {
                      const on = () => props.v.ratings[optIdx] === lvl.value;
                      return (
                        <label
                          class={cls.ratingBtn}
                          classList={{ [cls.ratingBtnOn]: on() }}
                        >
                          <input
                            type="radio"
                            name={itemId}
                            checked={on()}
                            // Clicking the chosen level clears it: the click
                            // runs before any change, while the level still
                            // reads as chosen.
                            onClick={() => on() && setRating(optIdx, null)}
                            onChange={() => setRating(optIdx, lvl.value)}
                            class={cls.choiceInput}
                          />
                          {lvl.label}
                        </label>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
      <p class={cls.ratHint}>
        {props.q.requireAll
          ? i18n.t("respond.ratingRequireAll")
          : i18n.t("respond.ratingAllowSubset")}
      </p>
    </div>
  );
};

const CustomBody: Component<{
  q: Extract<Question, { type: "custom" }>;
  v: Extract<DraftValue, { type: "custom" }>;
  labelId: string;
  maxTextBytes: number | undefined;
  hideSchema: boolean;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const used = () => utf8ByteLength(props.v.text);
  return (
    <>
      <Show when={!props.hideSchema}>
        <div class={cls.customSchema}>
          <span class={cls.customSchemaTag}>
            {i18n.t("respond.customSchemaTag")}
          </span>
          <span class={cls.customSchemaUri}>{props.q.methodSchema.uri}</span>
        </div>
      </Show>
      <textarea
        aria-labelledby={props.labelId}
        aria-required={props.q.required}
        rows={3}
        value={props.v.text}
        placeholder={i18n.t("respond.customPlaceholder")}
        onInput={(e) =>
          props.onChange({ type: "custom", text: e.currentTarget.value })
        }
        class={cls.customInput}
      />
      <Show when={props.maxTextBytes}>
        {(max) => (
          <p
            class={cls.customBytes}
            classList={{ [cls.customBytesOver]: used() > max() }}
          >
            {i18n.t("respond.customBytes", {
              used: i18n.n(used()),
              max: i18n.n(max()),
            })}
          </p>
        )}
      </Show>
      <Show when={!props.hideSchema}>
        <p class={cls.customHint}>{i18n.t("respond.customHint")}</p>
      </Show>
    </>
  );
};

/** The draft-value type each question type renders with (identity except `numericRange` → `numeric`). */
const DRAFT_TYPE = {
  singleChoice: "singleChoice",
  multiSelect: "multiSelect",
  ranking: "ranking",
  numericRange: "numeric",
  pointsAllocation: "pointsAllocation",
  rating: "rating",
  custom: "custom",
} as const satisfies Record<Question["type"], DraftValue["type"]>;

/**
 * Pick the body for the question's type, passing the draft value reactively.
 * Question type and draft-value type match by construction, so the casts are
 * type-narrowing only (no runtime effect); value edits flow reactively with no
 * remount, so text/number inputs keep focus.
 *
 * The one exception is a host contract violation: re-setting the definition
 * with a different question *shape* while edited drafts survive (reseeding is
 * gated on pristine forms). A stale draft of the wrong type would crash the
 * body it's cast into, so the guard below renders from a fresh initial value
 * instead — the next edit writes a matching draft back to the store.
 *
 * The switch itself runs once, at creation — `q` must stay the same question
 * for this component's lifetime (some bodies also capture constraints at
 * setup). Parents mount one QuestionBody per question: the list layout does so
 * naturally, and the stepper keys its single card by the current question.
 */
export const QuestionBody: Component<{
  q: Question;
  value: DraftValue;
  /** The prompt's id, naming the body's controls. */
  labelId: string;
  /** Cap on a custom answer's UTF-8 length, shown as a byte count. */
  maxTextBytes?: number | undefined;
  /** Leave out a custom question's schema anchor and the hint that names it. */
  hideSchema?: boolean;
  /** A multi-select's None box label, in place of the catalog's. */
  noneLabel?: string | undefined;
  /** Receives the body's shortcut handler, if it has keys. */
  shortcuts: (handler: ShortcutHandler) => void;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  type V<T extends DraftValue["type"]> = Extract<DraftValue, { type: T }>;
  type Q<T extends Question["type"]> = Extract<Question, { type: T }>;
  const value = createMemo<DraftValue>(() =>
    props.value.type === DRAFT_TYPE[props.q.type]
      ? props.value
      : initDraft(props.q).value,
  );
  switch (props.q.type) {
    case "singleChoice":
      return (
        <SingleChoiceBody
          q={props.q as Q<"singleChoice">}
          v={value() as V<"singleChoice">}
          shortcuts={props.shortcuts}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
    case "multiSelect":
      return (
        <MultiSelectBody
          q={props.q as Q<"multiSelect">}
          v={value() as V<"multiSelect">}
          shortcuts={props.shortcuts}
          noneLabel={props.noneLabel}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
    case "ranking":
      return (
        <RankingBody
          q={props.q as Q<"ranking">}
          v={value() as V<"ranking">}
          shortcuts={props.shortcuts}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
    case "numericRange":
      return (
        <NumericBody
          q={props.q as Q<"numericRange">}
          v={value() as V<"numeric">}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
    case "pointsAllocation":
      return (
        <PointsBody
          q={props.q as Q<"pointsAllocation">}
          v={value() as V<"pointsAllocation">}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
    case "rating":
      return (
        <RatingBody
          q={props.q as Q<"rating">}
          v={value() as V<"rating">}
          shortcuts={props.shortcuts}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
    case "custom":
      return (
        <CustomBody
          q={props.q as Q<"custom">}
          v={value() as V<"custom">}
          maxTextBytes={props.maxTextBytes}
          hideSchema={props.hideSchema ?? false}
          labelId={props.labelId}
          onChange={props.onChange}
        />
      );
  }
};
