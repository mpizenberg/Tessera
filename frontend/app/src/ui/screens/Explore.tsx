import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";

import { useApp, type ExploreFilter } from "~/state";
import { refKey, type SurveyAggregate } from "~/domain/survey";
import { walletControls, walletOwns } from "~/domain/roles";
import { fullRef, isClosed, viewStatus } from "~/ui/format";
import { FormMosaic, RoleChips, VisGlyph } from "~/ui/components/glyphs";
import type { ChainTip, GovLink } from "~/data/source";
import type { WalletIdentity } from "~/wallet/types";
import type { Question, SurveyDefinition } from "cip-179";

// Seven columns: Form · visibility · answered · survey · eligible · ends · replies.
const COLS = "52px 24px 26px minmax(190px,1fr) 122px 100px 52px";
// Below this width the table gets cramped, so each row reflows into a card.
const CARD_BREAKPOINT = 800;

/** Per-survey wallet flags. */
interface Flags {
  readonly mine: boolean;
  readonly responded: boolean;
}

/** Reactive `(max-width)` media query — true while the viewport is narrow. */
function useNarrow(maxWidth: number): Accessor<boolean> {
  const mql = window.matchMedia(`(max-width: ${maxWidth}px)`);
  const [narrow, setNarrow] = createSignal(mql.matches);
  const onChange = (e: MediaQueryListEvent): void => {
    setNarrow(e.matches);
  };
  mql.addEventListener("change", onChange);
  onCleanup(() => mql.removeEventListener("change", onChange));
  return narrow;
}

const FILTERS: ReadonlyArray<{ value: ExploreFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "linked", label: "Governance" },
  { value: "active", label: "Active" },
  { value: "sealed", label: "Sealed" },
  { value: "public", label: "Public" },
  { value: "mine", label: "Mine" },
];

function matchesFilter(
  a: SurveyAggregate,
  f: ExploreFilter,
  flags: Flags,
): boolean {
  const v = viewStatus(a);
  switch (f) {
    case "all":
      return true;
    case "linked":
      return a.govLink !== null;
    case "active":
      return !isClosed(v);
    case "sealed":
      return v === "sealed";
    case "public":
      return v === "public";
    case "mine":
      return flags.mine;
  }
}

/** Text fragments from one question: its prompt plus any inline option or
 *  rating-scale labels (external-content questions carry only a count). */
function questionText(q: Question): string[] {
  const out = [q.prompt];
  if ("options" in q && q.options.type === "options")
    out.push(...q.options.labels);
  if (q.type === "rating" && q.scale.type === "labels")
    out.push(...q.scale.labels);
  return out;
}

/**
 * The lowercased text a survey is searched against: title + description, every
 * question prompt and inline label, and any linked governance action (id +
 * title). Built from the cache-enriched definition, so off-chain labels we hold
 * are matchable; off-chain labels we don't hold simply aren't here to match.
 */
