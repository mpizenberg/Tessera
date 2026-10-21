/**
 * App-wide state, provided once at the root.
 *
 * - `source`  the active DataSource (Koios or the indexer backend) — the seam.
 * - `list`    a Solid resource holding the survey-list payload (tip + derived
 *             survey aggregates). Loading/error states come for free. Per-survey
 *             data (raw responses for audit/tally) is NOT here — detail pages
 *             fetch their own `surveyBundle(ref)` lazily through `source`.
 * - `ui`      small client-only UI state (explore filter + search) in a store.
 *
 * Domain data lives only in the resources; the store never duplicates it.
 */

import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  useContext,
  type Accessor,
  type ParentComponent,
  type Resource,
} from "solid-js";
import { createStore, produce } from "solid-js/store";

import {
  loadConfig,
  resolveIndexerUrl,
  storeKoiosToken,
  storedLastWallet,
  storeLastWallet,
  clearLastWallet,
  type AppConfig,
} from "~/config";
import {
  loadProviderTokens,
  storeProviderToken,
  type ProviderId,
  type ProviderTokens,
} from "~/enrichment/providers";
import { KoiosDataSource } from "cardano-tessera-koios";
import { IndexerDataSource } from "~/data/indexer";
import type {
  BackendHealth,
  Settling,
  SurveyFinalState,
  SurveyListCounts,
  SurveyListFilter,
  SurveyListParams,
  SurveyListPayload,
  SurveySection,
  SurveySectionHead,
} from "cardano-tessera-client";
import { SURVEY_SECTIONS } from "cardano-tessera-client";
import {
  aggregateSurveyList,
  pageSurveySections,
  surveyListSlice,
  type DataSource,
} from "cardano-tessera-core";
import {
  aggregateSurveys,
  bytesToHex,
  findSurvey,
  refKey,
  type ChainTip,
  type SurveyAggregate,
} from "cip-179/domain";
import { claimableRoles } from "~/domain/roles";
import {
  connectWallet,
  isWalletEnabled,
  listInstalledWallets,
} from "~/wallet/cip30";
import {
  STALL_AFTER_MS,
  loadPendingTxs,
  pendingSurveyRecords,
  storePendingTxs,
  type PendingTx,
} from "~/wallet/pending";
import type { Action } from "~/wallet/action";
import { loadCart, storeCart } from "~/wallet/cart";
import { plan, type PlannedTx } from "~/wallet/plan";
import type { BuiltTx } from "~/wallet/submit";
import type { ConnectedWallet, InstalledWallet } from "~/wallet/types";
import {
  applyPresentation,
  parsePresentation,
} from "~/enrichment/presentation";
import { loadAllDocs, putDoc } from "~/enrichment/docStore";
import type { SurveyDefinition } from "cip-179";

/**
 * A list answer as the app holds it: the first page of every Explore section
 * (the eager list resource), one section's later page, or a survey read by
 * key.
 */
export interface SurveyList {
  readonly tip: ChainTip;
  readonly surveys: readonly SurveyAggregate[];
  /**
   * The serving tier's final decision per survey key on this page, naming each
   * artifact's hash; absent from a source with no finalization.
   */
  readonly finalState?: Readonly<Record<string, SurveyFinalState>>;
  /** The epoch whose end is not final yet, so whose surveys are undecided. */
  readonly settling?: Settling;
  /** True when the source's scan may have missed records (paging cap hit). */
  readonly incomplete?: boolean;
  /** Global per-chip totals over the search-matching set. */
  readonly counts: SurveyListCounts;
  /** Each section's first page: keys, total, continuation. */
  readonly sections?: Readonly<Record<SurveySection, SurveySectionHead>>;
  /** On a section's later page, its continuation, or null on its last. */
  readonly nextCursor: string | null;
}

function toSurveyList(payload: SurveyListPayload): SurveyList {
  return {
    tip: payload.tip,
    surveys: aggregateSurveyList(payload),
    ...(payload.finalState !== undefined && {
      finalState: payload.finalState,
    }),
    ...(payload.settling !== undefined && { settling: payload.settling }),
    counts: payload.counts ?? {
      all: 0,
      linked: 0,
      active: 0,
      sealed: 0,
      public: 0,
      mine: 0,
    },
    ...(payload.sections !== undefined && { sections: payload.sections }),
    nextCursor: payload.nextCursor ?? null,
    ...(payload.incomplete !== undefined && {
      incomplete: payload.incomplete,
    }),
  };
}

export interface SurveySnapshot {
  /** Holds the survey once read; one without it means no such survey. */
  readonly snap: Accessor<SurveyList | undefined>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<unknown>;
}

