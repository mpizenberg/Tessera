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
  ProofVerdicts,
  SurveyBundle,
  SurveyRecord,
} from "cip-179/domain";

import type { TallyArtifact } from "cip-179/tally";

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
   * paged route), absent on a full unpaged payload and on one that answers a
   * caller-named set of references (no filtered set to total).
   */
  readonly counts?: import("./page").SurveyListCounts;
  /**
   * Continuation for the next page (opaque keyset cursor), `null` when this
   * page is the last. Absent on a full unpaged payload, and on one answering a
   * caller-named set of references (no order to continue).
   */
  readonly nextCursor?: string | null;
  /**
   * Unix seconds the snapshot behind this payload was scanned — the paging
   * generation minted into `nextCursor`. Serving tier only.
   */
  readonly fetchedAt?: number;
  /**
   * The request's cursor was minted against an older snapshot generation, so
   * rows may have crossed the cursor boundary (duplicated or skipped). The
   * page itself is still a best-effort answer; the client should silently
   * refresh page one.
   */
  readonly resync?: boolean;
}

/**
 * A survey's bundle plus the serving tier's per-response credential-proof
 * verdicts. The verdicts stay OFF {@link SurveyBundle} itself: that type is
 * the chain-data contract the verifier re-derives and the direct Koios source
 * also produces, and the serving tier's opinion must never read as chain data
 * (same trust posture as {@link SurveyListPayload.finalizedCancelled}). When
 * present the map is complete over *decided* verdicts — a response key it
 * lacks is pending, not failed. Absent entirely when the source has no proof
 * machinery (the direct Koios path).
 */
export interface SurveyBundlePayload extends SurveyBundle {
  readonly verdicts?: ProofVerdicts;
  /**
   * The governance actions linked to this survey — the same relation
   * {@link SurveyListPayload.govLinks} carries for a page of surveys, so a
   * reader holding one survey by reference needs no list read to show it.
   * Outside the chain data for the same reason as {@link verdicts}: the link is
   * the serving tier's resolution of an anchor document, not a record on chain.
   * Present (possibly empty) from the serving tier, absent from a source with
   * no anchor machinery — and an empty array means "none as of the last
   * successful link pass", never "unknown".
   */
  readonly govLinks?: readonly GovLink[];
}

/**
 * Operational health of a serving-tier backend (`GET /api/health`) — what the
 * app's thin health footer renders. Wire-plain by design (no bytes/bigints),
 * so it round-trips as ordinary JSON. Only the indexer path produces it; the
 * direct-Koios path has no refresh loop to report on.
 */
export interface BackendHealth {
  readonly network: string;
  /** Git commit of the deployed code, or null when the deploy didn't stamp one. */
  readonly commit: string | null;
  /** Freshness of the served snapshot, or null before the first refresh. */
  readonly snapshot: {
    /** Unix seconds when the scan behind the snapshot started reading. */
    readonly fetchedAt: number;
    readonly ageSeconds: number;
  } | null;
  /** The most recent refresh run's stats, or null before the first run. */
  readonly lastRefresh: {
    readonly startedAt: number;
    readonly durationMs: number;
    /**
     * Every upstream request the run issued, whatever the host — what the
     * platform's per-invocation cap in {@link BackendHealth.quotas} bounds.
     */
    readonly upstreamRequests: number;
    /** The Koios share of {@link upstreamRequests}; the rest is anchor fetches. */
    readonly koiosCalls: number;
    readonly ok: boolean;
    /** Failure message when `ok` is false, else null. */
    readonly error: string | null;
    /**
     * No governance-links failure was observed in this run. False means the
     * served snapshot carries the previous run's links rather than freshly read
     * ones — the run is otherwise `ok`, since links are best-effort enrichment.
     */
    readonly govLinksOk: boolean;
    /**
     * The run integrated a prefix, not the whole: a record its listing promised
     * never arrived, or the walker has not reached the tip yet. Nothing
     * finalizes on such a run.
     */
    readonly incomplete: boolean;
    /** Surveys and responses this run integrated — its segment, not the corpus. */
    readonly surveys: number;
    readonly responses: number;
    /** Wire JSON across the rows this run wrote — the growth metric. */
    readonly payloadBytes: number;
  } | null;
  /**
   * How far the segment walker has integrated the chain, or null before it has
   * ever run. `caughtUp` is the answer to "is the stored corpus the whole
   * story?"; while it is false, `cursorSlot` moving between refreshes is a walk
   * making progress, and `cursorSlot` standing still is one that is stuck.
   */
  readonly scan: {
    /** Last slot whose segment is fully integrated; null = nothing walked yet. */
    readonly cursorSlot: number | null;
    /** The last walk reached the tip, so the next one only re-derives the margin. */
    readonly caughtUp: boolean;
  } | null;
  /**
   * Rolling totals over the last 24 hours — the window every upstream service
   * meters us in, whether or not we know the number it compares against.
   * Request counts cover the serving path too, not just refresh runs.
   */
  readonly last24h: {
    readonly runs: number;
    readonly failures: number;
    /** Every upstream request, all services: refresh and serving alike. */
    readonly upstreamRequests: number;
    /** The operator's Koios identity — the one `koiosCallsPerDay` bounds. */
    readonly koiosCalls: number;
    /**
     * The segregated Koios identity behind `/api/tx_status`. A separate account
     * bucket, so it is reported apart rather than summed into `koiosCalls`;
     * unauthenticated by default, where the applicable limit is per-IP and not
     * something the operator configures.
     */
    readonly passthroughCalls: number;
  };
  /** Validated responses still awaiting an enrichment retry. */
  readonly validationBacklog: number;
  /**
   * The external quotas the counts above are compared against, as the operator
   * declared them. Neither is enforced by the backend — the platform and the
   * service enforce their own — so each is a readout denominator, null when
   * the operator did not state it (or it does not apply: a self-hosted process
   * has no subrequest cap). What the backend does bound itself by is fixed
   * per-pass work ceilings that postpone rather than fail, so a busy run never
   * needs a number here to read as healthy.
   */
  readonly quotas: {
    /**
     * Outbound requests one platform invocation may make — the Cloudflare
     * Worker's subrequest cap — the number `lastRefresh.upstreamRequests`
     * counts against.
     */
    readonly subrequestsPerInvocation: number | null;
    /** Daily Koios quota of the operator's identity. */
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
   * The self-contained per-survey slice (detail/respond pages, verifiers),
   * with proof verdicts when the source computes them
   * ({@link SurveyBundlePayload}). Rejects when the ref matches no known
   * survey.
   */
  surveyBundle(ref: SurveyRef): Promise<SurveyBundlePayload>;
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
   * The survey's final tally artifact ({@link import("cip-179/tally").TallyArtifact}),
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