function searchHaystack(d: SurveyDefinition, govLink: GovLink | null): string {
  const parts = [d.title, d.description, ...d.questions.flatMap(questionText)];
  if (govLink) {
    parts.push(govLink.actionId);
    if (govLink.title) parts.push(govLink.title);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Unix deadline for accepting responses: responses are valid through `endEpoch`
 * inclusive, so the cutoff is the *start* of the next epoch. Post-Shelley slots
 * are 1s, so the current epoch began at `tip.time − tip.epochSlot` and each
 * epoch spans `secondsPerEpoch` seconds.
 */
function voteDeadlineUnix(
  endEpoch: number,
  tip: ChainTip,
  secondsPerEpoch: number,
): number {
  const epochStartUnix = tip.time - tip.epochSlot;
  return epochStartUnix + (endEpoch + 1 - tip.epoch) * secondsPerEpoch;
}

/** Coarse "time left to vote": days+hours up high, hours+minutes near the end. */
function timeLeft(deadlineUnix: number, nowUnix: number): string {
  const s = deadlineUnix - nowUnix;
  if (s <= 0) return "ending now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return `${d}d ${h}h left`;
  if (h >= 1) return `${h}h ${m}m left`;
  return `${Math.max(1, m)}m left`;
}

/** What the "Ends" cell reads: time-left while open, lifecycle word once closed. */
function endsText(
  a: SurveyAggregate,
  tip: ChainTip,
  secondsPerEpoch: number,
  nowUnix: number,
): string {
  const v = viewStatus(a);
  if (v === "cancelled") return "withdrawn";
  if (v === "ended") return "closed";
  return timeLeft(
    voteDeadlineUnix(a.record.definition.endEpoch, tip, secondsPerEpoch),
    nowUnix,
  );
}

export const Explore: Component = () => {
  const app = useApp();

  const all = createMemo(() => {
    const real = app.snapshot()?.surveys ?? [];
    const realKeys = new Set(real.map((s) => s.key));
    // Surveys just created this session, shown until the indexer catches up.
    const opt = app.optimisticSurveys().filter((a) => !realKeys.has(a.key));
    return opt.length ? [...opt, ...real] : real;
  });
  const tip = createMemo<ChainTip | undefined>(() => app.snapshot()?.tip);
  const tipEpoch = createMemo(() => tip()?.epoch ?? 0);
  const identity = (): WalletIdentity | null => app.wallet()?.identity ?? null;

  const narrow = useNarrow(CARD_BREAKPOINT);

  // The input shows keystrokes immediately but only commits to the applied
  // query (`app.ui.search`, which drives filtering) after a 1s pause, so typing
  // doesn't re-filter the whole list on every character.
  const [searchInput, setSearchInput] = createSignal(app.ui.search);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const onSearchInput = (value: string): void => {
    setSearchInput(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => app.setSearch(value), 1000);
  };
  onCleanup(() => clearTimeout(searchTimer));

  // First-visit intro: shown until dismissed (remembered) or a wallet connects.
  const [introDismissed, setIntroDismissed] = createSignal(introIsDismissed());
  const showIntro = () => !app.wallet() && !introDismissed();
  const dismissIntro = (): void => {
    rememberIntroDismissed();
    setIntroDismissed(true);
  };

  // Tick once a minute so the "time left" readout stays roughly live without a
  // refetch. Pure display — it never feeds a resource, so it can't retrigger I/O.
  const [nowUnix, setNowUnix] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(
    () => setNowUnix(Math.floor(Date.now() / 1000)),
    60_000,
  );
  onCleanup(() => clearInterval(clock));

  // Survey ref keys the connected wallet has responded to.
  const respondedKeys = createMemo<Set<string>>(() => {
    const id = identity();
    const snap = app.snapshot();
    if (!id || !snap) return new Set();
    const keys = new Set<string>();
    for (const r of snap.records.responses) {
      if (walletControls(id, r.response.credential)) {
        keys.add(refKey(r.response.surveyRef));
      }
    }
    return keys;
  });

  const flagsOf = (a: SurveyAggregate): Flags => {
    const id = identity();
    return {
      mine: id ? walletOwns(id, a.record.definition.owner) : false,
      responded: respondedKeys().has(a.key),
    };
  };

  // Search is a case-insensitive AND of whitespace-separated terms: every term
  // must appear (as a substring) somewhere in a survey's haystack.
  const searchTerms = createMemo(() =>
    app.ui.search.trim().toLowerCase().split(/\s+/).filter(Boolean),
  );
  // One haystack per survey, rebuilt only when the survey set or cached labels
  // change — reused by both the row filter and the chip counts.
  const haystacks = createMemo(() => {
    const m = new Map<string, string>();
    for (const a of all())
      m.set(
        a.key,
        searchHaystack(app.displayDefinition(a.record.definition), a.govLink),
      );
    return m;
  });
  const matchesSearch = (a: SurveyAggregate): boolean => {
    const terms = searchTerms();
    if (terms.length === 0) return true;
    const hay = haystacks().get(a.key) ?? "";
    return terms.every((t) => hay.includes(t));
  };

  // Counts reflect the active search, so each chip reads "N matching & <filter>".
  const counts = createMemo(() => {
    const xs = all().filter(matchesSearch);
    const by = (f: ExploreFilter) =>
      xs.filter((a) => matchesFilter(a, f, flagsOf(a))).length;
    return {
      all: xs.length,
      linked: by("linked"),
      active: by("active"),
      sealed: by("sealed"),
      public: by("public"),
      mine: by("mine"),
    } satisfies Record<ExploreFilter, number>;
  });

  const visible = createMemo(() =>
    all()
      .filter((a) => matchesFilter(a, app.ui.filter, flagsOf(a)))
      .filter(matchesSearch),
  );

  // Linked (governance) surveys get their own section, shown first; the rest
  // split into open / closed so a linked survey never appears twice.
  const govRows = createMemo(() => visible().filter((a) => a.govLink !== null));
  const openRows = createMemo(() =>
    visible().filter((a) => a.govLink === null && !isClosed(viewStatus(a))),
  );
  const closedRows = createMemo(() =>
    visible().filter((a) => a.govLink === null && isClosed(viewStatus(a))),
  );

  const rowProps = (a: SurveyAggregate): EntryProps => ({
    a,
    tip: tip(),
    secondsPerEpoch: app.config.secondsPerEpoch,
    nowUnix: nowUnix(),
    pro: app.ui.pro,
    flags: flagsOf(a),
    narrow: narrow(),
  });

  return (
    <main
      style={{
        "max-width": "1100px",
        margin: "0 auto",
        padding: "30px 24px 76px",
      }}
    >
      <Show when={showIntro()}>
        <IntroHero onDismiss={dismissIntro} />
      </Show>

      {/* title row + summary */}
      <div
        style={{
          display: "flex",
          "align-items": "flex-end",
          "justify-content": "space-between",
          gap: "16px",
          "border-bottom": "1px solid #E7DFCE",
          "padding-bottom": "14px",
          "flex-wrap": "wrap",
        }}
      >
        <h1
          style={{
            "font-size": "31px",
            "font-weight": "700",
            "letter-spacing": "-.014em",
            margin: "0",
            color: "var(--ink)",
          }}
        >
          Surveys &amp; polls
        </h1>
        <div style={{ display: "flex", "align-items": "center", gap: "16px" }}>
          <span
            style={{
              "font-family": "var(--mono)",
              "font-size": "11.5px",
              color: "var(--dim)",
              "white-space": "nowrap",
            }}
          >
            {all().length} entries · current epoch {tipEpoch()}
          </span>
          <A
            href="/create"
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "7px",
              "white-space": "nowrap",
              background: "var(--accent)",
              color: "#fff",
              "text-decoration": "none",
              "border-radius": "var(--r-control)",
              padding: "9px 14px",
              "font-size": "13px",
              "font-weight": "700",
              "box-shadow": "0 6px 16px -9px var(--accent-shadow)",
            }}
          >
            <span
              style={{
                "font-size": "15px",
                "line-height": "0",
                "margin-top": "-1px",
              }}
            >
              +
            </span>{" "}
            New survey
          </A>
        </div>
      </div>

      {/* filters + search */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          "margin-top": "20px",
          "flex-wrap": "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "7px", "flex-wrap": "wrap" }}>
          <For each={FILTERS}>
            {(f) => (
              <button
                onClick={() => app.setFilter(f.value)}
                style={filterStyle(app.ui.filter === f.value)}
              >
                {f.label}{" "}
                <span style={filterCountStyle(app.ui.filter === f.value)}>
                  {counts()[f.value]}
                </span>
              </button>
            )}
          </For>
        </div>
        <div
          style={{
            "margin-left": "auto",
            display: "flex",
            "align-items": "center",
            gap: "8px",
            background: "var(--surface2)",
            border: "1px solid var(--line)",
            "border-radius": "var(--r-input)",
            padding: "8px 12px",
            "min-width": "190px",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#BFB39A"
            stroke-width="2.2"
            stroke-linecap="round"
            aria-hidden="true"
            style={{ flex: "none", display: "block" }}
          >
            <circle cx="10.5" cy="10.5" r="7" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" />
          </svg>
          <input
            value={searchInput()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
            placeholder="Search surveys…"
            style={{
              border: "none",
              outline: "none",
              "font-family": "inherit",
              "font-size": "13px",
              flex: "1",
              background: "transparent",
              color: "var(--ink)",
            }}
          />
        </div>
      </div>

      {/* register table (cards on narrow screens) */}
      <div style={{ "margin-top": "8px" }}>
        <div style={{ "overflow-x": narrow() ? "visible" : "auto" }}>
          <div style={{ "min-width": narrow() ? "auto" : "680px" }}>
            <Show when={!narrow()}>
              <HeaderRow />
            </Show>

            <Show when={app.snapshot.loading}>
              <SkeletonRows narrow={narrow()} />
            </Show>
            <Show when={app.snapshot.error as unknown}>
              {(err) => (
                <Notice
                  tone="danger"
                  text={`Failed to load: ${String(err())}`}
                />
              )}
            </Show>

            <Show when={!app.snapshot.loading && !app.snapshot.error}>
              <Show when={govRows().length > 0}>
                <SectionLabel
                  dot={
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        "border-radius": "1.5px",
                        background: "var(--gov)",
                      }}
                    />
                  }
                  color="var(--gov)"
                  label="On-chain governance"
                  note="Tied to an Info Action — shown first."
                />
                <For each={govRows()}>{(a) => <Entry {...rowProps(a)} />}</For>
              </Show>

              <Show when={openRows().length > 0}>
                <SectionLabel
                  dot={
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        "border-radius": "50%",
                        background: "#7E8B6A",
                      }}
                    />
                  }
                  color="#5E7B49"
                  label="Open · accepting responses"
                />
                <For each={openRows()}>{(a) => <Entry {...rowProps(a)} />}</For>
              </Show>

              <Show when={closedRows().length > 0}>
                <SectionLabel
                  dot={
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        "border-radius": "50%",
                        border: "1.5px solid #BBB1A0",
                        "box-sizing": "border-box",
                      }}
                    />
                  }
                  color="#A79C88"
                  label="Closed"
                  note="Ended or withdrawn — read-only."
                  topBorder
                />
                <div style={{ opacity: "0.56" }}>
                  <For each={closedRows()}>
                    {(a) => <Entry {...rowProps(a)} />}
                  </For>
                </div>
              </Show>

              <Show when={visible().length === 0}>
                <Notice text="No surveys match." />
              </Show>
            </Show>
          </div>
        </div>
      </div>

      <Legend />
    </main>
  );
};

