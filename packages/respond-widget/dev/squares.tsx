/**
 * Trial of the progress squares' look: the stepper's top row, one square per
 * question, in each variant, inside a shadow root that adopts the widget's own
 * stylesheet. Open `/squares.html` under
 * `pnpm --filter cardano-tessera-respond dev`.
 */

import { render } from "solid-js/web";
import {
  For,
  Index,
  Show,
  createEffect,
  createSignal,
  type Component,
} from "solid-js";

import { createI18n } from "cardano-tessera-respond-core";

import { adoptWidgetStyles } from "../src/index";
import { THEMES } from "./samples";
import trialCss from "./squares.css?inline";

type State =
  "unseen" | "passed" | "answered" | "skipped" | "unfinished" | "hidden";

const AXES = [
  {
    key: "size",
    label: "Size",
    options: [
      ["12", "12px"],
      ["16", "16px"],
      ["20", "20px"],
    ],
  },
  {
    key: "number",
    label: "Number",
    options: [
      ["off", "None"],
      ["on", "Inside"],
    ],
  },
  {
    key: "scheme",
    label: "States",
    options: [
      ["fill", "Fill & stroke"],
      ["marks", "Marks"],
    ],
  },
  {
    key: "colour",
    label: "Not answered, not finished",
    options: [
      ["neutral", "Grey & accent"],
      ["warn", "Warn token"],
    ],
  },
  {
    key: "current",
    label: "Current",
    options: [
      ["ring", "Ring"],
      ["bigger", "Bigger"],
      ["under", "Mark under"],
    ],
  },
  {
    key: "hidden",
    label: "Hidden",
    options: [
      ["dot", "Faint dot"],
      ["gap", "Gap"],
      ["none", "Nothing"],
    ],
  },
  {
    key: "count",
    label: "Count",
    options: [
      ["over", "Over the squares"],
      ["under", "Under, or between the buttons"],
      ["short", "Short, after them"],
      ["out", "Left out"],
    ],
  },
] as const;

type AxisKey = (typeof AXES)[number]["key"];
type Look = Record<AxisKey, string>;

const [look, setLook] = createSignal<Look>({
  size: "16",
  number: "off",
  scheme: "fill",
  colour: "neutral",
  current: "ring",
  hidden: "dot",
  count: "under",
});
const [compare, setCompare] = createSignal<AxisKey | "none">("size");
const [dark, setDark] = createSignal(false);
const [locale, setLocale] = createSignal<"en" | "fr">("en");
const [phone, setPhone] = createSignal(375);
const [total, setTotal] = createSignal(32);

const I18NS = {
  en: createI18n({ locale: "en" }),
  fr: createI18n({ locale: "fr" }),
};
const i18n = () => I18NS[locale()];

// --- Sample progress ----------------------------------------------------------

const A = "answered",
  S = "skipped",
  P = "passed",
  U = "unfinished",
  H = "hidden",
  N = "unseen";

/** A respondent at Q15 of 32 who jumped ahead once (Q18) and back. */
const P32: State[] = [
  A,
  A,
  A,
  S,
  A,
  A,
  P,
  A,
  U,
  A,
  S,
  H,
  A,
  A,
  P,
  P,
  N,
  A,
  N,
  H,
  H,
];

const SCENARIOS: Record<number, { states: State[]; current: number }> = {
  12: { states: [A, A, S, A, P, U, P, H, N, N, N, N], current: 6 },
  32: { states: pad(P32, 32), current: 14 },
  60: { states: pad([...P32, ...pad([], 18), H], 60), current: 14 },
};

function pad(states: State[], n: number): State[] {
  return [...states, ...Array<State>(n - states.length).fill(N)];
}

const [current, setCurrent] = createSignal(SCENARIOS[32]!.current);
const states = () => SCENARIOS[total()]!.states;

function shownFrom(i: number, step: 1 | -1): number | undefined {
  for (let j = i + step; j >= 0 && j < states().length; j += step) {
    if (states()[j] !== "hidden") return j;
  }
  return undefined;
}

// --- Text names -------------------------------------------------------------

const NAMES: Record<"en" | "fr", Record<State, string>> = {
  en: {
    unseen: "not seen yet",
    passed: "not answered yet",
    answered: "answered",
    skipped: "skipped",
    unfinished: "not finished",
    hidden: "not asked",
  },
  fr: {
    unseen: "pas encore vue",
    passed: "sans réponse",
    answered: "répondue",
    skipped: "ignorée",
    unfinished: "à compléter",
    hidden: "non posée",
  },
};

const textName = (n: number, state: State) =>
  `Question ${i18n().n(n)}, ${NAMES[locale()][state]}`;

// --- Squares ----------------------------------------------------------------

