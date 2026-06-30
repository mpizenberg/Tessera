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
import {
  refKey,
  voteDeadlineUnix,
  type SurveyAggregate,
} from "~/domain/survey";
import { walletControls, walletOwns } from "~/domain/roles";
import { fullRef, isClosed, viewStatus } from "~/ui/format";
import { FormMosaic, RoleChips, VisGlyph } from "~/ui/components/glyphs";
import type { ChainTip, GovLink } from "~/data/source";
import type { WalletIdentity } from "~/wallet/types";
import type { Question, SurveyDefinition } from "cip-179";
import { t, n, type MsgKey } from "~/i18n";
import css from "./Explore.module.css";

// Seven columns: Form · visibility · answered · survey · eligible · ends · replies.
// Bridged to the grid via the `--cols` custom property so the header, rows and
// skeleton rows all share one definition.
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

// Label key resolved via `t()` at render time so it tracks the active locale.
const FILTERS: ReadonlyArray<{ value: ExploreFilter; labelKey: MsgKey }> = [
  { value: "all", labelKey: "explore.filterAll" },
  { value: "linked", labelKey: "explore.filterLinked" },
  { value: "active", labelKey: "explore.filterActive" },
  { value: "sealed", labelKey: "explore.filterSealed" },
  { value: "public", labelKey: "explore.filterPublic" },
  { value: "mine", labelKey: "explore.filterMine" },
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

/** Coarse "time left to vote": days+hours up high, hours+minutes near the end. */
function timeLeft(deadlineUnix: number, nowUnix: number): string {
  const s = deadlineUnix - nowUnix;
  if (s <= 0) return t("explore.endingNow");
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return t("explore.timeLeftDaysHours", { d: n(d), h: n(h) });
  if (h >= 1) return t("explore.timeLeftHoursMinutes", { h: n(h), m: n(m) });
  return t("explore.timeLeftMinutes", { m: n(Math.max(1, m)) });
}

/** What the "Ends" cell reads: time-left while open, lifecycle word once closed. */
function endsText(
  a: SurveyAggregate,
  tip: ChainTip,
  secondsPerEpoch: number,
  nowUnix: number,
): string {
  const v = viewStatus(a);
  if (v === "cancelled") return t("explore.endsWithdrawn");
  if (v === "ended") return t("explore.endsClosed");
  return timeLeft(
    voteDeadlineUnix(a.record.definition.endEpoch, tip, secondsPerEpoch),
    nowUnix,
  );
}

export const Explore: Component = () => {
  const app = useApp();

  // Reading the resource accessor throws while the snapshot is in error state
  // (Solid resource semantics). Every *value* read goes through this guard so a
  // failed Koios load surfaces via `app.snapshot.error` (the inline Notice
  // below) rather than throwing — the `.error`/`.loading` reads are always safe.
  const snapData = () => (app.snapshot.error ? undefined : app.snapshot());

  const all = createMemo(() => {
    const real = snapData()?.surveys ?? [];
    const realKeys = new Set(real.map((s) => s.key));
    // Surveys just created this session, shown until the indexer catches up.
    const opt = app.optimisticSurveys().filter((a) => !realKeys.has(a.key));
    return opt.length ? [...opt, ...real] : real;
  });
  const tip = createMemo<ChainTip | undefined>(() => snapData()?.tip);
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
    const snap = snapData();
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
    <main class={css.page}>
      <Show when={showIntro()}>
        <IntroHero onDismiss={dismissIntro} />
      </Show>

      {/* title row + summary */}
      <div class={css.titleRow}>
        <h1 class={css.title}>{t("explore.pageTitle")}</h1>
        <div class={css.summary}>
          <span class={css.entries}>
            {t("explore.summary", {
              count: n(all().length),
              epoch: tipEpoch(),
            })}
          </span>
          <A href="/create" class={css.newBtn}>
            <span class={css.newBtnPlus}>+</span> {t("explore.newSurvey")}
          </A>
        </div>
      </div>

      {/* filters + search */}
      <div class={css.toolbar}>
        <div class={css.filterGroup}>
          <For each={FILTERS}>
            {(f) => (
              <button
                onClick={() => app.setFilter(f.value)}
                class={css.filter}
                classList={{ [css.filterOn]: app.ui.filter === f.value }}
              >
                {t(f.labelKey)}{" "}
                <span
                  class={css.filterCount}
                  classList={{ [css.filterCountOn]: app.ui.filter === f.value }}
                >
                  {counts()[f.value]}
                </span>
              </button>
            )}
          </For>
        </div>
        <div class={css.search}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#BFB39A"
            stroke-width="2.2"
            stroke-linecap="round"
            aria-hidden="true"
            class={css.searchIcon}
          >
            <circle cx="10.5" cy="10.5" r="7" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" />
          </svg>
          <input
            value={searchInput()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
            placeholder={t("explore.searchPlaceholder")}
            class={css.searchInput}
          />
        </div>
      </div>

      {/* register table (cards on narrow screens) */}
      <div class={css.tableWrap}>
        <div class={css.scroll} classList={{ [css.scrollNarrow]: narrow() }}>
          <div class={css.inner} classList={{ [css.innerNarrow]: narrow() }}>
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
                  text={t("explore.loadError", { error: String(err()) })}
                />
              )}
            </Show>

            <Show when={snapData()?.records.incomplete}>
              <div class={css.incomplete}>{t("explore.incomplete")}</div>
            </Show>

            <Show when={!app.snapshot.loading && !app.snapshot.error}>
              <Show when={govRows().length > 0}>
                <SectionLabel
                  dot={<span class={css.dotGov} />}
                  color="var(--gov)"
                  label={t("explore.sectionGov")}
                  note={t("explore.sectionGovNote")}
                />
                <For each={govRows()}>{(a) => <Entry {...rowProps(a)} />}</For>
              </Show>

              <Show when={openRows().length > 0}>
                <SectionLabel
                  dot={<span class={css.dotOpen} />}
                  color="#5E7B49"
                  label={t("explore.sectionOpen")}
                />
                <For each={openRows()}>{(a) => <Entry {...rowProps(a)} />}</For>
              </Show>

              <Show when={closedRows().length > 0}>
                <SectionLabel
                  dot={<span class={css.dotClosed} />}
                  color="#A79C88"
                  label={t("explore.sectionClosed")}
                  note={t("explore.sectionClosedNote")}
                  topBorder
                />
                <div class={css.closedRows}>
                  <For each={closedRows()}>
                    {(a) => <Entry {...rowProps(a)} />}
                  </For>
                </div>
              </Show>

              <Show when={visible().length === 0}>
                <Notice text={t("explore.noMatch")} />
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
      class={css.headerCell}
      classList={{
        [css.cellCenter]: align === "center",
        [css.cellRight]: align === "right",
      }}
    >
      {label}
    </span>
  );
  return (
    <div class={css.header} style={{ "--cols": COLS }}>
      {cell(t("explore.headerForm"), "center")}
      <span />
      <span title={t("explore.headerAnsweredTitle")} class={css.cellCenter}>
        {cell("✓", "center")}
      </span>
      {cell(t("explore.headerSurvey"))}
      {cell(t("explore.headerEligible"))}
      {cell(t("explore.headerEnds"))}
      {cell(t("explore.headerReplies"), "right")}
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
  <div class={css.section} classList={{ [css.sectionTop]: props.topBorder }}>
    {/* Per-section accent is a free-form prop, so it rides in on a CSS var. */}
    <span class={css.sectionTag} style={{ "--section-color": props.color }}>
      {props.dot}
      {props.label}
    </span>
    <Show when={props.note}>
      <span class={css.sectionNote}>{props.note}</span>
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
    title={t("explore.answeredTitle")}
    aria-label={t("explore.answeredAria")}
    class={css.answered}
  >
    ✓
  </span>
);