const HeaderRow: Component = () => {
  const cell = (label: string, align?: "center" | "right"): JSX.Element => (
    <span
      style={{
        "font-family": "var(--mono)",
        "font-size": "9.5px",
        "letter-spacing": ".09em",
        "text-transform": "uppercase",
        color: "#B0A488",
        "font-weight": "600",
        "text-align": align ?? "left",
      }}
    >
      {label}
    </span>
  );
  return (
    <div
      style={{
        display: "grid",
        "grid-template-columns": COLS,
        gap: "14px",
        "align-items": "center",
        padding: "10px 6px",
        "border-bottom": "1px solid #DDD3C0",
      }}
    >
      {cell("Form", "center")}
      <span />
      <span
        title="Surveys you have answered"
        style={{ "text-align": "center" }}
      >
        {cell("✓", "center")}
      </span>
      {cell("Survey")}
      {cell("Eligible")}
      {cell("Ends")}
      {cell("Replies", "right")}
    </div>
  );
};

const SectionLabel: Component<{
  dot: JSX.Element;
  color: string;
  label: string;
  note?: string;
  topBorder?: boolean;
}> = (props) => (
  <div
    style={{
      display: "flex",
      "align-items": "baseline",
      gap: "9px",
      padding: props.topBorder ? "18px 6px 8px" : "16px 6px 8px",
      ...(props.topBorder ? { "border-top": "1px solid #ECE2D0" } : {}),
    }}
  >
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
        "font-family": "var(--mono)",
        "font-size": "9.5px",
        "font-weight": "600",
        "letter-spacing": ".06em",
        "text-transform": "uppercase",
        color: props.color,
      }}
    >
      {props.dot}
      {props.label}
    </span>
    <Show when={props.note}>
      <span style={{ "font-size": "12px", color: "#B0A488" }}>
        {props.note}
      </span>
    </Show>
  </div>
);