/** One Explore section as shown: its page of rows, and how to turn it. */
export interface ExploreSection {
  /** The page shown; the previous one stays while the next loads. */
  readonly rows: Accessor<readonly SurveyAggregate[]>;
  /** How many rows the pages before the shown one hold: 0 on page one. */
  readonly offset: Accessor<number>;
  /** Rows the section holds under the filter and search. */
  readonly total: Accessor<number>;
  readonly loading: Accessor<boolean>;
  readonly hasNext: Accessor<boolean>;
  /** Show the page after (no-op while loading or on the last). */
  next(): void;
  /** Show the page before (no-op on page one). */
  previous(): void;
}

/** Where a page past the first starts: its cursor and the rows before it. */
interface PageStart {
  readonly cursor: string;
  readonly offset: number;
}

/** The Explore filter chips — exactly the shared paged-list filters. */
export type ExploreFilter = SurveyListFilter;

export interface UiState {
  filter: ExploreFilter;
  search: string;
  /** Pro mode surfaces technical detail (refs, epochs, drand rounds). */
  pro: boolean;
}

/**
 * Poll the data source for inclusion at this cadence while anything is pending.
 * (The `DataSource` seam — the indexer in the default deployment, Koios direct
 * otherwise — not Koios unconditionally.)
 */
const POLL_INTERVAL_MS = 20_000;
/** Keep a confirmed tx announced briefly before it stops being news. */
const CONFIRMED_LINGER_MS = 6_000;

interface AppState {
  readonly config: AppConfig;
  readonly source: DataSource;
  /**
   * Every Explore section's first page for the active filter/search, with
   * the chip counts (re-fetched whenever either changes).
   */
  readonly list: Resource<SurveyList>;
  /** The Explore sections, each paged on its own from {@link list}. */
  readonly sections: Readonly<Record<SurveySection, ExploreSection>>;
  /**
   * The snapshot holding survey `key`: the Explore page shown when the survey
   * is on it, else the survey read by key, so a link opens any survey. Call
   * it while creating a component; `reload()` refreshes it.
   */
  surveySnapshot(key: Accessor<string>): SurveySnapshot;
  /**
   * Backend operational health (the Explore footer), or null when the active
   * source has none to report (direct-Koios mode). Refetched by `reload()`.
   */
  readonly health: Resource<BackendHealth | null>;
  reload(): void;
  readonly ui: UiState;
  setFilter(f: ExploreFilter): void;
  setSearch(s: string): void;
  setPro(pro: boolean): void;

  /**
   * Active Koios bearer token (Settings override → env). Reactive: the data
   * source reads it live, so changing it + reloading applies immediately.
   */
  readonly koiosToken: Accessor<string | undefined>;
  /** Persist a Koios token override (empty clears it) and reload the snapshot. */
  setKoiosToken(token: string): void;
  /** IPFS pinning-provider API tokens (reactive store), for in-app uploads. */
  readonly ipfsTokens: ProviderTokens;
  /** Persist (or clear, when empty) a provider's token. */
  setIpfsToken(id: ProviderId, token: string): void;

  // --- wallet / identity ---
  /**
   * Wallets advertised on window.cardano. Reactive: backed by a signal that's
   * refreshed briefly after mount (wallets inject asynchronously) and on focus,
   * so a connect menu re-renders as a slow wallet appears.
   */
  installedWallets(): InstalledWallet[];
  readonly wallet: Accessor<ConnectedWallet | null>;
  readonly connecting: Accessor<boolean>;
  readonly connectError: Accessor<string | null>;
  connect(key: string): Promise<void>;
  disconnect(): void;
  /** Roles the connected wallet may claim globally (Stakeholder/DRep). */
  readonly claimableRoles: Accessor<number[]>;
  readonly activeRole: Accessor<number | null>;
  setActiveRole(role: number | null): void;
  // --- the action cart (the one submission path) ---
  /** Actions waiting to be published, oldest first. */
  readonly cart: Accessor<readonly Action[]>;
  /** Queue actions for publication later, alongside whatever is already waiting. */
  enqueue(actions: readonly Action[]): void;
  /** Drop a queued action. */
  removeFromCart(action: Action): void;
  /**
   * Queue `actions` and, when nothing else was waiting, publish them at once —
   * so a single action stays one click. Resolves to the submitted transaction
   * hashes, or to `null` when they are in the cart instead: because something
   * was already queued, or because the chain still wants a signature. Throws
   * only if the chain could not be built, and then the queue is left as it was.
   */
  submitOrQueue(actions: readonly Action[]): Promise<readonly string[] | null>;
  /**
   * Partition everything queued into transactions, build them with the
   * connected wallet, and sign and submit as far as that wallet allows.
   * Failures land in {@link signError} rather than throwing, since the drawer is
   * where a chain that stopped short is recovered.
   *
   * Anything about a survey whose definition is still in flight is chained onto
   * that definition's transaction, so a response can never outlive the survey
   * it answers.
   */
  submitCart(): Promise<void>;
  /** The transactions the queued actions would be published in. */
  planCart(): Promise<readonly PlannedTx[]>;
  readonly cartOpen: Accessor<boolean>;
  setCartOpen(open: boolean): void;

