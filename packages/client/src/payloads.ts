/**
 * The HTTP contract of a Tessera serving backend: what each route answers,
 * and the constants a request must respect. `backend/server/README.md` in the
 * Tessera repository is the normative description; these types are its
 * typed form, and the backend compiles its bodies against them.
 */

import type {
  CancellationRecord,
  ChainTip,
  GovLink,
  ProofVerdicts,
  SurveyBundle,
  SurveyRecord,
} from "cip-179/domain";

/**
 * The version of the HTTP contract these types describe, as `major.minor`,
 * reported by the backend on `GET /health` and `GET /api/health`. A minor
 * adds (a field, a selection, a route); a major replaces (a field renamed,
 * removed or re-typed, a selection's semantics changed), and the backend then
 * serves the new shape only. A consumer compares majors with {@link apiMajor}
 * and refuses a mismatch; it may warn on a minor it does not know. Every
 * change is a line in the backend's `CHANGELOG.md`.
 */
export const API_VERSION = "1.1";

/** The major of a `major.minor` contract version — the part a consumer must match. */
export const apiMajor = (version: string): string =>
  version.split(".")[0] ?? version;

/**
 * A survey key, `<txHash>:<index>`: lowercase hex, index without leading
 * zeros. The form the contract carries wherever it names a survey — `refs=`,
 * the keys of `responseCounts` / `countedByRole` / `finalState`, the answers
 * of `/api/responded` and `/api/responses`.
 */
export const SURVEY_KEY_RE = /^[0-9a-f]{64}:(0|[1-9][0-9]*)$/;

/** Page size of `GET /api/surveys` when `limit` is not given. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Largest `limit` the paged list accepts, and the most references one
 * `refs=` selection may name.
 */
export const MAX_PAGE_LIMIT = 200;

/**
 * Most credentials one request may filter by (`credentials=` on the list and
 * on `/api/responded`). A wallet controls a payment and a stake credential,
 * so real callers send two.
 */
export const MAX_CREDENTIALS = 20;

/** Most transaction hashes one `GET /api/tx_status` request may ask about. */
export const MAX_TX_STATUS_HASHES = 20;

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

/** The Explore filter chips; `mine` matches on the caller's credentials. */
export type SurveyListFilter =
  | "all"
  | "linked"
  | "active"
  | "sealed"
  | "public"
  | "mine";

const SURVEY_LIST_FILTERS: readonly SurveyListFilter[] = [
  "all",
  "linked",
  "active",
  "sealed",
  "public",
  "mine",
];

export function isSurveyListFilter(x: unknown): x is SurveyListFilter {
  return SURVEY_LIST_FILTERS.includes(x as SurveyListFilter);
}

/**
 * Global per-chip totals over the search-matching set (not the page), so the
 * chips stay accurate however few rows are loaded. Each chip reads
 * "N matching & <filter>".
 */
export interface SurveyListCounts {
  readonly all: number;
  readonly linked: number;
  readonly active: number;
  readonly sealed: number;
  readonly public: number;
  /** Owned by the caller's credentials; 0 when none were provided. */
  readonly mine: number;
}

/** The paged list selection's parameters (`GET /api/surveys`). */
export interface SurveyListParams {
  /** Page size, 1 to {@link MAX_PAGE_LIMIT}; {@link DEFAULT_PAGE_LIMIT} when absent. */
  readonly limit?: number | undefined;
  /** Opaque continuation from the previous page's `nextCursor`. */
  readonly cursor?: string | undefined;
  /** Filter chip; defaults to "all". */
  readonly filter?: SurveyListFilter | undefined;
  /**
   * The caller's wallet credentials (`"key:<hex>"` | `"script:<hex>"`) — the
   * `mine` filter and count match survey owners against these.
   */
  readonly credentials?: readonly string[] | undefined;
  /** Free-text search: whitespace-separated terms, ANDed as substrings. */
  readonly search?: string | undefined;
}

/**
 * The freshness stamp the serving tier appends to a snapshot-derived body.
 * Absent from a source with no snapshot (Tessera's direct-Koios mode).
 */