interface EntryProps {
  a: SurveyAggregate;
  tip: ChainTip | undefined;
  secondsPerEpoch: number;
  nowUnix: number;
  pro: boolean;
  flags: Flags;
  narrow: boolean;
}

/** Pick the card or table-row presentation for the current viewport. */
const Entry: Component<EntryProps> = (props) => (
  <Show when={props.narrow} fallback={<GridRow {...props} />}>
    <CardRow {...props} />
  </Show>
);

/** Inline check shown on surveys the connected wallet has answered. */
const AnsweredCheck: Component = () => (
  <span
    title="You answered this survey"
    aria-label="answered"
    style={{
      color: "var(--ok)",
      "font-size": "13px",
      "font-weight": "700",
      "line-height": "1",
    }}
  >
    ✓
  </span>
);

const YoursBadge: Component = () => (
  <span
    style={{
      flex: "none",
      "font-size": "10px",
      "font-weight": "700",
      color: "var(--warn)",
      background: "var(--warn-bg)",
      border: "1px solid var(--warn-line)",
      "border-radius": "5px",
      padding: "1.5px 6px",
      "white-space": "nowrap",
    }}
  >
    Yours
  </span>
);

const OffChainBadge: Component = () => (
  <span
    style={{
      flex: "none",
      "font-size": "10px",
      "font-weight": "700",
      color: "var(--warn)",
      background: "var(--warn-bg)",
      border: "1px solid var(--warn-line)",
      "border-radius": "5px",
      padding: "1.5px 6px",
      "white-space": "nowrap",
    }}
  >
    ⚠ labels off-chain
  </span>
);

