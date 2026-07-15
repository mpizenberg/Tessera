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
  envKoiosToken,
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
import { KoiosDataSource } from "@tessera/koios";
import { IndexerDataSource } from "~/data/indexer";
import {
  aggregateSurveyList,
  pageSurveyList,
  type BackendHealth,
  type DataSource,
  type SurveyListCounts,
  type SurveyListFilter,
  type SurveyListParams,
  type SurveyListPayload,
} from "@tessera/core";
import {
  aggregateSurveys,
  bytesToHex,
  type ChainTip,
  type SurveyAggregate,
  type SurveyRecord,
} from "cip-179/domain";
import { claimableRoles } from "~/domain/roles";
import {
  connectWallet,
  isWalletEnabled,
  listInstalledWallets,
} from "~/wallet/cip30";
import type { ConnectedWallet, InstalledWallet } from "~/wallet/types";
import {
  applyPresentation,
  parsePresentation,
} from "~/enrichment/presentation";
import { loadAllDocs, putDoc } from "~/enrichment/docStore";
import type { Credential, Metadatum, SurveyDefinition } from "cip-179";

/** What the eager list resource holds — the first page Explore renders from. */
export interface SurveyList {
  readonly tip: ChainTip;
  readonly surveys: readonly SurveyAggregate[];
  /** True when the source's scan may have missed records (paging cap hit). */
  readonly incomplete?: boolean;
  /** Global per-chip totals over the search-matching set. */
  readonly counts: SurveyListCounts;
  /** Continuation for the next page, or null when this page is the last. */
  readonly nextCursor: string | null;
}

/** The Explore filter chips — exactly the shared paged-list filters. */
export type ExploreFilter = SurveyListFilter;

/** Page size for the Explore list (first page and each "show more"). */
const PAGE_SIZE = 50;

export interface UiState {
  filter: ExploreFilter;
  search: string;
  /** Pro mode surfaces technical detail (refs, epochs, drand rounds). */
  pro: boolean;
}

/** What kind of submission a pending transaction carries. */
export type PendingKind = "survey" | "response" | "cancel" | "govAction";

/** A submitted transaction we're watching for block inclusion. */
export interface PendingTx {
  txHash: string;
  kind: PendingKind;
  /** Survey ref this tx concerns, for a contextual "View" link. */
  surveyKey?: string | undefined;
  /** Optional human label (e.g. the survey title) shown in the indicator. */
  title?: string | undefined;
  submittedAt: number;
  status: "pending" | "confirmed";
  /** Set once a tx has stayed unconfirmed long enough to look stuck. */
  slow: boolean;
}

/** The caller-supplied fields when starting to track a tx. */
export type NewPendingTx = Pick<
  PendingTx,
  "txHash" | "kind" | "surveyKey" | "title"
>;

/**
 * Poll the data source for inclusion at this cadence while anything is pending.
 * (The `DataSource` seam — the indexer in the default deployment, Koios direct
 * otherwise — not Koios unconditionally.)
 */
const POLL_INTERVAL_MS = 20_000;
/** Keep a confirmed tx visible briefly before clearing it. */
const CONFIRMED_LINGER_MS = 6_000;
/** After this long unconfirmed, flag a tx as slow (still polling). */
const SLOW_AFTER_MS = 150_000;

interface AppState {
  readonly config: AppConfig;
  readonly source: DataSource;
  /**
   * The first Explore page for the active filter/search (re-fetched whenever
   * either changes); later pages accumulate in {@link moreSurveys}.
   */
  readonly list: Resource<SurveyList>;
  /** Pages 2+ for the current filter/search, appended by {@link loadMore}. */
  readonly moreSurveys: Accessor<readonly SurveyAggregate[]>;
  /** The live continuation cursor, advanced by loads; null = all loaded. */
  readonly nextCursor: Accessor<string | null>;
  readonly loadingMore: Accessor<boolean>;
  /** Fetch the next page and append it (no-op while loading or exhausted). */
  loadMore(): void;
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
  /**
   * Build, sign, and submit a transaction carrying a label-17 payload using the
   * connected wallet; resolves to the transaction hash. Throws if no wallet.
   *
   * `proveCredentials` are added to `required_signers` for CIP-179 credential
   * proof (e.g. the responder credential for a response).
   */
  submitMetadata(
    payload: Metadatum,
    proveCredentials?: readonly Credential[],
  ): Promise<string>;
  /**
   * Build, sign, and submit a Conway governance **Info Action** proposal whose
   * anchor is the off-chain document at `anchorUrl` with blake2b-256
   * `anchorDataHash`. Resolves to the transaction hash. Throws if no wallet.
   * Used to advertise a CIP-179 survey from on-chain governance.
   */
  submitInfoAction(
    anchorUrl: string,
    anchorDataHash: Uint8Array,
  ): Promise<string>;

