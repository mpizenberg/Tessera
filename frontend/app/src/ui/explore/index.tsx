import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js";
import { A } from "@solidjs/router";

import type { ChainTip, SurveyAggregate } from "cip-179/domain";

import { useApp, type ExploreFilter } from "~/state";
import { walletOwns } from "~/domain/roles";
import { isClosed, viewStatus } from "~/ui/format";
import { HealthFooter } from "~/ui/components/HealthFooter";
import type { WalletCredential, WalletIdentity } from "~/wallet/types";
import { t, n, type MsgKey } from "~/i18n";
import {
  GridNotice,
  HeaderRow,
  IntroHero,
  Legend,
  SectionLabel,
  SkeletonRows,
  introIsDismissed,
  rememberIntroDismissed,
} from "./Chrome";
import { Entry, type EntryProps, type Flags } from "./Row";
import css from "./explore.module.css";

// Below this width the table gets cramped, so each row reflows into a card.
const CARD_BREAKPOINT = 800;

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

export const Explore: Component = () => {
  const app = useApp();

  // Reading the resource accessor throws while the list is in error state
  // (Solid resource semantics). Every *value* read goes through this guard so a
  // failed load surfaces via `app.list.error` (the GridNotice below) rather
  // than throwing — the `.error`/`.loading` reads are always safe.
  const snapData = () => (app.list.error ? undefined : app.list());

  // Filtering, search, chip counts, ordering, and pagination all happen at
  // the source (server-side in indexer mode, the same core semantics in
  // memory in direct-Koios mode) — this screen renders what arrives: the
  // first page plus any "show more" pages, with the session's optimistic
  // surveys on top until the indexer catches up.
  const all = createMemo(() => {
    const real = [...(snapData()?.surveys ?? []), ...app.moreSurveys()];
    const realKeys = new Set(real.map((s) => s.key));
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

  // Survey ref keys the connected wallet has responded to (any attempt counts).
  // Fetched through the seam's slim projection — the wallet's credentials
  // (payment + stake, the same set `walletOwns` checks) go out as core
  // `credentialKey` strings, survey keys come back. Joined to one string so the
  // resource only refetches when the credential set genuinely changes.
  const credentialKeys = createMemo<string | undefined>(() => {
    const id = identity();
    if (!id) return undefined;
    return [id.payment, id.stake]
      .filter((c): c is WalletCredential => c !== undefined)
      .map((c) => `${c.kind}:${c.hashHex}`)
      .join(",");
  });
  const [responded] = createResource(credentialKeys, (keys) =>
    app.source.respondedKeys(keys.split(",")),
  );
  const respondedKeys = createMemo<Set<string>>(() => {
    // Best-effort flags: no wallet (or a failed fetch) just means no checkmarks.
    if (!identity() || responded.error) return new Set();
    return new Set(responded() ?? []);
  });

  const flagsOf = (a: SurveyAggregate): Flags => {
    const id = identity();
    return {
      mine: id ? walletOwns(id, a.record.definition.owner) : false,
      responded: respondedKeys().has(a.key),
      stuck: app.optimisticStuck().has(a.key),
    };
  };

  // Global chip counts come with the page (they cover the whole matching set,
  // not just loaded rows); zeros while the first page is in flight.
  const counts = createMemo<Record<ExploreFilter, number>>(
    () =>
      snapData()?.counts ?? {
        all: 0,
        linked: 0,
        active: 0,
        sealed: 0,
        public: 0,
        mine: 0,
      },
  );

  // Rows arrive already filtered and searched; optimistic ones ride on top.
  const visible = all;

  // Linked (governance) surveys get their own section, shown first; the rest
  // split into open / closed so a linked survey never appears twice.
  const govRows = createMemo(() =>
    visible().filter((a) => a.govLinks.length > 0),
  );
  const openRows = createMemo(() =>
    visible().filter(
      (a) => a.govLinks.length === 0 && !isClosed(viewStatus(a)),
    ),
  );
  const closedRows = createMemo(() =>
    visible().filter((a) => a.govLinks.length === 0 && isClosed(viewStatus(a))),
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
              count: n(counts().all),
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

            <Show when={app.list.loading}>
              <SkeletonRows narrow={narrow()} />
            </Show>
            <Show when={app.list.error as unknown}>
              {(err) => (
                <GridNotice
                  tone="danger"
                  text={t("explore.loadError", { error: String(err()) })}
                />
              )}
            </Show>

            <Show when={snapData()?.incomplete}>
              <div class={css.incomplete}>{t("explore.incomplete")}</div>
            </Show>

            <Show when={!app.list.loading && !app.list.error}>
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
                <GridNotice text={t("explore.noMatch")} />
              </Show>

              <Show when={app.nextCursor()}>
                <div class={css.loadMoreRow}>
                  <button
                    onClick={() => app.loadMore()}
                    disabled={app.loadingMore()}
                    class={css.loadMore}
                  >
                    {app.loadingMore()
                      ? t("explore.loadingMore")
                      : t("explore.loadMore")}
                  </button>
                  <span class={css.loadMoreCount}>
                    {t("explore.shownOfTotal", {
                      shown: n(visible().length),
                      total: n(counts()[app.ui.filter]),
                    })}
                  </span>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>

      <Legend />
      <HealthFooter />
    </main>
  );
};