const Mark: Component<{ state: State }> = (props) => (
  <svg class="sqMark" viewBox="0 0 16 16" aria-hidden="true">
    <Show when={props.state === "answered"}>
      <path d="M4 8.5l2.6 2.6L12 5.6" />
    </Show>
    <Show when={props.state === "skipped"}>
      <path d="M4.5 8h7" />
    </Show>
    <Show when={props.state === "unfinished"}>
      <circle cx="4.4" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="11.6" cy="8" r="1.1" />
    </Show>
    <Show when={props.state === "passed"}>
      <path d="M6 6.2a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.4" />
      <circle cx="8" cy="11.6" r="1" />
    </Show>
  </svg>
);

const Square: Component<{
  look: Look;
  n: number;
  state: State;
  current: boolean;
  focused?: boolean;
  onPick?: () => void;
}> = (props) => {
  const numbered = () =>
    props.look.number === "on" && props.look.scheme === "fill";
  return (
    <Show
      when={props.state !== "hidden"}
      fallback={
        <Show when={props.look.hidden !== "none"}>
          <span
            class="sq"
            classList={{
              sqDot: props.look.hidden === "dot",
              sqGap: props.look.hidden === "gap",
            }}
            role="img"
            aria-label={textName(props.n, props.state)}
            title={textName(props.n, props.state)}
          />
        </Show>
      }
    >
      <button
        class={`sq st-${props.state}`}
        classList={{
          isCurrent: props.current,
          fakeFocus: props.focused === true,
        }}
        aria-current={props.current ? "step" : undefined}
        aria-label={textName(props.n, props.state)}
        title={textName(props.n, props.state)}
        onClick={() => props.onPick?.()}
      >
        <Show
          when={numbered()}
          fallback={
            <Show when={props.look.scheme === "marks"}>
              <Mark state={props.state} />
            </Show>
          }
        >
          <span class="sqNum">{i18n().n(props.n)}</span>
        </Show>
      </button>
    </Show>
  );
};

/** The classes that carry a look, on any box holding squares. */
const lookClasses = (look: Look) =>
  [
    "sqLook",
    `size-${look.size}`,
    `scheme-${look.scheme}`,
    `colour-${look.colour}`,
    `cur-${look.current}`,
    look.number === "on" && look.scheme === "fill" ? "numbered" : "",
  ].join(" ");

const LEGEND: {
  state: State;
  current?: boolean;
  focused?: boolean;
  label?: string;
}[] = [
  { state: "unseen" },
  { state: "passed" },
  { state: "answered" },
  { state: "skipped" },
  { state: "unfinished" },
  { state: "hidden" },
  { state: "passed", current: true, label: "current" },
  { state: "answered", current: true, label: "current" },
  { state: "answered", focused: true, label: "focused" },
  { state: "passed", current: true, focused: true, label: "current, focused" },
];

const Legend: Component<{ look: Look }> = (props) => (
  <div class={`legend ${lookClasses(props.look)}`}>
    <For each={LEGEND}>
      {(item, i) => (
        <div class="legendItem">
          <span class="legendSq">
            <Square
              look={props.look}
              n={i() + 3}
              state={item.state}
              current={item.current === true}
              focused={item.focused === true}
            />
          </span>
          <span class="legendName">
            {NAMES[locale()][item.state]}
            <Show when={item.label}>
              {(l) => <em class="legendNote">{l()}</em>}
            </Show>
          </span>
        </div>
      )}
    </For>
  </div>
);

const TopRow: Component<{ look: Look }> = (props) => {
  const count = () =>
    i18n().t("respond.stepCount", {
      n: i18n().n(current() + 1),
      total: i18n().n(total()),
    });
  const step = (to: number | undefined) => to !== undefined && setCurrent(to);
  return (
    <div class="sqWrap">
      <div class={`sqNav count-${props.look.count}`}>
        <button
          class="stepNavBtn sqPrev"
          disabled={shownFrom(current(), -1) === undefined}
          onClick={() => step(shownFrom(current(), -1))}
        >
          ← {i18n().t("respond.stepPrev")}
        </button>
        <div class="sqMid">
          <Show when={props.look.count === "over"}>
            <span class="stepCount sqCount">{count()}</span>
          </Show>
          <div class="sqLine">
            <div
              class={`sqs ${lookClasses(props.look)}`}
              role="toolbar"
              aria-label="Questions"
            >
              <Index each={states()}>
                {(state, i) => (
                  <Square
                    look={props.look}
                    n={i + 1}
                    state={state()}
                    current={i === current()}
                    onPick={() => setCurrent(i)}
                  />
                )}
              </Index>
            </div>
            <Show when={props.look.count === "short"}>
              <span class="stepCount sqShort">
                {i18n().n(current() + 1)}/{i18n().n(total())}
              </span>
            </Show>
          </div>
          <Show when={props.look.count === "under"}>
            <span class="stepCount sqCount">{count()}</span>
          </Show>
        </div>
        <button
          class="stepNavBtn sqNext"
          disabled={shownFrom(current(), 1) === undefined}
          onClick={() => step(shownFrom(current(), 1))}
        >
          {i18n().t("respond.stepNext")} →
        </button>
      </div>
      <div class="card">
        <span class="qChip">
          {i18n().t("respond.questionChip", { n: i18n().n(current() + 1) })}
        </span>
        <p class="qPrompt">
          Which tools do you use to write and test smart contracts?
        </p>
      </div>
    </div>
  );
};