  // --- pending transactions (optimistic confirmation) ---
  /** Transactions submitted this session, awaiting (or just past) inclusion. */
  readonly pendingTxs: readonly PendingTx[];
  /** Start watching a just-submitted tx for block inclusion. */
  trackTx(tx: NewPendingTx): void;
  /** Stop showing a tracked tx (e.g. user dismisses it). */
  dismissTx(txHash: string): void;
  /**
   * Surveys shown immediately on creation, before the indexer catches up. The
   * wallet already accepted the tx, so the freshly-built definition is what
   * will be on-chain; entries are pruned once the real record indexes.
   */
  readonly optimisticSurveys: Accessor<readonly SurveyAggregate[]>;
  /** Add a just-published survey to the optimistic set (built from its record). */
  addOptimisticSurvey(record: SurveyRecord): void;
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
  // without rebuilding the source (which reads it through this getter). Still
  // used even in indexer mode — building a transaction reads protocol parameters
  // from Koios (the tx itself is signed and submitted via the CIP-30 wallet).
  const [koiosToken, setKoiosTokenSig] = createSignal(config.koiosToken);
  // Reads flow through the Tier-1 serving backend when one is configured
  // (`VITE_INDEXER_URL`) — the secure/scalable default — otherwise straight to
  // Koios (the direct/power-user/offline path). See `backend/ARCHITECTURE.md` §8.
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

  // One page through the seam: server-side when the source implements the
  // paged contract (the indexer), otherwise page the full one-shot payload in
  // memory with the same core semantics (direct-Koios mode). The full payload
  // is cached across filter/search/page changes — one Koios scan per reload,
  // not one per chip click.
  let fullListCache: Promise<SurveyListPayload> | null = null;
  const fetchPage = (params: SurveyListParams): Promise<SurveyListPayload> => {
    if (source.surveyListPage) return source.surveyListPage(params);
    fullListCache ??= source.surveyList();
    // A failed scan must not be cached as "the list" forever.
    fullListCache.catch(() => {
      fullListCache = null;
    });
    return fullListCache.then((full) => pageSurveyList(full, params));
  };

  const pageParams = createMemo(
    (): Omit<SurveyListParams, "cursor" | "limit"> => ({
      filter: ui.filter,
      search: ui.search,
      credentials: walletCredentialKeys(),
    }),
  );

  const [list, { refetch }] = createResource<SurveyList, string>(
    () => JSON.stringify(pageParams()),
    async () => {
      // One bounded read regardless of participation volume: responses arrive
      // pre-deduped as per-survey counts, governance-link failures are
      // absorbed source-side, and pagination bounds the survey rows too.
      const payload = await fetchPage({ ...pageParams(), limit: PAGE_SIZE });
      return {
        tip: payload.tip,
        surveys: aggregateSurveyList(payload),
        counts: payload.counts ?? {
          all: 0,
          linked: 0,
          active: 0,
          sealed: 0,
          public: 0,
          mine: 0,
        },
        nextCursor: payload.nextCursor ?? null,
        ...(payload.incomplete !== undefined && {
          incomplete: payload.incomplete,
        }),
      };
    },
  );

  // Pages 2+ accumulate here and reset whenever the first page changes (a
  // filter/search change or a reload re-keys the resource above).
  const [moreSurveys, setMoreSurveys] = createSignal<
    readonly SurveyAggregate[]
  >([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  createEffect(() => {
    const l = list.error ? undefined : list();
    setMoreSurveys([]);
    setNextCursor(l?.nextCursor ?? null);
  });
  const loadMore = (): void => {
    const cursor = nextCursor();
    if (!cursor || loadingMore()) return;
    const key = JSON.stringify(pageParams());
    setLoadingMore(true);
    void (async () => {
      try {
        const payload = await fetchPage({
          ...pageParams(),
          limit: PAGE_SIZE,
          cursor,
        });
        // Params changed mid-flight: the reset effect owns the state now.
        if (JSON.stringify(pageParams()) !== key) return;
        setMoreSurveys((prev) => [...prev, ...aggregateSurveyList(payload)]);
        setNextCursor(payload.nextCursor ?? null);
      } catch (err) {
        // Keep the cursor so the button retries; the first page still shows.
        console.warn(`load more failed: ${String(err)}`);
      } finally {
        setLoadingMore(false);
      }
    })();
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
    void Promise.resolve(refetchHealth()).catch(() => {});
  };

  const [ipfsTokens, setIpfsTokensStore] =
    createStore<ProviderTokens>(loadProviderTokens());
  const setIpfsToken = (id: ProviderId, token: string): void => {
    storeProviderToken(id, token);
    const trimmed = token.trim();
    setIpfsTokensStore(id, trimmed || undefined);
  };

  // Pending-tx tracking. A CIP-30-accepted tx will land (no input conflict), so
  // we poll the data source only to flip the indicator pending → confirmed —
  // never to refetch the snapshot (the optimistic copy we already show is
  // on-chain).
  const [pendingTxs, setPendingTxs] = createStore<PendingTx[]>([]);
  const [optimisticSurveys, setOptimisticSurveys] = createSignal<
    readonly SurveyAggregate[]
  >([]);
  // Records published before the list (and its tip) has loaded — aggregation
  // needs the tip, so hold them here and drain once it resolves (finding 14).
  const [pendingOptimistic, setPendingOptimistic] = createSignal<
    readonly SurveyRecord[]
  >([]);

  const trackTx = (tx: NewPendingTx): void =>
    setPendingTxs((prev) => [
      { ...tx, submittedAt: Date.now(), status: "pending", slow: false },
      ...prev.filter((p) => p.txHash !== tx.txHash),
    ]);
  const dismissTx = (txHash: string): void =>
    setPendingTxs((prev) => prev.filter((p) => p.txHash !== txHash));

  const pollPending = async (): Promise<void> => {
    const open = pendingTxs.filter((p) => p.status === "pending");
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
        setPendingTxs((x) => x.txHash === p.txHash, "status", "confirmed");
        setTimeout(() => dismissTx(p.txHash), CONFIRMED_LINGER_MS);
      } else if (!p.slow && now - p.submittedAt > SLOW_AFTER_MS) {
        setPendingTxs((x) => x.txHash === p.txHash, "slow", true);
      }
    }
  };