  // --- the signing session (a built chain gathering its witnesses) ---
  /**
   * The chain built from the cart, still gathering signatures; empty when none
   * is being published. Actions stay in the cart until the transaction carrying
   * them is submitted, so a session holds no state that a reload would lose —
   * only the built bytes and the witnesses collected so far.
   */
  readonly signing: Accessor<readonly BuiltTx[]>;
  /** What went wrong in the last round of signing or submitting, if anything. */
  readonly signError: Accessor<string | null>;
  /**
   * Sign whatever the connected wallet holds keys for, publishing each
   * transaction as soon as it holds every witness it needs. Called again after
   * connecting another wallet: transactions already witnessed are skipped, so
   * only the outstanding signatures are prompted for.
   */
  signWithWallet(): Promise<void>;
  /**
   * Throw away what is left of the built chain and the signatures gathered for
   * it. Anything already published has left {@link signing} and the cart with
   * it; what these transactions would publish is still queued.
   */
  discardSigning(): void;
  /**
   * True while a chain is being signed: the cart's contents are fixed until it
   * is published or discarded, since they are what was built.
   */
  readonly cartLocked: Accessor<boolean>;

  // --- pending transactions (the local chain projection) ---
  /**
   * Transactions submitted from this browser that the chain hasn't shown yet.
   * The single source both projections derive from: the wallet's projected UTxO
   * set (inside `submitCart`) and the optimistic survey overlay below.
   */
  readonly pendingTxs: Accessor<readonly PendingTx[]>;
  /** Stop announcing a tx; its projections stand until indexed data supersedes them. */
  dismissTx(txHash: string): void;
  /**
   * Forget a transaction, dropping its projections and returning what it
   * published to the cart. This cancels nothing: a submitted transaction can
   * still be included afterwards, in which case publishing the queued actions
   * again would duplicate it.
   */
  dropTx(txHash: string): void;
  /**
   * Broadcast a stalled transaction's stored bytes again — same signature, same
   * hash, so a copy still alive in some mempool is unaffected — and restart its
   * stall clock. Throws what the wallet reports.
   */
  resubmitTx(txHash: string): Promise<void>;
  /**
   * Surveys shown immediately on creation, before the indexer catches up —
   * decoded from the pending set's own payloads. The wallet already accepted
   * those transactions, so their definitions are what will be on-chain.
   */
  readonly optimisticSurveys: Accessor<readonly SurveyAggregate[]>;
  /**
   * Keys of optimistic surveys whose defining tx has stalled — surfaced as
   * "not yet on-chain" instead of deleted (nothing guarantees the tx lands).
   */
  readonly optimisticStuck: Accessor<ReadonlySet<string>>;
  /**
   * Remember a presentation document we just authored, keyed by its content
   * hash, so the survey it describes renders with full labels immediately —
   * without re-fetching our own content from IPFS (which may not have
   * propagated yet). The hash is content-addressed, so this stays correct even
   * once the real indexed record loads.
   */
  cachePresentationDoc(hash: Uint8Array, doc: unknown): void;
  /** A previously cached presentation doc for this content hash, if any. */
  cachedPresentationDoc(hash: Uint8Array): unknown | undefined;
  /**
   * Resolves once the persistent (IndexedDB) document cache has been loaded
   * into memory. Await before deciding to fetch an anchored doc, so a copy
   * persisted in an earlier session is used instead of re-downloading it.
   */
  readonly cacheReady: Promise<void>;
  /**
   * Display definition using only the in-session presentation cache: enriched
   * with off-chain labels when we already hold the doc (authored this session),
   * otherwise the on-chain definition unchanged. Synchronous and network-free —
   * for list views (Explore) that can't afford a fetch per row.
   */
  displayDefinition(def: SurveyDefinition): SurveyDefinition;
}

const Ctx = createContext<AppState>();

