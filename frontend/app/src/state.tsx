/**
 * App-wide state, provided once at the root.
 *
 * - `source`     the active DataSource (Koios today, indexer later) — the seam.
 * - `snapshot`   a Solid resource holding the decoded records + chain tip +
 *                derived survey aggregates. Loading/error states come for free.
 * - `ui`         small client-only UI state (explore filter + search) in a store.
 *
 * Domain data lives only in the resource; the store never duplicates it.
 */

import {
  createContext,
  createResource,
  createSignal,
  onMount,
  useContext,
  type Accessor,
  type ParentComponent,
  type Resource,
} from "solid-js";
import { createStore } from "solid-js/store";

import {
  loadConfig,
  storeKoiosToken,
  envKoiosToken,
  storeNetwork,
  storedLastWallet,
  storeLastWallet,
  clearLastWallet,
  type AppConfig,
  type Network,
} from "~/config";
import {
  loadProviderTokens,
  storeProviderToken,
  type ProviderId,
  type ProviderTokens,
} from "~/enrichment/providers";
import { KoiosDataSource } from "~/data/koios";
import type { ChainTip, Cip179Records, DataSource } from "~/data/source";
import {
  aggregateSurveys,
  governanceSinceUnix,
  type SurveyAggregate,
} from "~/domain/survey";
import { claimableRoles } from "~/domain/roles";
import {
  connectWallet,
  isWalletEnabled,
  listInstalledWallets,
} from "~/wallet/cip30";
import type { ConnectedWallet, InstalledWallet } from "~/wallet/types";
import type { Credential, Metadatum } from "cip-179";

export interface Snapshot {
  readonly records: Cip179Records;
  readonly tip: ChainTip;
  readonly surveys: readonly SurveyAggregate[];
}

export type ExploreFilter =
  | "all"
  | "linked"
  | "active"
  | "sealed"
  | "public"
  | "mine";

export interface UiState {
  filter: ExploreFilter;
  search: string;
  /** Pro mode surfaces technical detail (refs, epochs, drand rounds). */
  pro: boolean;
}

interface AppState {
  readonly config: AppConfig;
  readonly source: DataSource;
  readonly snapshot: Resource<Snapshot>;
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
  /**
   * Switch the active network. Persists the choice and navigates to Explore with
   * a full page load: the endpoint, epoch math, and any connected wallet all
   * hinge on network, so a clean reload is simpler and safer than hot-swapping
   * them — and we land on Explore because survey-specific pages don't exist on
   * the other network. No-op if unchanged.
   */
  setNetwork(network: Network): void;
  /** IPFS pinning-provider API tokens (reactive store), for in-app uploads. */
  readonly ipfsTokens: ProviderTokens;
  /** Persist (or clear, when empty) a provider's token. */
  setIpfsToken(id: ProviderId, token: string): void;

  // --- wallet / identity ---
  /** Wallets advertised on window.cardano (read fresh each call). */
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
}

const Ctx = createContext<AppState>();

export const AppProvider: ParentComponent = (props) => {
  const config = loadConfig();

  // Koios token: reactive so a Settings override applies on the next reload
  // without rebuilding the source (which reads it through this getter).
  const [koiosToken, setKoiosTokenSig] = createSignal(config.koiosToken);
  const source: DataSource = new KoiosDataSource(config, () => koiosToken());

  const [snapshot, { refetch }] = createResource<Snapshot>(async () => {
    const [records, tip] = await Promise.all([
      source.fetchAll(),
      source.chainTip(),
    ]);
    // Bound the governance scan to actions recent enough to link a live survey
    // (oldest active survey's creation time). Best-effort enrichment: never let
    // a governance-endpoint failure (or CORS) sink the main snapshot.
    const since = governanceSinceUnix(records, tip, config.sinceUnix);
    const govLinks = await source.fetchGovernanceLinks(since).catch((e) => {
      console.warn(`governance linkage unavailable: ${String(e)}`);
      return [];
    });
    return { records, tip, surveys: aggregateSurveys(records, tip, govLinks) };
  });

  const [ui, setUi] = createStore<UiState>({
    filter: "all",
    search: "",
    pro: false,
  });

  const [ipfsTokens, setIpfsTokensStore] =
    createStore<ProviderTokens>(loadProviderTokens());
  const setIpfsToken = (id: ProviderId, token: string): void => {
    storeProviderToken(id, token);
    const trimmed = token.trim();
    setIpfsTokensStore(id, trimmed || undefined);
  };

  const [wallet, setWallet] = createSignal<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = createSignal(false);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  const [activeRole, setActiveRole] = createSignal<number | null>(null);

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
    snapshot,
    reload: () => void refetch(),
    ui,
    setFilter: (f) => setUi("filter", f),
    setSearch: (s) => setUi("search", s),
    setPro: (pro) => setUi("pro", pro),
    koiosToken,
    setKoiosToken: (token) => {
      storeKoiosToken(token);
      setKoiosTokenSig(token.trim() || envKoiosToken());
      refetch();
    },
    setNetwork: (network) => {
      if (network === config.network) return;
      storeNetwork(network);
      // Full load onto Explore — survey pages are network-specific, so reloading
      // the current URL could land on a survey that doesn't exist here.
      location.assign("/");
    },
    ipfsTokens,
    setIpfsToken,
    installedWallets: listInstalledWallets,
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
      return submitMetadataTx(config, w.api, payload, proveCredentials);
    },
  };

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
};

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used within <AppProvider>");
  return v;
}

/** Records helper unused at the type level — re-exported for screens. */
export type { Cip179Records };