const GovLine: Component<{ actionId: string; title: string | null }> = (
  props,
) => (
  <div
    style={{
      "font-family": "var(--mono)",
      "font-size": "10.5px",
      color: "var(--gov)",
      "margin-top": "4px",
      "white-space": "nowrap",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    }}
  >
    ◇ Info Action {shortGovId(props.actionId)}
    {props.title ? ` · ${props.title}` : ""}
  </div>
);

const GridRow: Component<EntryProps> = (props) => {
  const app = useApp();
  // Enriched from the session cache when we hold the doc (e.g. just authored);
  // otherwise the on-chain definition, where external labels are absent.
  const def = () => app.displayDefinition(props.a.record.definition);
  const labelsMissing = () =>
    !!def().contentAnchor && def().title.trim() === "";
  const v = () => viewStatus(props.a);
  const closed = () => isClosed(v());
  const ends = (): string =>
    props.tip
      ? endsText(props.a, props.tip, props.secondsPerEpoch, props.nowUnix)
      : "—";
  return (
    // A router link, not a div+navigate: a plain click stays client-side (no
    // reload — wallet connection and snapshot survive), while cmd/ctrl/middle
    // click still opens the survey in a new tab natively.
    <A
      href={`/survey/${encodeURIComponent(props.a.key)}`}
      style={{
        display: "grid",
        "grid-template-columns": COLS,
        gap: "14px",
        "align-items": "center",
        padding: "12px 6px",
        "border-bottom": "1px solid #ECE2D0",
        cursor: "pointer",
        "text-decoration": "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "5px",
        }}
      >
        <FormMosaic count={def().questions.length} />
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "9.5px",
            "font-weight": "600",
            color: closed() ? "#B3A892" : "#A98A6E",
          }}
        >
          {def().questions.length}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          "justify-content": "center",
          "align-items": "center",
        }}
      >
        <VisGlyph status={v()} />
      </div>
      <div
        style={{
          display: "flex",
          "justify-content": "center",
          "align-items": "center",
        }}
      >
        <Show when={props.flags.responded}>
          <AnsweredCheck />
        </Show>
      </div>
      <div style={{ "min-width": "0" }}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            "min-width": "0",
          }}
        >
          <span
            style={{
              "font-family": "var(--serif)",
              "font-size": "16px",
              "font-weight": "600",
              "letter-spacing": "-.005em",
              color: closed() ? "#5C5648" : "var(--ink)",
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
            }}
          >
            {def().title || "Untitled · external content"}
          </span>
          <Show when={props.flags.mine}>
            <YoursBadge />
          </Show>
          <Show when={labelsMissing()}>
            <OffChainBadge />
          </Show>
        </div>
        <div
          style={{
            "font-size": "12px",
            color: "#A79C88",
            "white-space": "nowrap",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "margin-top": "2px",
          }}
        >
          {def().description ||
            "Presentation text unavailable — on-chain structure intact."}
        </div>
        <Show when={props.a.govLink}>
          {(link) => (
            <GovLine actionId={link().actionId} title={link().title} />
          )}
        </Show>
      </div>
      <RoleChips roles={def().eligibleRoles} />
      <div>
        <div
          style={{
            "font-size": "13px",
            "font-weight": "500",
            color: closed() ? "#8A8270" : "#5A5246",
          }}
        >
          {ends()}
        </div>
        <Show when={props.pro}>
          <div
            title="Full survey ref — defining transaction hash and output index"
            style={{
              "font-family": "var(--mono)",
              "font-size": "10.5px",
              color: closed() ? "#9C9486" : "var(--gov)",
              "margin-top": "2px",
              "word-break": "break-all",
              "line-height": "1.4",
            }}
          >
            epoch {def().endEpoch}
            <br />
            {fullRef(props.a.key)}
          </div>
        </Show>
      </div>
      <div style={{ "text-align": "right" }}>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "13px",
            "font-weight": "600",
            color: closed() ? "#6C6657" : "var(--ink)",
          }}
        >
          {v() === "cancelled" ? "—" : props.a.responseCount}
        </span>
      </div>
    </A>
  );
};

