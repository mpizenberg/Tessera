/**
 * The per-question body components — the single implementation of the CIP-179
 * answering controls, consumed by both the Tessera app and the
 * `<tessera-respond>` widget so their behavior cannot drift. Each takes
 * `(q, v, onChange)`; the draft store and `decided()` gating come from
 * `cardano-tessera-respond-core`. Strings come from the injected i18n (`useI18n()`),
 * class names from the injected map (`useClasses()`, identity by default).
 */

import { For, Show, createMemo, type Component } from "solid-js";

import type { Question } from "cip-179";
import {
  initDraft,
  optionCount,
  type DraftValue,
} from "cardano-tessera-respond-core";

import { useI18n } from "./i18n-context";
import { useClasses } from "./classes-context";
import {
  activateOnKey,
  clampStep,
  labelFor,
  range,
  ratingLevels,
} from "./shared";

const SingleChoiceBody: Component<{
  q: Extract<Question, { type: "singleChoice" }>;
  v: Extract<DraftValue, { type: "singleChoice" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  return (
    <div role="radiogroup" class={cls.optionGroup}>
      <For each={range(optionCount(props.q.options))}>
        {(i) => {
          const on = () => props.v.optionIndex === i;
          const pick = () =>
            props.onChange({ type: "singleChoice", optionIndex: i });
          return (
            <div
              role="radio"
              tabindex={0}
              aria-checked={on()}
              onClick={pick}
              onKeyDown={activateOnKey(pick)}
              class={cls.optionRow}
              classList={{ [cls.optionRowOn]: on() }}
            >
              <span class={cls.radio} classList={{ [cls.radioOn]: on() }}>
                <Show when={on()}>
                  <span class={cls.radioDot} />
                </Show>
              </span>
              <span>{labelFor(i18n, props.q.options, i)}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
};

const MultiSelectBody: Component<{
  q: Extract<Question, { type: "multiSelect" }>;
  v: Extract<DraftValue, { type: "multiSelect" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const toggle = (i: number) => {
    const set = new Set(props.v.selected);
    if (set.has(i)) set.delete(i);
    else if (props.v.selected.length < props.q.maxSelections) set.add(i);
    props.onChange({
      type: "multiSelect",
      selected: [...set].sort((a, b) => a - b),
    });
  };
  return (
    <>
      <div class={cls.multiGrid}>
        <For each={range(optionCount(props.q.options))}>
          {(i) => {
            const on = () => props.v.selected.includes(i);
            return (
              <div
                role="checkbox"
                tabindex={0}
                aria-checked={on()}
                onClick={() => toggle(i)}
                onKeyDown={activateOnKey(() => toggle(i))}
                class={cls.optionRow}
                classList={{ [cls.optionRowOn]: on() }}
              >
                <span
                  class={cls.checkbox}
                  classList={{ [cls.checkboxOn]: on() }}
                >
                  <Show when={on()}>✓</Show>
                </span>
                <span>{labelFor(i18n, props.q.options, i)}</span>
              </div>
            );
          }}
        </For>
      </div>
      <div class={cls.multiCount}>
        {i18n.t("respond.multiSelectCount", {
          min: i18n.n(props.q.minSelections),
          max: i18n.n(props.q.maxSelections),
          chosen: i18n.n(props.v.selected.length),
        })}
      </div>
      <Show when={props.q.minSelections === 0}>
        <div class={cls.noneNote}>
          <span class={cls.noneNoteText}>
            <b class={cls.noneNoteLead}>{i18n.t("respond.noneLead")}</b>{" "}
            {i18n.t("respond.noneNote")}
          </span>
        </div>
      </Show>
    </>
  );
};

const RankingBody: Component<{
  q: Extract<Question, { type: "ranking" }>;
  v: Extract<DraftValue, { type: "ranking" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const ranked = () => props.v.ranked;
  const pool = () =>
    range(optionCount(props.q.options)).filter((i) => !ranked().includes(i));
  const set = (next: number[]) =>
    props.onChange({ type: "ranking", ranked: next });
  const add = (i: number) => {
    if (ranked().length < props.q.maxRanked) set([...ranked(), i]);
  };
  const remove = (i: number) => set(ranked().filter((x) => x !== i));
  const move = (idx: number, delta: number) => {
    const next = [...ranked()];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    set(next);
  };
  return (
    <>
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
                  onClick={() => move(pos(), -1)}
                  aria-label={i18n.t("respond.rankMoveUp")}
                >
                  ↑
                </button>
                <button
                  class={cls.rankBtn}
                  onClick={() => move(pos(), 1)}
                  aria-label={i18n.t("respond.rankMoveDown")}
                >
                  ↓
                </button>
                <button
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
                onClick={() => add(i)}
                disabled={ranked().length >= props.q.maxRanked}
                class={cls.poolBtn}
                classList={{
                  [cls.poolBtnDisabled]: ranked().length >= props.q.maxRanked,
                }}
              >
                + {labelFor(i18n, props.q.options, i)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
};

const NumericBody: Component<{
  q: Extract<Question, { type: "numericRange" }>;
  v: Extract<DraftValue, { type: "numeric" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const cls = useClasses();
  const { min, max } = props.q.constraints;
  const step = props.q.constraints.step ?? 1n;
  const span = max - min;
  // The range input works in JS numbers, so both bounds must be exactly
  // representable — a huge min with a small span would otherwise render (and
  // submit) rounded positions. Fall back to the bigint number input if not.
  const safe = (n: bigint): boolean =>
    n <= BigInt(Number.MAX_SAFE_INTEGER) &&
    n >= BigInt(Number.MIN_SAFE_INTEGER);
  const sliderOk = span > 0n && span <= 100000n && safe(min) && safe(max);
  const set = (value: bigint) => props.onChange({ type: "numeric", value });
  return (
    <>
      <div class={cls.numHero}>
        <span class={cls.numValue}>{props.v.value.toString()}</span>
      </div>
      <Show
        when={sliderOk}
        fallback={
          <input
            type="number"
            value={props.v.value.toString()}
            min={min.toString()}
            max={max.toString()}
            step={step.toString()}
            onInput={(e) => {
              const raw = e.currentTarget.value.trim();
              if (raw === "") return;
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
          min={Number(min)}
          max={Number(max)}
          step={Number(step)}
          value={Number(props.v.value)}
          onInput={(e) =>
            set(clampStep(BigInt(e.currentTarget.value), min, max, step))
          }
          class={cls.rangeFull}
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
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const sum = () => props.v.points.reduce((s, p) => s + p, 0);
  const remaining = () => props.q.budget - sum();
  // Clamp to [0, budget − others] so a single field can never push the total
  // over budget — the same invariant the +/- buttons enforce.
  const setPoints = (i: number, raw: number) => {
    const others = sum() - (props.v.points[i] ?? 0);
    const value = Math.max(0, Math.min(raw, props.q.budget - others));
    const next = [...props.v.points];
    next[i] = value;
    props.onChange({ type: "pointsAllocation", points: next });
  };
  const bump = (i: number, delta: number) =>
    setPoints(i, (props.v.points[i] ?? 0) + delta);
  // Capped slider: the track keeps its full 0..budget range, but the thumb is
  // blocked past the remaining budget. We clamp the dragged value and, when it
  // was over the cap, write it back onto the element so the thumb snaps to the
  // cap — Solid won't re-render the input if the clamped value matches state.
  const slideTo = (i: number, el: HTMLInputElement) => {
    const raw = parseInt(el.value, 10) || 0;
    const others = sum() - (props.v.points[i] ?? 0);
    const capped = Math.max(0, Math.min(raw, props.q.budget - others));
    if (capped !== raw) el.value = String(capped);
    setPoints(i, capped);
  };
  return (
    <>
      <div class={cls.pointsHeader}>
        <span class={cls.pointsRemainLabel}>
          {i18n.t("respond.pointsRemainLabel")}
        </span>
        <span
          class={cls.pointsRemain}
          classList={{ [cls.pointsRemainDone]: remaining() === 0 }}
        >
          {i18n.t("respond.pointsRemain", { n: i18n.n(remaining()) })}
        </span>
      </div>
      <For each={range(optionCount(props.q.options))}>
        {(i) => (
          <div class={cls.pointsRow}>
            <div class={cls.pointsRowHead}>
              <span class={cls.pointsOptLabel}>
                {labelFor(i18n, props.q.options, i)}
              </span>
              <div class={cls.pointsControls}>
                <button class={cls.stepBtn} onClick={() => bump(i, -1)}>
                  −
                </button>
                <input
                  type="number"
                  min={0}
                  max={props.q.budget}
                  value={props.v.points[i] ?? 0}
                  onInput={(e) => {
                    const parsed = parseInt(e.currentTarget.value, 10);
                    setPoints(i, Number.isFinite(parsed) ? parsed : 0);
                  }}
                  class={cls.pointsInput}
                />
                <button class={cls.stepBtn} onClick={() => bump(i, 1)}>
                  +
                </button>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={props.q.budget}
              step={1}
              value={props.v.points[i] ?? 0}
              onInput={(e) => slideTo(i, e.currentTarget)}
              class={cls.rangeFullBlock}
            />
          </div>
        )}
      </For>
      <div class={cls.pointsFooter}>
        {i18n.t("respond.pointsFooter", { budget: i18n.n(props.q.budget) })}
      </div>
    </>
  );
};

const RatingBody: Component<{
  q: Extract<Question, { type: "rating" }>;
  v: Extract<DraftValue, { type: "rating" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  const levels = ratingLevels(props.q.scale);
  // `null` clears the option back to unrated — meaningful when a subset answer
  // is valid (require_all = false), and harmless otherwise.
  const setRating = (optIdx: number, rating: bigint | null) => {
    const next = [...props.v.ratings];
    next[optIdx] = rating;
    props.onChange({ type: "rating", ratings: next });
  };
  return (
    <div class={cls.ratingList}>
      <For each={range(optionCount(props.q.options))}>
        {(optIdx) => (
          <div class={cls.ratingRow}>
            <span class={cls.ratingOptLabel}>
              {labelFor(i18n, props.q.options, optIdx)}
            </span>
            <Show
              when={levels}
              fallback={
                <input
                  type="number"
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
              <div class={cls.ratingLevels}>
                <For each={levels!}>
                  {(lvl) => {
                    const on = () => props.v.ratings[optIdx] === lvl.value;
                    return (
                      <button
                        // Clicking the active level clears it (back to unrated).
                        onClick={() =>
                          setRating(optIdx, on() ? null : lvl.value)
                        }
                        aria-pressed={on()}
                        class={cls.ratingBtn}
                        classList={{ [cls.ratingBtnOn]: on() }}
                      >
                        {lvl.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        )}
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
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const i18n = useI18n();
  const cls = useClasses();
  return (
    <>
      <div class={cls.customSchema}>
        <span class={cls.customSchemaTag}>
          {i18n.t("respond.customSchemaTag")}
        </span>
        <span class={cls.customSchemaUri}>{props.q.methodSchema.uri}</span>
      </div>
      <input
        type="text"
        value={props.v.text}
        placeholder={i18n.t("respond.customPlaceholder")}
        onInput={(e) =>
          props.onChange({ type: "custom", text: e.currentTarget.value })
        }
        class={cls.customInput}
      />
      <p class={cls.customHint}>{i18n.t("respond.customHint")}</p>
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
          onChange={props.onChange}
        />
      );
    case "multiSelect":
      return (
        <MultiSelectBody
          q={props.q as Q<"multiSelect">}
          v={value() as V<"multiSelect">}
          onChange={props.onChange}
        />
      );
    case "ranking":
      return (
        <RankingBody
          q={props.q as Q<"ranking">}
          v={value() as V<"ranking">}
          onChange={props.onChange}
        />
      );
    case "numericRange":
      return (
        <NumericBody
          q={props.q as Q<"numericRange">}
          v={value() as V<"numeric">}
          onChange={props.onChange}
        />
      );
    case "pointsAllocation":
      return (
        <PointsBody
          q={props.q as Q<"pointsAllocation">}
          v={value() as V<"pointsAllocation">}
          onChange={props.onChange}
        />
      );
    case "rating":
      return (
        <RatingBody
          q={props.q as Q<"rating">}
          v={value() as V<"rating">}
          onChange={props.onChange}
        />
      );
    case "custom":
      return (
        <CustomBody
          q={props.q as Q<"custom">}
          v={value() as V<"custom">}
          onChange={props.onChange}
        />
      );
  }
};