export const AppProvider: ParentComponent = (props) => {
  const config = loadConfig();

  // Koios token: reactive so a Settings override applies on the next reload
  // without rebuilding the source (which reads it through this getter).
  const [koiosToken, setKoiosTokenSig] = createSignal(config.koiosToken);
  // Reads flow through the Tier-1 serving backend when one is configured
  // (the deployment's `indexerUrl`) — the secure/scalable default — otherwise
  // straight to Koios (the direct/power-user/offline path). See
  // `backend/ARCHITECTURE.md` §7.
  const indexerUrl = resolveIndexerUrl();
  const source: DataSource = indexerUrl
    ? new IndexerDataSource(indexerUrl, config.network)
    : new KoiosDataSource(config, () => koiosToken());

  // Wallet identity is declared before the list resource because the paged
  // list's `mine` filter/count matches survey owners against its credentials.
  const [wallet, setWallet] = createSignal<ConnectedWallet | null>(null);
  const walletCredentialKeys = createMemo<readonly string[]>(() => {
    const id = wallet()?.identity;
    if (!id) return [];
    return [id.payment, id.stake]
      .filter((c) => c !== undefined)
      .map((c) => `${c.kind}:${c.hashHex}`);
  });

  const [ui, setUi] = createStore<UiState>({
    filter: "all",
    search: "",
    pro: false,
  });

  // Reads through the seam: server-side when the source implements them (the
  // indexer), otherwise over the full one-shot payload in memory with the same
  // core semantics (direct-Koios mode). The full payload is cached across
  // filter/search/page changes — one Koios scan per reload, not one per chip
  // click.
  let fullListCache: Promise<SurveyListPayload> | null = null;
  const fullList = (): Promise<SurveyListPayload> => {
    fullListCache ??= source.surveyList();
    // A failed scan must not be cached as "the list" forever.
    fullListCache.catch(() => {
      fullListCache = null;
    });
    return fullListCache;
  };
  const fetchSections = (
    params: SurveyListParams,
  ): Promise<SurveyListPayload> =>
    source.surveyListPage
      ? source.surveyListPage({ ...params, sections: true })
      : fullList().then((full) =>
          pageSurveySections(full, params, config.network),
        );
  const fetchByKey = (key: string): Promise<SurveyListPayload> =>
    source.surveysByRefs
      ? source.surveysByRefs([key])
      : fullList().then((full) =>
          surveyListSlice(
            full,
            full.surveys.filter((s) => refKey(s.ref) === key),
          ),
        );

  const pageParams = createMemo(
    (): Omit<SurveyListParams, "cursor" | "limit"> => ({
      filter: ui.filter,
      search: ui.search,
      credentials: walletCredentialKeys(),
    }),
  );

  const paramsKey = createMemo(() => JSON.stringify(pageParams()));
  const [list, { refetch }] = createResource<SurveyList, string>(
    paramsKey,
    // One bounded read regardless of participation volume: responses arrive
    // pre-deduped as per-survey counts, governance-link failures are absorbed
    // source-side, and each section's page bounds the survey rows too.
    async () => toSurveyList(await fetchSections(pageParams())),
  );
  const listed = (): SurveyList | undefined =>
    list.error ? undefined : list();

  // Each section's pages walked past its first, each with the rows before
  // it. Keyed by the params they were walked under, so a filter or search
  // change shows every section's first page again.
  const [walks, setWalks] = createSignal<{
    readonly key: string;
    readonly pages: Partial<Record<SurveySection, readonly PageStart[]>>;
  }>({ key: "", pages: {} });
  const walked = () => (walks().key === paramsKey() ? walks().pages : {});
  const pagesOf = (s: SurveySection): readonly PageStart[] => walked()[s] ?? [];
  const setPagesOf = (s: SurveySection, pages: readonly PageStart[]): void => {
    setWalks({ key: paramsKey(), pages: { ...walked(), [s]: pages } });
  };

  // A section's later page is read by its own cursor. A `resync` answer is
  // still the page from that cursor, which is all a reader paging back and
  // forth needs.
  const sectionPages: Accessor<SurveyList | undefined>[] = [];
  const sectionRefetches: (() => unknown)[] = [];
  const sectionOf = (name: SurveySection): ExploreSection => {
    const start = (): PageStart | undefined => {
      const pages = pagesOf(name);
      return pages[pages.length - 1];
    };
    const [page, { refetch }] = createResource(
      () => {
        const cursor = start()?.cursor;
        return cursor ? JSON.stringify([pageParams(), cursor]) : false;
      },
      async () =>
        toSurveyList(
          await fetchSections({ ...pageParams(), cursor: start()?.cursor }),
        ),
    );
    const shownPage = (): SurveyList | undefined =>
      start() && !page.error ? page() : undefined;
    sectionPages.push(shownPage);
    sectionRefetches.push(refetch);
    const head = () => listed()?.sections?.[name];
    const rows = createMemo<readonly SurveyAggregate[]>((previous) => {
      if (start())
        return page.loading ? previous : (shownPage()?.surveys ?? []);
      const l = listed();
      const byKey = new Map(l?.surveys.map((a) => [a.key, a]));
      return (head()?.keys ?? []).flatMap((k) => byKey.get(k) ?? []);
    }, []);
    const nextCursor = (): string | null =>
      start()
        ? (shownPage()?.nextCursor ?? null)
        : (head()?.nextCursor ?? null);
    const offset = (): number => start()?.offset ?? 0;
    return {
      rows,
      offset,
      total: () => head()?.total ?? 0,
      loading: () => page.loading,
      hasNext: () => nextCursor() !== null,
      next: () => {
        const cursor = nextCursor();
        if (!cursor || page.loading) return;
        setPagesOf(name, [
          ...pagesOf(name),
          { cursor, offset: offset() + rows().length },
        ]);
      },
      previous: () => setPagesOf(name, pagesOf(name).slice(0, -1)),
    };
  };
  const sections = Object.fromEntries(
    SURVEY_SECTIONS.map((name) => [name, sectionOf(name)]),
  ) as Record<SurveySection, ExploreSection>;

  // Refetchers of the surveys read by key, so `reload()` refreshes them too.
  const byKeyRefetches = new Set<() => unknown>();
  const surveySnapshot = (key: Accessor<string>): SurveySnapshot => {
    const shown = (): SurveyList | undefined =>
      [listed(), ...sectionPages.map((p) => p())].find(
        (l) => l && findSurvey(l.surveys, key()),
      );
    // Read by key only once the page is in and lacks it.
    const [byKey, { refetch }] = createResource(
      () =>
        list.state === "unresolved" || list.state === "pending" || shown()
          ? false
          : key(),
      async (k) => toSurveyList(await fetchByKey(k)),
    );
    byKeyRefetches.add(refetch);
    onCleanup(() => byKeyRefetches.delete(refetch));
    return {
      snap: () => shown() ?? (byKey.error ? undefined : byKey()),
      loading: () =>
        !shown() &&
        (list.state === "unresolved" ||
          list.state === "pending" ||
          byKey.loading),
      error: () => (shown() ? undefined : byKey.error),
    };
  };

  // Health is footer chrome, never load-bearing: absent in direct-Koios mode
  // (the seam method is undefined there) and a failed fetch just hides the
  // footer via `health.error`.
  const [health, { refetch: refetchHealth }] =
    createResource<BackendHealth | null>(async () =>
      source.health ? source.health() : null,
    );

  // Refetch but swallow the returned promise's rejection: a failed load is
  // already captured in `snapshot.error` (and surfaced by the UI / the app-wide
  // ErrorBoundary), so the bare promise must not also bubble as an unhandled
  // rejection. `refetch()` may return a value or a promise, hence Promise.resolve.
  const safeRefetch = (): void => {
    fullListCache = null; // direct-Koios mode: a reload means a fresh scan
    void Promise.resolve(refetch()).catch(() => {});
    for (const r of [...sectionRefetches, ...byKeyRefetches])
      void Promise.resolve(r()).catch(() => {});
    void Promise.resolve(refetchHealth()).catch(() => {});
  };

  const [ipfsTokens, setIpfsTokensStore] =
    createStore<ProviderTokens>(loadProviderTokens());
  const setIpfsToken = (id: ProviderId, token: string): void => {
    storeProviderToken(id, token);
    const trimmed = token.trim();
    setIpfsTokensStore(id, trimmed || undefined);
  };

  // The pending set: transactions this browser submitted and the chain hasn't
  // shown yet, restored from the last session. A CIP-30-accepted tx almost
  // always lands, so polling exists only to flip pending → confirmed, never to
  // refetch the snapshot. But "almost": nothing guarantees inclusion, which is
  // what the stall clock (`STALL_AFTER_MS`) and `optimisticStuck` are for.
  const [pendingTxs, setPendingTxs] =
    createSignal<readonly PendingTx[]>(loadPendingTxs());
  createEffect(() => storePendingTxs(pendingTxs()));

  const trackTx = (tx: PendingTx): void => {
    setPendingTxs((prev) => [
      tx,
      ...prev.filter((p) => p.txHash !== tx.txHash),
    ]);
  };
  const updateTx = (txHash: string, patch: Partial<PendingTx>): void => {
    setPendingTxs((prev) =>
      prev.map((p) => (p.txHash === txHash ? { ...p, ...patch } : p)),
    );
  };
  // The queue of things to publish. Actions are the durable unit — a
  // transaction can stall, be forgotten and be rebuilt, but what the user meant
  // to publish survives all of that, and a reload.
  const [cart, setCart] = createSignal<readonly Action[]>(loadCart());
  createEffect(() => storeCart(cart()));
  const [cartOpen, setCartOpen] = createSignal(false);

  const enqueue = (actions: readonly Action[]): void => {
    setCart((prev) => [...prev, ...actions]);
  };

  const dropTx = (txHash: string): void => {
    const forgotten = pendingTxs().find((p) => p.txHash === txHash);
    setPendingTxs((prev) => prev.filter((p) => p.txHash !== txHash));
    if (forgotten) enqueue(forgotten.actions);
  };

  const pollPending = async (): Promise<void> => {
    const open = pendingTxs().filter((p) => p.status === "pending");
    if (open.length === 0) return;
    let statuses: Map<string, number | null>;
    try {
      statuses = await source.txStatus(open.map((p) => p.txHash));
    } catch {
      return; // transient — try again on the next tick
    }
    const now = Date.now();
    for (const p of open) {
      const conf = statuses.get(p.txHash);
      if (conf != null && conf > 0) {
        updateTx(p.txHash, { status: "confirmed" });
        setTimeout(
          () => updateTx(p.txHash, { status: "done" }),
          CONFIRMED_LINGER_MS,
        );
      } else if (!p.stalled && now - p.submittedAt > STALL_AFTER_MS) {
        updateTx(p.txHash, { stalled: true });
      }
    }
  };

  // A single poller, alive only while something is pending. It also reconciles
  // the restored set: a tx that landed while the app was closed is confirmed on
  // the first tick. It tracks *whether* anything is pending and nothing else —
  // reading the set would restart the interval, and fire another immediate
  // poll, on every submission and every status flip.
  const anyPending = createMemo(() =>
    pendingTxs().some((p) => p.status === "pending"),
  );
  createEffect(() => {
    if (!anyPending()) return;
    untrack(() => void pollPending());
    const id = setInterval(() => void pollPending(), POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(id));
  });

  // An entry that is done being announced lives exactly as long as its overlay:
  // a published definition's optimistic survey stands until the indexer serves
  // the real record. Entries publishing nothing (responses, cancellations,
  // governance proposals) have no overlay to outlive, so they go at once.
  createEffect(() => {
    const indexed = new Set(
      (list.error ? undefined : list())?.surveys.map((s) => s.key) ?? [],
    );
    setPendingTxs((prev) => {
      const kept = prev.filter(
        (p) =>
          p.status !== "done" ||
          pendingSurveyRecords(p).some((r) => !indexed.has(refKey(r.ref))),
      );
      return kept.length === prev.length ? prev : kept;
    });
  });

  // Surveys whose defining transaction is still in flight, mapped to it. The
  // planner chains anything about one of them onto that transaction, so a
  // response, cancellation or proposal cannot be included without the survey it
  // concerns. Confirmed entries are left out: they are already on chain.
  const definingTx = createMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    for (const p of pendingTxs()) {
      if (p.status !== "pending") continue;
      for (const r of pendingSurveyRecords(p)) map.set(refKey(r.ref), p.txHash);
    }
    return map;
  });

  // The chain built from the cart while its signatures are gathered. Held in
  // memory only: the actions it publishes stay in the cart until submission, so
  // a reload costs the built bytes and nothing durable.
  const [signing, setSigning] = createSignal<readonly BuiltTx[]>([]);
  const [signError, setSignError] = createSignal<string | null>(null);

  // Take the chain as far as the connected wallet allows: sign what it holds
  // keys for, publish each transaction as soon as it is complete. Never throws:
  // a chain that stopped short is recovered from the drawer, so its errors
  // belong to the session rather than to whoever started it.
  const advance = async (): Promise<readonly string[]> => {
    const w = wallet();
    if (!w) {
      setSignError("No wallet connected");
      return [];
    }
    const { signAndSubmitChain } = await import("~/wallet/submit");

    // What a transaction publishes leaves the cart the moment it is submitted,
    // so a chain that stopped partway leaves the rest of the queue exactly
    // where it was.
    const hashes: string[] = [];
    const { txs, error } = await signAndSubmitChain(w.api, signing(), (tx) => {
      hashes.push(tx.txHash);
      trackTx({
        txHash: tx.txHash,
        txCbor: tx.txCbor,
        actions: tx.planned.actions,
        submittedAt: Date.now(),
        status: "pending",
        stalled: false,
      });
      const published = new Set(tx.planned.actions);
      setCart((prev) => prev.filter((a) => !published.has(a)));
    });
    setSigning(txs);
    setSignError(error);
    if (txs.length > 0) setCartOpen(true); // the drawer names what is left
    return hashes;
  };

  // Build `actions` into a chain and take it as far as the connected wallet
  // can. The planner hands the very action objects back, which is what maps a
  // transaction onto the queue entries it publishes.
  const startSigning = async (
    actions: readonly Action[],
  ): Promise<readonly string[]> => {
    const w = wallet();
    if (!w) throw new Error("No wallet connected");
    // Lazy-load the evolution-sdk transaction builder so its weight is fetched
    // only when a user actually submits, not on first paint.
    const { payloadSize, buildChain } = await import("~/wallet/submit");
    const txs = plan(actions, {
      definingTx: definingTx(),
      measure: payloadSize,
    });
    setSignError(null);
    setSigning(
      await buildChain(
        { ...config, koiosToken: koiosToken(), indexerUrl },
        w.api,
        txs,
        pendingTxs(),
      ),
    );
    return advance();
  };

  // The pending set's domain projection. Aggregation needs the tip, so this is
  // empty until the list resolves — and fills itself in when it does, with no
  // queue of records waiting on a tip that hasn't arrived.
  const optimisticSurveys = createMemo<readonly SurveyAggregate[]>(() => {
    const tip: ChainTip | undefined = (list.error ? undefined : list())?.tip;
    if (!tip) return [];
    const surveys = pendingTxs().flatMap(pendingSurveyRecords);
    if (surveys.length === 0) return [];
    return aggregateSurveys({ surveys, responses: [], cancellations: [] }, tip);
  });

  // Optimistic surveys whose defining tx has stalled: shown as "not yet
  // on-chain" rather than silently deleted — the author needs the receipt to
  // retry, and a quiet disappearance reads as data loss. The mark clears on its
  // own, since inclusion confirms the tx and indexing evicts the entry.
  const optimisticStuck = createMemo<ReadonlySet<string>>(() => {
    const stuck = new Set<string>();
    for (const p of pendingTxs()) {
      if (p.status !== "pending" || !p.stalled) continue;
      for (const r of pendingSurveyRecords(p)) stuck.add(refKey(r.ref));
    }
    return stuck;
  });

  // Content-addressed document cache (survey presentation docs), in two tiers:
  // a reactive in-memory map for synchronous reads (list views can't await),
  // backed by IndexedDB so each doc is fetched from IPFS at most once across
  // sessions. Keyed by content-hash hex; immutable, so no invalidation. Reads
  // through the store stay reactive — rows upgrade in place as docs land.
  const [docCache, setDocCache] = createStore<Record<string, unknown>>({});
  const cacheReady: Promise<void> = loadAllDocs()
    .then((entries) =>
      setDocCache(
        produce((c) => {
          for (const [hex, doc] of entries) c[hex] = doc;
        }),
      ),
    )
    .catch(() => {});
  const cachePresentationDoc = (hash: Uint8Array, doc: unknown): void => {
    const hex = bytesToHex(hash);
    if (docCache[hex] !== undefined) return; // already known (memory or IDB)
    setDocCache(hex, doc);
    void putDoc(hex, doc); // write-through; persists for future sessions
  };
  const cachedPresentationDoc = (hash: Uint8Array): unknown | undefined =>
    docCache[bytesToHex(hash)];
  const displayDefinition = (def: SurveyDefinition): SurveyDefinition => {
    if (!def.contentAnchor) return def;
    const doc = docCache[bytesToHex(def.contentAnchor.hash)];
    if (doc === undefined) return def;
    try {
      return applyPresentation(def, parsePresentation(doc));
    } catch {
      return def; // a malformed cached doc never breaks the list
    }
  };

  // (wallet signal is declared above the list resource — see there.)
  const [connecting, setConnecting] = createSignal(false);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  const [activeRole, setActiveRole] = createSignal<number | null>(null);

  // Reactive mirror of `window.cardano`. Wallets inject asynchronously, so a
  // list read once at first paint can miss a slow-injecting wallet; we refresh
  // it briefly after mount (and on window focus, for wallets enabled in another
  // tab) so the connect menu lights up without a reload. Equality is by key set
  // so identical lists don't churn dependents.
  const [installed, setInstalled] = createSignal<InstalledWallet[]>(
    listInstalledWallets(),
    {
      equals: (a, b) =>
        a.map((w) => w.key).join() === b.map((w) => w.key).join(),
    },
  );
  onMount(() => {
    const refresh = (): void => {
      setInstalled(listInstalledWallets());
    };
    let ticks = 0;
    const id = setInterval(() => {
      refresh();
      if (++ticks >= 15) clearInterval(id);
    }, 200);
    window.addEventListener("focus", refresh);
    onCleanup(() => {
      clearInterval(id);
      window.removeEventListener("focus", refresh);
    });
  });

  // `silent` is the auto-reconnect path: it must never surface an error popup —
  // a failed silent reconnect just forgets the wallet and stays disconnected.
  const doConnect = async (key: string, silent: boolean): Promise<void> => {
    setConnecting(true);
    if (!silent) setConnectError(null);
    try {
      const w = await connectWallet(key);
      setWallet(w);
      setActiveRole(claimableRoles(w.identity)[0] ?? null);
      storeLastWallet(key);
    } catch (e) {
      if (silent) clearLastWallet();
      else setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const connect = (key: string): Promise<void> => doConnect(key, false);

  const disconnect = (): void => {
    setWallet(null);
    setActiveRole(null);
    setConnectError(null);
    clearLastWallet();
  };

  // Auto-reconnect the last wallet on reload — but only if the dApp is still
  // authorized for it (CIP-30 `isEnabled`), so this never triggers a
  // *connection* prompt. (A wallet gating the CIP-95 extension behind its own
  // consent may still prompt for that; refusing it degrades to a DRep-less
  // session in `connectWallet`, never a failed reconnect.)
  // Wallets inject onto `window.cardano` asynchronously, so poll briefly for the
  // remembered one before giving up (without clearing it — it may just be slow
  // or disabled this session).
  onMount(() => {
    const key = storedLastWallet();
    if (!key) return;
    void (async () => {
      for (let i = 0; i < 15; i++) {
        if (window.cardano?.[key]) {
          if (await isWalletEnabled(key)) await doConnect(key, true);
          else clearLastWallet();
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  });

  const value: AppState = {
    config,
    source,
    list,
    surveySnapshot,
    sections,
    health,
    reload: safeRefetch,
    ui,
    setFilter: (f) => setUi("filter", f),
    setSearch: (s) => setUi("search", s),
    setPro: (pro) => setUi("pro", pro),
    koiosToken,
    setKoiosToken: (token) => {
      storeKoiosToken(token);
      setKoiosTokenSig(token.trim() || undefined);
      safeRefetch();
    },
    ipfsTokens,
    setIpfsToken,
    installedWallets: installed,
    wallet,
    connecting,
    connectError,
    connect,
    disconnect,
    claimableRoles: () => {
      const w = wallet();
      return w ? claimableRoles(w.identity) : [];
    },
    activeRole,
    setActiveRole,
    cart,
    enqueue,
    removeFromCart: (action) =>
      setCart((prev) => prev.filter((a) => a !== action)),
    submitOrQueue: async (actions) => {
      const alone = cart().length === 0;
      // Queued before it is built, because a chain that stalls waiting for
      // another wallet's signature has to be recoverable from the drawer. A
      // failed build never got that far, so it puts the queue back.
      enqueue(actions);
      if (!alone) return null;
      try {
        const hashes = await startSigning(actions);
        return signing().length > 0 ? null : hashes;
      } catch (e) {
        setCart((prev) => prev.filter((a) => !actions.includes(a)));
        throw e;
      }
    },
    submitCart: async () => {
      try {
        await startSigning(cart());
      } catch (e) {
        setSignError(e instanceof Error ? e.message : String(e));
      }
    },
    planCart: async () => {
      const { payloadSize } = await import("~/wallet/submit");
      return plan(cart(), { definingTx: definingTx(), measure: payloadSize });
    },
    cartOpen,
    setCartOpen: (open) => setCartOpen(open),
    signing,
    signError,
    signWithWallet: async () => {
      await advance();
    },
    discardSigning: () => {
      setSigning([]);
      setSignError(null);
    },
    cartLocked: () => signing().length > 0,
    pendingTxs,
    dismissTx: (txHash) => updateTx(txHash, { status: "done" }),
    resubmitTx: async (txHash) => {
      const w = wallet();
      if (!w) throw new Error("No wallet connected");
      const p = pendingTxs().find((x) => x.txHash === txHash);
      if (!p) return;
      await w.api.submitTx(p.txCbor);
      updateTx(txHash, { submittedAt: Date.now(), stalled: false });
    },
    dropTx,
    optimisticSurveys,
    optimisticStuck,
    cachePresentationDoc,
    cachedPresentationDoc,
    displayDefinition,
    cacheReady,
  };

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
};

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used within <AppProvider>");
  return v;
}