/** A single labelled meta pair in the card's footer row. */
const MetaChip: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
    <span
      style={{
        "font-family": "var(--mono)",
        "font-size": "9px",
        "letter-spacing": ".07em",
        "text-transform": "uppercase",
        color: "#B0A488",
        "font-weight": "600",
      }}
    >
      {props.label}
    </span>
    <span
      style={{ "font-size": "12.5px", color: "#5A5246", "font-weight": "500" }}
    >
      {props.children}
    </span>
  </span>
);

const CardRow: Component<EntryProps> = (props) => {
  const app = useApp();
  const def = () => app.displayDefinition(props.a.record.definition);
  const labelsMissing = () =>
    !!def().contentAnchor && def().title.trim() === "";
  const v = () => viewStatus(props.a);
  const closed = () => isClosed(v());
  const ends = (): string =>
    props.tip
      ? endsText(props.a, props.tip, props.secondsPerEpoch, props.nowUnix)
      : "—";
  return (
    <A
      href={`/survey/${encodeURIComponent(props.a.key)}`}
      style={{
        display: "block",
        padding: "14px 4px",
        "border-bottom": "1px solid #ECE2D0",
        "text-decoration": "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          "min-width": "0",
        }}
      >
        <span style={{ flex: "none", display: "inline-flex" }}>
          <VisGlyph status={v()} />
        </span>
        <Show when={props.flags.responded}>
          <AnsweredCheck />
        </Show>
        <span
          style={{
            flex: "1",
            "min-width": "0",
            "font-family": "var(--serif)",
            "font-size": "16px",
            "font-weight": "600",
            "letter-spacing": "-.005em",
            color: closed() ? "#5C5648" : "var(--ink)",
            "white-space": "nowrap",
            overflow: "hidden",
            "text-overflow": "ellipsis",
          }}
        >
          {def().title || "Untitled · external content"}
        </span>
        <Show when={props.flags.mine}>
          <YoursBadge />
        </Show>
      </div>

      <div
        style={{
          "font-size": "12.5px",
          color: "#A79C88",
          "margin-top": "3px",
          display: "-webkit-box",
          "-webkit-line-clamp": "2",
          "-webkit-box-orient": "vertical",
          overflow: "hidden",
        }}
      >
        {def().description ||
          "Presentation text unavailable — on-chain structure intact."}
      </div>

      <Show when={labelsMissing()}>
        <div style={{ "margin-top": "6px" }}>
          <OffChainBadge />
        </div>
      </Show>
      <Show when={props.a.govLink}>
        {(link) => <GovLine actionId={link().actionId} title={link().title} />}
      </Show>

      <div
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "align-items": "center",
          gap: "8px 16px",
          "margin-top": "11px",
        }}
      >
        <MetaChip label="Form">
          <span
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "6px",
            }}
          >
            <FormMosaic count={def().questions.length} size={16} />
            {def().questions.length}
          </span>
        </MetaChip>
        <Show when={def().eligibleRoles.length > 0}>
          <MetaChip label="Eligible">
            <RoleChips roles={def().eligibleRoles} />
          </MetaChip>
        </Show>
        <MetaChip label="Ends">
          <span style={{ color: closed() ? "#8A8270" : "#5A5246" }}>
            {ends()}
          </span>
        </MetaChip>
        <MetaChip label="Replies">
          {v() === "cancelled" ? "—" : String(props.a.responseCount)}
        </MetaChip>
        <Show when={props.pro}>
          <MetaChip label="Epoch">{String(def().endEpoch)}</MetaChip>
        </Show>
      </div>
      <Show when={props.pro}>
        <div
          title="Full survey ref — defining transaction hash and output index"
          style={{
            "font-family": "var(--mono)",
            "font-size": "10.5px",
            color: "var(--gov)",
            "word-break": "break-all",
            "margin-top": "8px",
          }}
        >
          ref {fullRef(props.a.key)}
        </div>
      </Show>
    </A>
  );
};

