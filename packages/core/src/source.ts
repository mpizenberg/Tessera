/**
 * The data-source seam.
 *
 * Everything the UI needs to *read* CIP-179 state flows through `DataSource`.
 * The first implementation talks to Koios directly (`koios.ts`); a future
 * semantic indexer backend can implement the same interface and drop in with
 * no change to the domain or UI layers.
 *
 * This seam is deliberately Tessera-specific: it has one method per
 * page-shaped read, so a serving-tier implementation maps each onto one bounded
 * HTTP route. The raw on-chain **record shapes** it returns — and the pure
 * aggregation over them — live in the reusable `cip-179/domain` package; only
 * the fetching contract and the Tessera list/health payloads live here.
 */

import type { SurveyRef } from "cip-179";
import type {
  CancellationRecord,
  ChainTip,
  GovLink,
  SurveyBundle,
  SurveyRecord,
} from "cip-179/domain";

import type { TallyArtifact } from "./artifact";

/**
 * Everything the survey *list* page (Explore) renders from — one bounded
 * payload regardless of participation volume. Responses are the only unbounded
 * record set, and the list only needs their per-survey count, so they're
 * pre-deduped (the core `dedupeResponses` rule) into `responseCounts` at the
 * source. Cancellations ride raw (they're tiny) so owner-proof verification
 * stays client-side.
 */
export interface SurveyListPayload {
  readonly surveys: readonly SurveyRecord[];
  readonly cancellations: readonly CancellationRecord[];
  readonly govLinks: readonly GovLink[];
  readonly tip: ChainTip;
  /** Distinct responders per survey key ("<txHex>:<index>"), latest-valid-wins. */
  readonly responseCounts: Record<string, number>;
  /**
   * Survey keys the serving tier finalized as **cancelled** (their tally
   * artifact records an owner-proven, in-window cancellation and no per-role
   * tally). Client-side proof verification can't reach this state: the scan
   * keeps `proof: null` for cancellations of closed surveys, so without this
   * overlay a cancelled-then-closed survey would display as plain "Ended".
   * Trusting it adds nothing new — the same server already supplies the whole
   * record set, and the claim stays auditable against the served artifact.
   * Absent in direct-Koios mode (no artifacts exist there).
   */
  readonly finalizedCancelled?: readonly string[];
  /** Mirrors {@link import("cip-179/domain").Cip179Records.incomplete} for the scan behind this list. */
  readonly incomplete?: boolean;
  /**
   * Global per-filter totals over the search-matching set — present on paged
   * responses ({@link import("./page").pageSurveyList} / the serving tier's
   * paged route), absent on a full unpaged payload.
   */
  readonly counts?: import("./page").SurveyListCounts;
  /**
   * Continuation for the next page (opaque keyset cursor), `null` when this
   * page is the last. Absent on a full unpaged payload.
   */
  readonly nextCursor?: string | null;
}

/**
 * Operational health of a serving-tier backend (`GET /api/health`) — what the
 * app's thin health footer renders. Wire-plain by design (no bytes/bigints),
 * so it round-trips as ordinary JSON. Only the indexer path produces it; the
 * direct-Koios path has no refresh loop to report on.
 */
export interface BackendHealth {
  readonly network: string;
  /** Freshness of the served snapshot, or null before the first refresh. */
  readonly snapshot: {
    readonly fetchedAt: number;
    readonly ageSeconds: number;
  } | null;
  /** The most recent refresh run's stats, or null before the first run. */
  readonly lastRefresh: {
    readonly startedAt: number;
    readonly durationMs: number;
    /** Koios HTTP requests the run issued (scan + validation + finalization). */
    readonly koiosCalls: number;
    readonly ok: boolean;
    /** Failure message when `ok` is false, else null. */
    readonly error: string | null;
    /** The scan hit its paging cap — the snapshot is a prefix, not the whole. */
    readonly incomplete: boolean;
    readonly surveys: number;
    readonly responses: number;
    /** Serialized snapshot size — the single-blob storage row's growth metric. */
    readonly payloadBytes: number;
  } | null;
  /** Rolling totals over the last 24 hours of refresh runs. */
  readonly last24h: {
    readonly runs: number;
    readonly failures: number;
    readonly koiosCalls: number;
  };
  /** Validated responses still awaiting an enrichment retry. */
  readonly validationBacklog: number;
  /** Configured budgets the counts above are compared against. */
  readonly limits: {
    /** Per-refresh Koios call budget (Worker subrequest cap by default). */
    readonly koiosCallsPerRefresh: number;
    /** Daily Koios quota when the operator configured one, else null. */
    readonly koiosCallsPerDay: number | null;
  };
}

/**
 * The seam the UI reads through — one method per page-shaped read, so a
 * serving-tier implementation maps each onto one bounded HTTP route. Full-scan
 * reads (`fetchAll`, `chainTip`, `fetchGovernanceLinks`) are deliberately NOT
 * part of the seam: they live on `KoiosDataSource` concretely, where the
 * serving tier's refresh (and the Koios implementation of the methods below)
 * still need them.
 */
export interface DataSource {
  /**
   * The Explore-list payload: every survey with per-survey response counts,
   * plus tip / governance links / raw cancellations. See {@link SurveyListPayload}.
   */
  surveyList(): Promise<SurveyListPayload>;
  /**
   * One page of the Explore list ({@link import("./page").SurveyListParams}):
   * filtered, searched, and keyset-paginated server-side, with global chip
   * counts and a `nextCursor` continuation. Optional: the serving-tier
   * implementation answers from its materialized survey index; the direct
   * Koios path leaves it undefined and the app pages the full `surveyList()`
   * payload in memory with {@link import("./page").pageSurveyList} instead.
   */
  surveyListPage?(
    params: import("./page").SurveyListParams,
  ): Promise<SurveyListPayload>;
  /**
   * The self-contained per-survey slice (detail/respond pages, verifiers).
   * Rejects when the ref matches no known survey.
   */
  surveyBundle(ref: SurveyRef): Promise<SurveyBundle>;
  /**
   * Survey keys ("<txHex>:<index>") having at least one response from any of
   * the given credentials, each in the `credentialKey` form
   * ("key:<hex>" | "script:<hex>"). Raw responses, no dedupe/validity filter —
   * this feeds Explore's "surveys I answered" flags, where any attempt counts.
   * Empty input resolves to [] without a fetch.
   */
  respondedKeys(credentialKeys: readonly string[]): Promise<string[]>;
  /**
   * Block-inclusion status for a set of just-submitted transactions, keyed by
   * tx hash. The value is the number of confirmations, or `null` when the tx is
   * not yet in a block (the chain indexer can't see the mempool). Used only to
   * flip a "pending" indicator to "confirmed" — never to drive the survey list.
   */
  txStatus(txHashes: readonly string[]): Promise<Map<string, number | null>>;
  /**
   * The survey's final tally artifact ({@link import("./artifact").TallyArtifact}),
   * or `null` when none exists (survey still open, not yet finalized, or the
   * source can't produce artifacts — the direct Koios path never does; the UI
   * then falls back to the raw client-side tally).
   */
  artifact(ref: SurveyRef): Promise<TallyArtifact | null>;
  /**
   * Operational health of the backing service ({@link BackendHealth}), for the
   * app's health footer. Optional: only the serving-tier implementation has a
   * refresh loop to report on — the direct Koios path leaves it undefined and
   * the footer simply doesn't render.
   */
  health?(): Promise<BackendHealth>;
}