export interface SnapshotStamp {
  /**
   * Unix seconds the scan behind this body started reading — the instant its
   * `tip` was taken, and the paging generation minted into a `nextCursor`.
   */
  readonly fetchedAt?: number;
}

/**
 * Everything the survey *list* page renders from — one bounded payload
 * regardless of participation volume. Responses are the only unbounded record
 * set, and the list only needs their per-survey count, so they're pre-deduped
 * (the `cip-179/domain` `dedupeResponses` rule) into `responseCounts` at the
 * source. Cancellations ride raw (they're tiny) so owner-proof verification
 * stays client-side.
 */
export interface SurveyListPayload extends SnapshotStamp {
  readonly surveys: readonly SurveyRecord[];
  readonly cancellations: readonly CancellationRecord[];
  readonly govLinks: readonly GovLink[];
  readonly tip: ChainTip;
  /** Distinct responders per survey key, latest-valid-wins. */
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
   * final per-role set can only be smaller. Absent from a source with no
   * proof verdicts to audit against.
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
   * auditable against the served artifact. Absent from a source with no
   * finalization.
   */
  readonly finalState?: Readonly<Record<string, SurveyFinalState>>;
  /** Mirrors `Cip179Records.incomplete` (`cip-179/domain`) for the scan behind this list. */
  readonly incomplete?: boolean;
  /**
   * Global per-filter totals over the search-matching set — present on the
   * paged selection, absent on a full unpaged payload and on one that answers
   * a caller-named set of references (no filtered set to total).
   */
  readonly counts?: SurveyListCounts;
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
  /**
   * Where a mirror that walked the whole list at this snapshot's generation
   * continues with the change selection (`changes`). Present on the paged
   * selection from the serving tier; keep the one from a walk that finished
   * without `resync`.
   */
  readonly changesCursor?: string;
}

/**
 * `GET /api/surveys?changes=<cursor>`: what changed since a position the
 * server minted — the list body for the surveys whose stored projection moved
 * (a new survey, a count, a link, a cancellation, a final state), the keys
 * `removed` since, and the position to ask from next tick. A consumer stores
 * one string; a change is delivered once and never missed. Within one answer
 * apply `removed` before the rows. A removal is advisory and can be transient
 * (a reorg re-lands the transaction at a new slot), so local state that cannot
 * be rebuilt is confirmed by `refs` before it is destroyed; removing a key one
 * never held is a no-op. No `counts` (the banked totals cover the whole set,
 * not the delta) and no filter: the consumer filters locally.
 */
export interface SurveyChangesPayload extends Omit<
  SurveyListPayload,
  "counts" | "changesCursor"
> {
  /** Survey keys removed since the cursor's position. */
  readonly removed: readonly string[];
  /**
   * The position to ask from next — never null on a complete answer, since
   * an exhausted axis advances to the published generation. Null only beside
   * `resync`: the cursor is older than the retention window, its removals may
   * be pruned, and the consumer walks the full list again.
   */
  readonly nextCursor: string | null;
}

/**
 * A survey's bundle plus the serving tier's per-response credential-proof
 * verdicts. The verdicts stay OFF {@link SurveyBundle} itself: that type is
 * the chain-data contract a verifier re-derives, and the serving tier's
 * opinion must never read as chain data (same trust posture as
 * {@link SurveyListPayload.finalState}). When present the map is complete
 * over *decided* verdicts — a response key it lacks is pending, not failed.
 * Absent entirely when the source has no proof machinery.
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
   * ({@link import("./bundle").collectSurveyBundle}).
   */
  readonly resync?: boolean;
}

/**
 * `GET /api/responded?credentials=`: the survey keys with at least one
 * response from any of the named credentials.
 */
export interface RespondedPayload {
  readonly surveyKeys: readonly string[];
  readonly fetchedAt: number;
}

/**
 * One response as `GET /api/responses/{txHash}` reports it: coordinates and
 * identity, no record. `credential` is the `cip-179/domain` `credentialKey`
 * form.
 */
export interface TxResponse {
  /** Position within the carrying payload's `responses` array. */
  readonly responseIndex: number;
  /** Target survey key. */
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
 * Operational health of a serving-tier backend (`GET /api/health`).
 * Wire-plain by design (no bytes/bigints), so it round-trips as ordinary JSON.
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