const YoursBadge: Component = () => (
  <span class={css.badge}>{t("explore.badgeYours")}</span>
);

const OffChainBadge: Component = () => (
  <span class={css.badge}>{t("explore.badgeOffChain")}</span>
);

const GovLine: Component<{ actionId: string; title: string | null }> = (
  props,
) => (
  <div class={css.govLine}>
    {"◇ "}
    {t("explore.govInfoAction", { id: shortGovId(props.actionId) })}
    {props.title ? t("explore.govInfoActionTitle", { title: props.title }) : ""}
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
      class={css.row}
      style={{ "--cols": COLS }}
    >
      <div class={css.formCell}>
        <FormMosaic count={def().questions.length} />
        <span
          class={css.formCount}
          classList={{ [css.formCountClosed]: closed() }}
        >
          {def().questions.length}
        </span>
      </div>
      <div class={css.centerCell}>
        <VisGlyph status={v()} />
      </div>
      <div class={css.centerCell}>
        <Show when={props.flags.responded}>
          <AnsweredCheck />
        </Show>
      </div>
      <div class={css.titleCell}>
        <div class={css.titleLine}>
          <span
            class={css.surveyTitle}
            classList={{ [css.surveyTitleClosed]: closed() }}
          >
            {def().title || t("explore.untitled")}
          </span>
          <Show when={props.flags.mine}>
            <YoursBadge />
          </Show>
          <Show when={labelsMissing()}>
            <OffChainBadge />
          </Show>
        </div>
        <div class={css.desc}>
          {def().description || t("explore.noPresentation")}
        </div>
        <Show when={props.a.govLink}>
          {(link) => (
            <GovLine actionId={link().actionId} title={link().title} />
          )}
        </Show>
      </div>
      <RoleChips roles={def().eligibleRoles} />
      <div>
        <div class={css.ends} classList={{ [css.endsClosed]: closed() }}>
          {ends()}
        </div>
        <Show when={props.pro}>
          <div
            title={t("explore.refTitle")}
            class={css.ref}
            classList={{ [css.refClosed]: closed() }}
          >
            {t("explore.refEpoch", { epoch: def().endEpoch })}
            <br />
            {fullRef(props.a.key)}
          </div>
        </Show>
      </div>
      <div class={css.repliesCell}>
        <span class={css.replies} classList={{ [css.repliesClosed]: closed() }}>
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
  <span class={css.metaChip}>
    <span class={css.metaLabel}>{props.label}</span>
    <span class={css.metaValue}>{props.children}</span>
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
    <A href={`/survey/${encodeURIComponent(props.a.key)}`} class={css.card}>
      <div class={css.cardHead}>
        <span class={css.cardGlyph}>
          <VisGlyph status={v()} />
        </span>
        <Show when={props.flags.responded}>
          <AnsweredCheck />
        </Show>
        <span
          class={css.cardTitle}
          classList={{ [css.cardTitleClosed]: closed() }}
        >
          {def().title || t("explore.untitled")}
        </span>
        <Show when={props.flags.mine}>
          <YoursBadge />
        </Show>
      </div>

      <div class={css.cardDesc}>
        {def().description || t("explore.noPresentation")}
      </div>

      <Show when={labelsMissing()}>
        <div class={css.cardBadgeRow}>
          <OffChainBadge />
        </div>
      </Show>
      <Show when={props.a.govLink}>
        {(link) => <GovLine actionId={link().actionId} title={link().title} />}
      </Show>

      <div class={css.cardMeta}>
        <MetaChip label={t("explore.metaForm")}>
          <span class={css.cardFormInline}>
            <FormMosaic count={def().questions.length} size={16} />
            {def().questions.length}
          </span>
        </MetaChip>
        <Show when={def().eligibleRoles.length > 0}>
          <MetaChip label={t("explore.metaEligible")}>
            <RoleChips roles={def().eligibleRoles} />
          </MetaChip>
        </Show>
        <MetaChip label={t("explore.metaEnds")}>
          <span
            class={css.cardEnds}
            classList={{ [css.cardEndsClosed]: closed() }}
          >
            {ends()}
          </span>
        </MetaChip>
        <MetaChip label={t("explore.metaReplies")}>
          {v() === "cancelled" ? "—" : String(props.a.responseCount)}
        </MetaChip>
        <Show when={props.pro}>
          <MetaChip label={t("explore.metaEpoch")}>
            {String(def().endEpoch)}
          </MetaChip>
        </Show>
      </div>
      <Show when={props.pro}>
        <div title={t("explore.refTitle")} class={css.cardRef}>
          {t("explore.refLabel", { ref: fullRef(props.a.key) })}
        </div>
      </Show>
    </A>
  );
};