  // A single poller, alive only while something is pending. The effect re-runs
  // when the list changes (a confirm/dismiss), resetting the interval — fine.
  createEffect(() => {
    if (!pendingTxs.some((p) => p.status === "pending")) return;
    void pollPending();
    const id = setInterval(() => void pollPending(), POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(id));
  });

  const recordKey = (r: SurveyRecord): string =>
    `${bytesToHex(r.ref.txId)}:${r.ref.index}`;

  const aggregateOptimistic = (record: SurveyRecord, tip: ChainTip): void => {
    const [agg] = aggregateSurveys(
      { surveys: [record], responses: [], cancellations: [] },
      tip,
    );
    if (!agg) return;
    setOptimisticSurveys((prev) => [
      agg,
      ...prev.filter((p) => p.key !== agg.key),
    ]);
  };

  const addOptimisticSurvey = (record: SurveyRecord): void => {
    const tip = list()?.tip;
    if (!tip) {
      // No tip yet — queue so the success receipt's "View survey" link and
      // Explore don't miss the just-published survey until the next refresh.
      setPendingOptimistic((prev) => [
        record,
        ...prev.filter((r) => recordKey(r) !== recordKey(record)),
      ]);
      return;
    }
    aggregateOptimistic(record, tip);
  };

  // Drain queued optimistic records once the list (and its tip) resolves.
  createEffect(() => {
    const tip = list()?.tip;
    if (!tip || pendingOptimistic().length === 0) return;
    const queued = pendingOptimistic();
    setPendingOptimistic([]);
    for (const record of queued) aggregateOptimistic(record, tip);
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

  // Once the real indexed survey appears in the list, drop its optimistic twin.
  createEffect(() => {
    const surveys = list()?.surveys;
    if (!surveys) return;
    const realKeys = new Set(surveys.map((s) => s.key));
    setOptimisticSurveys((prev) => prev.filter((a) => !realKeys.has(a.key)));
  });

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
  // authorized for it (CIP-30 `isEnabled`), so this never triggers a prompt.
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
    moreSurveys,
    nextCursor,
    loadingMore,
    loadMore,
    health,
    reload: safeRefetch,
    ui,
    setFilter: (f) => setUi("filter", f),
    setSearch: (s) => setUi("search", s),
    setPro: (pro) => setUi("pro", pro),
    koiosToken,
    setKoiosToken: (token) => {
      storeKoiosToken(token);
      setKoiosTokenSig(token.trim() || envKoiosToken());
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
    submitMetadata: async (payload, proveCredentials = []) => {
      const w = wallet();
      if (!w) throw new Error("No wallet connected");
      // Lazy-load the evolution-sdk transaction builder so its weight is fetched
      // only when a user actually submits, not on first paint.
      const { submitMetadataTx } = await import("~/wallet/submit");
      return submitMetadataTx(
        { ...config, koiosToken: koiosToken(), indexerUrl },
        w.api,
        payload,
        proveCredentials,
      );
    },
    submitInfoAction: async (anchorUrl, anchorDataHash) => {
      const w = wallet();
      if (!w) throw new Error("No wallet connected");
      const { submitInfoActionProposal } = await import("~/wallet/submit");
      return submitInfoActionProposal(
        { ...config, koiosToken: koiosToken(), indexerUrl },
        w.api,
        anchorUrl,
        anchorDataHash,
      );
    },
    pendingTxs,
    trackTx,
    dismissTx,
    optimisticSurveys,
    addOptimisticSurvey,
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
