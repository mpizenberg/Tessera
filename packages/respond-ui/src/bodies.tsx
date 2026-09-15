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
  pointsStride,
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
  const selected = () => props.v.selected ?? [];
  const noneChosen = () => props.v.selected?.length === 0;
  const set = (next: readonly number[] | null) =>
    props.onChange({ type: "multiSelect", selected: next });
  const toggle = (i: number) => {
    const picked = new Set(selected());
    if (picked.has(i)) picked.delete(i);
    else if (picked.size < props.q.maxSelections) picked.add(i);
    // `[]` belongs to "None of these": unchecking the last option unsets.
    set(picked.size > 0 ? [...picked].sort((a, b) => a - b) : null);
  };
  return (
    <>
      <div class={cls.multiGrid}>
        <For each={range(optionCount(props.q.options))}>
          {(i) => (
            <CheckRow
              on={selected().includes(i)}
              onToggle={() => toggle(i)}
              label={labelFor(i18n, props.q.options, i)}
            />
          )}
        </For>
        <Show when={props.q.minSelections === 0}>
          <CheckRow
            on={noneChosen()}
            onToggle={() => set(noneChosen() ? null : [])}
            label={i18n.t("respond.noneOfThese")}
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
}> = (props) => {
  const cls = useClasses();
  return (
    <div
      role="checkbox"
      tabindex={0}
      aria-checked={props.on}
      onClick={() => props.onToggle()}
      onKeyDown={activateOnKey(() => props.onToggle())}
      class={cls.optionRow}
      classList={{ [cls.optionRowOn]: props.on }}
    >
      <span class={cls.checkbox} classList={{ [cls.checkboxOn]: props.on }}>
        <Show when={props.on}>✓</Show>
      </span>
      <span>{props.label}</span>
    </div>
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
    <>
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
        {(i) => (
          <div class={cls.pointsRow}>
            <div class={cls.pointsRowHead}>
              <span class={cls.pointsOptLabel}>
                {labelFor(i18n, props.q.options, i)}
              </span>
              <div class={cls.pointsControls}>
                <button class={cls.stepBtn} onClick={() => bump(i, -stride)}>
                  −
                </button>
                <input
                  type="number"
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
              min={0}
              max={Number(positions)}
              step={1}
              value={Number(positionOf(pointsAt(i)))}
              aria-valuetext={pointsAt(i).toString()}
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
