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
  useContext,
  type Accessor,
  type ParentComponent,
  type Resource,
} from "solid-js";
import { createStore } from "solid-js/store";

import { loadConfig, type AppConfig } from "~/config";
import { KoiosDataSource } from "~/data/koios";
import type { ChainTip, Cip179Records, DataSource } from "~/data/source";
import { aggregateSurveys, type SurveyAggregate } from "~/domain/survey";
import { claimableRoles } from "~/domain/roles";
import { connectWallet, listInstalledWallets } from "~/wallet/cip30";
import type { ConnectedWallet, InstalledWallet } from "~/wallet/types";

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
}

const Ctx = createContext<AppState>();

export const AppProvider: ParentComponent = (props) => {
  const config = loadConfig();
  const source: DataSource = new KoiosDataSource(config);

  const [snapshot, { refetch }] = createResource<Snapshot>(async () => {
    const [records, tip] = await Promise.all([
      source.fetchAll(),
      source.chainTip(),
    ]);
    return { records, tip, surveys: aggregateSurveys(records, tip) };
  });

  const [ui, setUi] = createStore<UiState>({
    filter: "all",
    search: "",
    pro: false,
  });

  const [wallet, setWallet] = createSignal<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = createSignal(false);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  const [activeRole, setActiveRole] = createSignal<number | null>(null);

  const connect = async (key: string): Promise<void> => {
    setConnecting(true);
    setConnectError(null);
    try {
      const w = await connectWallet(key);
      setWallet(w);
      setActiveRole(claimableRoles(w.identity)[0] ?? null);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = (): void => {
    setWallet(null);
    setActiveRole(null);
    setConnectError(null);
  };

  const value: AppState = {
    config,
    source,
    snapshot,
    reload: () => void refetch(),
    ui,
    setFilter: (f) => setUi("filter", f),
    setSearch: (s) => setUi("search", s),
    setPro: (pro) => setUi("pro", pro),
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