const Legend: Component = () => (
  <div class={css.legend}>
    <FormMosaic count={4} size={14} />
    <span class={css.legendText}>{t("explore.legendForm")}</span>
    <span class={css.legendGroup}>
      <span class={css.legendDot} />
      <span class={css.legendText}>{t("explore.legendPublic")}</span>
      <span class={css.legendSealed}>
        <VisGlyph status="sealed" />
      </span>
      <span class={css.legendText}>{t("explore.legendSealed")}</span>
      <span class={css.legendCheck}>✓</span>
      <span class={css.legendText}>{t("explore.legendAnswered")}</span>
    </span>
  </div>
);

const Notice: Component<{ text: string; tone?: "danger" }> = (props) => (
  <div
    class={css.notice}
    classList={{ [css.noticeDanger]: props.tone === "danger" }}
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
  <div class={css.intro}>
    <button
      onClick={() => props.onDismiss()}
      title={t("explore.introDismiss")}
      class={css.introDismiss}
    >
      ×
    </button>
    <h2 class={css.introTitle}>{t("explore.introTitle")}</h2>
    <p class={css.introBody}>{t("explore.introBody")}</p>
  </div>
);

// Width/height are computed per-instance, so they ride in on CSS vars consumed
// by `.skeletonBar`; everything else is static.
function skeletonBar(width: string, height = "12px"): JSX.Element {
  return (
    <span
      class={css.skeletonBar}
      style={{ "--bar-w": width, "--bar-h": height }}
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
          <div class={css.skeletonCard}>
            {skeletonBar("58%", "14px")}
            {skeletonBar("38%")}
          </div>
        }
      >
        <div class={css.skeletonRow} style={{ "--cols": COLS }}>
          <span class={css.skeletonForm} />
          <span class={css.skeletonDot} />
          <span />
          {skeletonBar(`${74 - (i % 3) * 14}%`, "13px")}
          {skeletonBar("72%")}
          {skeletonBar("60%")}
          <span class={css.skeletonReplies} />
        </div>
      </Show>
    )}
  </For>
);

/** Shorten a bech32 governance action id for inline display. */
function shortGovId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}