const optionLabel = (key: AxisKey, value: string) =>
  AXES.find((a) => a.key === key)!.options.find((o) => o[0] === value)![1];

const Block: Component<{ look: Look; title: string }> = (props) => (
  <section class="block">
    <h2 class="blockTitle">{props.title}</h2>
    <Show when={props.look.scheme === "marks" && props.look.number === "on"}>
      <p class="blockNote">Marks take the number's place.</p>
    </Show>
    <Legend look={props.look} />
    <div class="frames">
      <figure class="frame">
        <figcaption class="frameName">Desktop · 760px</figcaption>
        <div class="frameBox" style={{ width: "760px" }}>
          <TopRow look={props.look} />
        </div>
      </figure>
      <figure class="frame">
        <figcaption class="frameName">
          Phone · {phone()}px screen, {phone() - 32}px widget
        </figcaption>
        <div class="frameBox" style={{ width: `${phone() - 32}px` }}>
          <TopRow look={props.look} />
        </div>
      </figure>
    </div>
  </section>
);

const Output: Component = () => {
  // The dark theme the way the `theme` prop applies it: inline tokens on the host.
  createEffect(() => {
    out.classList.toggle("dark", dark());
    for (const [key, value] of Object.entries(THEMES.dark!)) {
      if (dark()) out.style.setProperty(`--tessera-${key}`, value);
      else out.style.removeProperty(`--tessera-${key}`);
    }
  });
  const blocks = () => {
    const axis = compare();
    if (axis === "none") return [{ look: look(), title: "Chosen settings" }];
    const def = AXES.find((a) => a.key === axis)!;
    return def.options.map(([value, label]) => ({
      look: { ...look(), [axis]: value },
      title: `${def.label}: ${label}`,
    }));
  };
  return (
    <div class="trial">
      <p class="held">
        <For each={AXES.filter((a) => a.key !== compare())}>
          {(a) => (
            <span class="heldItem">
              {a.label}: <b>{optionLabel(a.key, look()[a.key])}</b>
            </span>
          )}
        </For>
      </p>
      <For each={blocks()}>
        {(b) => <Block look={b.look} title={b.title} />}
      </For>
    </div>
  );
};

// --- Page controls (light DOM) -----------------------------------------------

const Group: Component<{
  label: string;
  options: readonly (readonly [string, string])[];
  value: string;
  onPick: (v: string) => void;
  class?: string;
}> = (props) => (
  <div class={`group ${props.class ?? ""}`}>
    <b>{props.label}</b>
    <For each={props.options}>
      {([value, label]) => (
        <button
          classList={{ active: props.value === value }}
          onClick={() => props.onPick(value)}
        >
          {label}
        </button>
      )}
    </For>
  </div>
);

const Controls: Component = () => (
  <>
    <Group
      class="compare"
      label="Side by side"
      options={[
        ["none", "None"],
        ...AXES.map((a) => [a.key, a.label] as const),
      ]}
      value={compare()}
      onPick={(v) => setCompare(v as AxisKey | "none")}
    />
    <For each={AXES}>
      {(a) => (
        <Group
          label={a.label}
          options={a.options}
          value={look()[a.key]}
          onPick={(v) => setLook({ ...look(), [a.key]: v })}
        />
      )}
    </For>
    <Group
      label="Questions"
      options={[
        ["12", "12"],
        ["32", "32"],
        ["60", "60"],
      ]}
      value={String(total())}
      onPick={(v) => {
        setTotal(Number(v));
        setCurrent(SCENARIOS[Number(v)]!.current);
      }}
    />
    <Group
      label="Theme"
      options={[
        ["light", "Light"],
        ["dark", "Dark"],
      ]}
      value={dark() ? "dark" : "light"}
      onPick={(v) => setDark(v === "dark")}
    />
    <Group
      label="Locale"
      options={[
        ["en", "en"],
        ["fr", "fr"],
      ]}
      value={locale()}
      onPick={(v) => setLocale(v as "en" | "fr")}
    />
    <Group
      label="Phone"
      options={[
        ["375", "375px"],
        ["320", "320px"],
      ]}
      value={String(phone())}
      onPick={(v) => setPhone(Number(v))}
    />
  </>
);

// --- Mount ------------------------------------------------------------------

const out = document.getElementById("out") as HTMLElement;
const shadow = out.attachShadow({ mode: "open" });
adoptWidgetStyles(shadow);
const trialSheet = new CSSStyleSheet();
trialSheet.replaceSync(trialCss);
shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, trialSheet];

render(() => <Output />, shadow);
render(() => <Controls />, document.getElementById("controls") as HTMLElement);
