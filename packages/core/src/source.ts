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
 * The version of the HTTP contract these payload types describe, as
 * `major.minor`, reported by the serving tier on `GET /health` and
 * `GET /api/health`. A minor adds (a field, a selection, a route); a major
 * replaces (a field renamed, removed or re-typed, a selection's semantics
 * changed), and the backend then serves the new shape only. A consumer
 * compares majors with {@link apiMajor} and refuses a mismatch; it may warn
 * on a minor it does not know. Every change is a line in
 * `backend/server/CHANGELOG.md`.
 */
export const API_VERSION = "1.0";

/** The major of a `major.minor` contract version — the part a consumer must match. */
export const apiMajor = (version: string): string =>
  version.split(".")[0] ?? version;

/** `GET /health`: liveness, the served network, and the contract version. */
export interface BackendLiveness {
  readonly ok: true;
  readonly network: string;
  readonly apiVersion: string;
}

/**
 * One survey's final decision as the serving tier reports it. `finalized` and
 * `cancelled` carry the emitted artifact's content hash; `untalliable` means
 * the finalizer decided — permanently — that no artifact will ever exist
 * (spec-invalid definition, unproven owner credential, or a sealed survey on
 * an undecryptable drand chain). A survey with no entry is simply not decided
 * yet.
 */
export type SurveyFinalState =
  | { readonly state: "finalized" | "cancelled"; readonly artifactHash: string }
  | { readonly state: "untalliable" };

/**
 * Everything the survey *list* page (Explore) renders from — one bounded
 * payload regardless of participation volume. Responses are the only unbounded
 * record set, and the list only needs their per-survey count, so they're
 * pre-deduped (the core `dedupeResponses` rule) into `responseCounts` at the
 * source. Cancellations ride raw (they're tiny) so owner-proof verification
 * stays client-side.
 */
export interface SurveyListPayload extends SnapshotStamp {
  readonly surveys: readonly SurveyRecord[];
  readonly cancellations: readonly CancellationRecord[];
  readonly govLinks: readonly GovLink[];
  readonly tip: ChainTip;
  /** Distinct responders per survey key ("<txHex>:<index>"), latest-valid-wins. */
  readonly responseCounts: Record<string, number>;
  /**
   * The *audited* count per survey key and CIP-179 role (the role integer as
   * an object key): `auditResponses`' counted set — in-window, valid against
   * the definition, latest-valid-wins, refuted proofs dropped, pending
   * verdicts counted — grouped by the responder's role. Every survey in the
   * payload has an entry, empty when nothing counts, so a missing key means
   * the source does not compute it rather than "none".
   *
   * Provisional, and lower than {@link responseCounts} by construction: a
   * pending verdict counts (not-yet-checked must never read as failed), and a
   * survey's artifact additionally applies end-epoch role membership, so the
   * final per-role set can only be smaller. Absent in direct-Koios mode, which
   * has no proof verdicts to audit against.
   */
  readonly countedByRole?: Readonly<Record<string, Record<string, number>>>;
  /**
   * The serving tier's final decision per survey key, present only for decided
   * surveys. Client-side verification can't reach these states on its own: the
   * scan keeps `proof: null` for cancellations of closed surveys (so a
   * cancelled-then-closed survey would display as plain "Ended"), and the
   * unproven-owner half of untalliability needs evidence only the finalizer
   * fetches. Trusting it adds nothing new — the same server already supplies
   * the whole record set, and a state carrying an artifact hash stays
   * auditable against the served artifact. Absent in direct-Koios mode (no
   * finalization exists there).
   */
  readonly finalState?: Readonly<Record<string, SurveyFinalState>>;
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
   * The request's cursor was minted against an older snapshot generation, so
   * rows may have crossed the cursor boundary (duplicated or skipped). The
   * page itself is still a best-effort answer; the client should silently
   * refresh page one.
   */
  readonly resync?: boolean;
}

/**
 * The freshness stamp the serving tier appends to a snapshot-derived body.
 * Absent in direct-Koios mode, which has no snapshot.
 */
export interface SnapshotStamp {
  /**
   * Unix seconds the scan behind this body started reading — the instant its
   * `tip` was taken, and the paging generation minted into a `nextCursor`.
   */
  readonly fetchedAt?: number;
  /**
   * Seconds between {@link fetchedAt} and the moment the body was answered.
   * Drifts within a refresh window and is not part of the ETag; a reader
   * wanting live staleness derives it from `fetchedAt` instead.
   */
  readonly ageSeconds?: number;
}

/**
 * A survey's bundle plus the serving tier's per-response credential-proof
 * verdicts. The verdicts stay OFF {@link SurveyBundle} itself: that type is
 * the chain-data contract the verifier re-derives and the direct Koios source
 * also produces, and the serving tier's opinion must never read as chain data
 * (same trust posture as {@link SurveyListPayload.finalState}). When
 * present the map is complete over *decided* verdicts — a response key it
 * lacks is pending, not failed. Absent entirely when the source has no proof
 * machinery (the direct Koios path).
 */
export interface SurveyBundlePayload extends SurveyBundle, SnapshotStamp {
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
  /**
   * Continuation for the next page of {@link SurveyBundle.responses} (opaque
   * keyset cursor), `null` when this page is the last. Absent from a source
   * that does not page its responses. Everything else in the payload — survey,
   * cancellations, links, tip — describes the whole survey on every page;
   * `responses` and `verdicts` are the paged sections.
   */
  readonly nextCursor?: string | null;
  /**
   * The cursor this page answered was minted against an older snapshot, so the
   * response set may have moved across its boundary. Unlike the list's
   * {@link SurveyListPayload.resync} this is not cosmetic — a bundle is a tally
   * input — so a collector must restart rather than append
   * ({@link import("./page").collectSurveyBundle}).
   */
  readonly resync?: boolean;
}

/**
 * `GET /api/responded?credentials=`: the survey keys ("<txHex>:<index>") with
 * at least one response from any of the named credentials.
 */
export interface RespondedPayload {
  readonly surveyKeys: readonly string[];
  readonly fetchedAt: number;
}

/**
 * One response as `GET /api/responses/{txHash}` reports it: coordinates and
 * identity, no record. `credential` is the core `credentialKey` form.
 */
export interface TxResponse {
  /** Position within the carrying payload's `responses` array. */
  readonly responseIndex: number;
  /** Target survey ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** Claimed CIP-179 role. */
  readonly role: number;
  /** Responder identity ("key:<hex>" | "script:<hex>"). */
  readonly credential: string;
  readonly slot: number;
}

/**
 * `GET /api/responses/{txHash}`: the responses one transaction carried. Empty
 * for a well-formed hash the snapshot holds nothing for — "not indexed yet",
 * never an error.
 */
export interface TxResponsesPayload {
  readonly responses: readonly TxResponse[];
  readonly fetchedAt: number;
}

/**
 * Operational health of a serving-tier backend (`GET /api/health`) — what the
 * app's thin health footer renders. Wire-plain by design (no bytes/bigints),
 * so it round-trips as ordinary JSON. Only the indexer path produces it; the
 * direct-Koios path has no refresh loop to report on.
 */
export interface BackendHealth {
  readonly network: string;
  /** The HTTP contract version served, see {@link API_VERSION}. */
  readonly apiVersion: string;
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