const Legend: Component = () => (
  <div
    style={{
      display: "flex",
      "align-items": "center",
      gap: "9px",
      "margin-top": "14px",
      padding: "0 2px",
      "flex-wrap": "wrap",
    }}
  >
    <FormMosaic count={4} size={14} />
    <span style={{ "font-size": "11.5px", color: "#A79C88" }}>
      Form — one tile per question.
    </span>
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
        "margin-left": "10px",
      }}
    >
      <span
        style={{
          width: "11px",
          height: "11px",
          "border-radius": "50%",
          border: "2px solid #7E8B6A",
          "box-sizing": "border-box",
        }}
      />
      <span style={{ "font-size": "11.5px", color: "#A79C88" }}>public</span>
      <span style={{ "margin-left": "6px", display: "inline-flex" }}>
        <VisGlyph status="sealed" />
      </span>
      <span style={{ "font-size": "11.5px", color: "#A79C88" }}>
        sealed until reveal
      </span>
      <span
        style={{
          "margin-left": "10px",
          color: "var(--ok)",
          "font-weight": "700",
          "font-size": "12px",
        }}
      >
        ✓
      </span>
      <span style={{ "font-size": "11.5px", color: "#A79C88" }}>
        you answered
      </span>
    </span>
  </div>
);

const Notice: Component<{ text: string; tone?: "danger" }> = (props) => (
  <div
    style={{
      padding: "26px 6px",
      "text-align": "center",
      "font-size": "13.5px",
      color: props.tone === "danger" ? "var(--danger)" : "var(--muted)",
    }}
  >
    {props.text}
  </div>
);

const INTRO_DISMISSED_KEY = "tessera.introDismissed";

