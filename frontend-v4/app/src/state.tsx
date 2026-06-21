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
  useContext,
  type ParentComponent,
  type Resource,
} from "solid-js";
import { createStore } from "solid-js/store";

import { loadConfig } from "~/config";
import { KoiosDataSource } from "~/data/koios";
import type { ChainTip, Cip179Records, DataSource } from "~/data/source";
import { aggregateSurveys, type SurveyAggregate } from "~/domain/survey";

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
  readonly source: DataSource;
  readonly snapshot: Resource<Snapshot>;
  reload(): void;
  readonly ui: UiState;
  setFilter(f: ExploreFilter): void;
  setSearch(s: string): void;
  setPro(pro: boolean): void;
}

const Ctx = createContext<AppState>();

export const AppProvider: ParentComponent = (props) => {
  const source: DataSource = new KoiosDataSource(loadConfig());

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

  const value: AppState = {
    source,
    snapshot,
    reload: () => void refetch(),
    ui,
    setFilter: (f) => setUi("filter", f),
    setSearch: (s) => setUi("search", s),
    setPro: (pro) => setUi("pro", pro),
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