function introIsDismissed(): boolean {
  try {
    return localStorage.getItem(INTRO_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberIntroDismissed(): void {
  try {
    localStorage.setItem(INTRO_DISMISSED_KEY, "1");
  } catch {
    // storage unavailable — the intro just shows again next load
  }
}

/** Dismissible first-visit explainer, shown until a wallet connects. */
const IntroHero: Component<{ onDismiss: () => void }> = (props) => (
  <div
    style={{
      position: "relative",
      background: "var(--surface2)",
      border: "1px solid var(--line)",
      "border-radius": "var(--r-card)",
      padding: "20px 22px",
      "margin-bottom": "22px",
    }}
  >
    <button
      onClick={() => props.onDismiss()}
      title="Dismiss"
      style={{
        position: "absolute",
        top: "12px",
        right: "12px",
        background: "none",
        border: "none",
        color: "var(--faint)",
        "font-size": "18px",
        "line-height": "1",
        cursor: "pointer",
        padding: "2px",
      }}
    >
      ×
    </button>
    <h2
      style={{
        "font-family": "var(--serif)",
        "font-size": "20px",
        "font-weight": "700",
        "letter-spacing": "-.01em",
        margin: "0 0 6px",
        color: "var(--ink)",
      }}
    >
      On-chain surveys &amp; polls on Cardano
    </h2>
    <p
      style={{
        "font-size": "13.5px",
        "line-height": "1.6",
        color: "var(--muted)",
        margin: "0",
        "max-width": "680px",
      }}
    >
      Tessera records surveys directly in Cardano transaction metadata — no
      backend, no accounts. Browse everything below for free; connect a wallet
      to respond as your on-chain role (DRep, SPO, CC, or stakeholder) or to
      publish your own. Responses can be public or sealed — timelock-encrypted
      for a delayed reveal.
    </p>
  </div>
);

const SKELETON_SHIMMER = "#E9E1D0";
function skeletonBar(width: string, height = "12px"): JSX.Element {
  return (
    <span
      style={{
        display: "block",
        width,
        height,
        "border-radius": "5px",
        background: SKELETON_SHIMMER,
        animation: "pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}

/** Placeholder rows shown while the snapshot loads (mirrors the register grid). */
const SkeletonRows: Component<{ narrow: boolean }> = (props) => (
  <For each={[0, 1, 2, 3, 4, 5]}>
    {(i) => (
      <Show
        when={!props.narrow}
        fallback={
          <div
            style={{
              padding: "14px 4px",
              "border-bottom": "1px solid #EFE8DA",
              display: "flex",
              "flex-direction": "column",
              gap: "9px",
            }}
          >
            {skeletonBar("58%", "14px")}
            {skeletonBar("38%")}
          </div>
        }
      >
        <div
          style={{
            display: "grid",
            "grid-template-columns": COLS,
            gap: "14px",
            "align-items": "center",
            padding: "15px 6px",
            "border-bottom": "1px solid #EFE8DA",
          }}
        >
          <span
            style={{
              width: "26px",
              height: "26px",
              "border-radius": "6px",
              background: SKELETON_SHIMMER,
              animation: "pulse 1.4s ease-in-out infinite",
              margin: "0 auto",
            }}
          />
          <span
            style={{
              width: "12px",
              height: "12px",
              "border-radius": "50%",
              background: SKELETON_SHIMMER,
              animation: "pulse 1.4s ease-in-out infinite",
            }}
          />
          <span />
          {skeletonBar(`${74 - (i % 3) * 14}%`, "13px")}
          {skeletonBar("72%")}
          {skeletonBar("60%")}
          <span
            style={{
              "justify-self": "end",
              width: "24px",
              height: "12px",
              "border-radius": "5px",
              background: SKELETON_SHIMMER,
              animation: "pulse 1.4s ease-in-out infinite",
            }}
          />
        </div>
      </Show>
    )}
  </For>
);

/** Shorten a bech32 governance action id for inline display. */
function shortGovId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

function filterStyle(on: boolean): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    "border-radius": "8px",
    padding: "6px 12px",
    "white-space": "nowrap",
    border: on ? "1px solid var(--accent)" : "1px solid #E7E0D0",
    background: on ? "var(--accent)" : "#F2ECDE",
    color: on ? "#FBF8F1" : "#6B6356",
  };
}

function filterCountStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10.5px",
    "font-weight": "600",
    color: on ? "rgba(251,248,241,.75)" : "#A79C88",
  };
}
