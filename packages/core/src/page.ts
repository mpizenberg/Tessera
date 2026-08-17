/**
 * Shared pagination semantics for the payloads that can grow without bound:
 * the Explore survey list, and one survey's responses inside its bundle.
 *
 * The serving tier materializes per-survey rows at refresh time and answers
 * page queries in SQL (`backend/server`); the direct-Koios path holds the full
 * payload in memory and pages it here. Both must agree on the same ordering,
 * filters, counts, and cursor format — this module is that single definition,
 * and {@link pageSurveyList} is the executable spec the SQL mirrors.
 *
 * Ordering: pages stream in the register's visual order — governance-linked
 * surveys first, then open, then closed (the {@link surveyListBucket}), newest
 * slot first within a bucket, ref key as the final tiebreak. The keyset cursor
 * carries exactly that triple, so pagination is stable under new inserts (new
 * surveys land at the top of page one, never mid-stream).
 *
 * Stability is **per snapshot generation**, not absolute: a row's bucket is
 * time- and data-dependent (open→closed at epoch rollover, standalone→linked
 * when a governance link resolves), so a refresh can move rows across a live
 * cursor's boundary — duplicating or skipping them. The cursor therefore also
 * carries the generation it was minted against; a later-generation server
 * answers it best-effort and sets `resync` so the client can silently refresh
 * page one. Duplicates are the client's to drop (dedupe by survey key on
 * append).
 *
 * A survey's responses page by the same machinery and a stricter rule. Their
 * order is the storage order — slot, then carrying transaction, then index
 * within it — which no refresh reorders, so the only instability is the set
 * itself changing under a live cursor. A bundle feeds a tally rather than a
 * scrolling list, where a silently skipped response is a wrong result, so a
 * cursor from an older generation is answered *and* flagged, and
 * {@link collectSurveyBundle} starts over rather than stitching two
 * generations together.
 */

import type { Question } from "cip-179";

import {
  credentialKey,
  refKey,
  type GovLink,
  type SurveyAggregate,
  type SurveyRecord,
} from "cip-179/domain";

import type { SurveyBundlePayload, SurveyListPayload } from "./source";
import { aggregateSurveyList } from "./surveyList";

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
 * chips stay accurate however few rows are loaded. Mirrors Explore's rule that
 * counts reflect the active search: each chip reads "N matching & <filter>".
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

export interface SurveyListParams {
  /** Page size (rows). */
  readonly limit: number;
  /** Opaque continuation from the previous page's `nextCursor`. */
  readonly cursor?: string | undefined;
  /** Filter chip; defaults to "all". */
  readonly filter?: SurveyListFilter | undefined;
  /**
   * The caller's wallet credentials (core `credentialKey` form) — the `mine`
   * filter and count match survey owners against these.
   */
  readonly credentials?: readonly string[] | undefined;
  /** Free-text search: whitespace-separated terms, ANDed as substrings. */
  readonly search?: string | undefined;
}

/** The keyset position of a row: section bucket, slot, ref key. */
export interface SurveyCursor {
  readonly bucket: number;
  readonly slot: number;
  readonly key: string;
  /**
   * `fetchedAt` of the snapshot the cursor was minted against. Keyset order is
   * only stable within one generation (see the module header); a mismatch sets
   * `resync` on the answer. Absent when the paged payload carries no stamp
   * (direct-Koios mode pages a payload frozen for the whole session).
   */
  readonly generation?: number | undefined;
}

/** Wire form "<bucket>:<slot>:<txHex>:<index>[:<generation>]". */
export function encodeSurveyCursor(c: SurveyCursor): string {
  const base = `${c.bucket}:${c.slot}:${c.key}`;
  return c.generation === undefined ? base : `${base}:${c.generation}`;
}

export function parseSurveyCursor(s: string): SurveyCursor | null {
  const m = /^([0-2]):(\d+):([0-9a-f]+:\d+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  return {
    bucket: Number(m[1]),
    slot: Number(m[2]),
    key: m[3] as string,
    ...(m[4] !== undefined && { generation: Number(m[4]) }),
  };
}

/**
 * The keyset position of a response row inside its survey: slot, the hash of
 * the transaction carrying it, and its index within that transaction — the
 * storage order, which is also the order a bundle serves.
 */
export interface ResponseCursor {
  readonly slot: number;
  readonly txHash: string;
  readonly responseIndex: number;
  /**
   * `fetchedAt` of the snapshot the cursor was minted against, as
   * {@link SurveyCursor.generation}. A mismatch means the survey's response set
   * may have moved mid-collection, which for a tally input is not a cosmetic
   * problem — see the module header.
   */
  readonly generation?: number | undefined;
}

/** Wire form "<slot>:<txHex>:<index>[:<generation>]". */
export function encodeResponseCursor(c: ResponseCursor): string {
  const base = `${c.slot}:${c.txHash}:${c.responseIndex}`;
  return c.generation === undefined ? base : `${base}:${c.generation}`;
}

export function parseResponseCursor(s: string): ResponseCursor | null {
  const m = /^(\d+):([0-9a-f]{64}):(\d+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  return {
    slot: Number(m[1]),
    txHash: m[2] as string,
    responseIndex: Number(m[3]),
    ...(m[4] !== undefined && { generation: Number(m[4]) }),
  };
}

/**
 * Cap on the number of AND terms a search string contributes. The backend turns
 * each term into a `LIKE ?` bound parameter, so an uncapped `?q=` of hundreds of
 * words would exceed D1's bound-parameter limit and 500 a public endpoint
 * (review finding 42). Eight is far past any real survey search.
 */
export const MAX_SEARCH_TERMS = 8;

/** Normalize a search string into its lowercased AND terms (capped). */
export function searchTermsOf(search: string | undefined): string[] {
  return (search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
}

/** Text fragments from one question: its prompt plus any inline option or
 *  rating-scale labels (external-content questions carry only a count). */
function questionText(q: Question): string[] {
  const out = [q.prompt];
  if ("options" in q && q.options.type === "options")
    out.push(...q.options.labels);
  if (q.type === "rating" && q.scale.type === "labels")
    out.push(...q.scale.labels);
  return out;
}

/**
 * The lowercased text a survey is searched against: title + description, every
 * question prompt and inline label, and any verified governance link (id +
 * title). Built from the **on-chain** definition only — off-chain presentation
 * labels aren't available where the haystack is built (the serving tier's
 * refresh), so they are consistently not searchable in either mode.
 */
export function surveyHaystack(
  record: SurveyRecord,
  govLinks: readonly GovLink[],
): string {
  const d = record.definition;
  const parts = [d.title, d.description, ...d.questions.flatMap(questionText)];
  for (const link of govLinks) {
    parts.push(link.actionId);
    if (link.title) parts.push(link.title);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * The register section a survey sorts into: 0 governance-linked (open or
 * closed), 1 open standalone, 2 closed standalone — the exact partition the
 * Explore screen renders.
 */
function surveyListBucket(a: SurveyAggregate): number {
  if (a.govLinks.length > 0) return 0;
  return a.status === "active" ? 1 : 2;
}

function matchesFilter(
  a: SurveyAggregate,
  filter: SurveyListFilter,
  ownerKey: string,
  credentials: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "linked":
      return a.govLinks.length > 0;
    case "active":
      return a.status === "active";
    case "sealed":
      return a.status === "active" && a.sealed;
    case "public":
      return a.status === "active" && !a.sealed;
    case "mine":
      return credentials.has(ownerKey);
  }
}

/** Strictly after `cursor` in (bucket ASC, slot DESC, key ASC) order. */
function afterCursor(
  bucket: number,
  slot: number,
  key: string,
  c: SurveyCursor,
): boolean {
  if (bucket !== c.bucket) return bucket > c.bucket;
  if (slot !== c.slot) return slot < c.slot;
  return key > c.key;
}

/**
 * Page a full {@link SurveyListPayload} in memory — the direct-Koios path's
 * implementation of the paged list contract, and the reference the serving
 * tier's SQL must agree with. Returns a payload restricted to the page's
 * surveys (their cancellations, links, counts, overlay entries ride along, so
 * per-page aggregation gives the same rows a full aggregation would), plus
 * global `counts` and the `nextCursor` continuation.
 */
export function pageSurveyList(
  full: SurveyListPayload,
  params: SurveyListParams,
): SurveyListPayload {
  const terms = searchTermsOf(params.search);
  const credentials = new Set(params.credentials ?? []);
  const filter = params.filter ?? "all";
  const cursor = params.cursor ? parseSurveyCursor(params.cursor) : null;
  const staleCursor =
    cursor?.generation !== undefined &&
    full.fetchedAt !== undefined &&
    cursor.generation !== full.fetchedAt;

  const rows = aggregateSurveyList(full)
    .map((a) => ({
      a,
      bucket: surveyListBucket(a),
      ownerKey: credentialKey(a.record.definition.owner),
      haystack: surveyHaystack(a.record, a.govLinks),
    }))
    .filter((r) => terms.every((t) => r.haystack.includes(t)));

  const counts: SurveyListCounts = {
    all: rows.length,
    linked: rows.filter((r) => r.a.govLinks.length > 0).length,
    active: rows.filter((r) => r.a.status === "active").length,
    sealed: rows.filter((r) => r.a.status === "active" && r.a.sealed).length,
    public: rows.filter((r) => r.a.status === "active" && !r.a.sealed).length,
    mine: rows.filter((r) => credentials.has(r.ownerKey)).length,
  };

  const matching = rows
    .filter((r) => matchesFilter(r.a, filter, r.ownerKey, credentials))
    .sort(
      (x, y) =>
        x.bucket - y.bucket ||
        y.a.record.slot - x.a.record.slot ||
        (x.a.key < y.a.key ? -1 : x.a.key > y.a.key ? 1 : 0),
    )
    .filter(
      (r) => !cursor || afterCursor(r.bucket, r.a.record.slot, r.a.key, cursor),
    );

  const page = matching.slice(0, params.limit);
  const last = page[page.length - 1];
  const keys = new Set(page.map((r) => r.a.key));

  return {
    surveys: page.map((r) => r.a.record),
    cancellations: full.cancellations.filter((c) => keys.has(refKey(c.target))),
    govLinks: full.govLinks.filter((l) => keys.has(l.surveyKey)),
    tip: full.tip,
    responseCounts: Object.fromEntries(
      page.map((r) => [r.a.key, r.a.responseCount]),
    ),
    finalizedCancelled: (full.finalizedCancelled ?? []).filter((k) =>
      keys.has(k),
    ),
    ...(full.incomplete !== undefined && { incomplete: full.incomplete }),
    ...(full.fetchedAt !== undefined && { fetchedAt: full.fetchedAt }),
    ...(staleCursor && { resync: true }),
    counts,
    nextCursor:
      matching.length > params.limit && last
        ? encodeSurveyCursor({
            bucket: last.bucket,
            slot: last.a.record.slot,
            key: last.a.key,
            generation: full.fetchedAt,
          })
        : null,
  };
}

/**
 * How many times {@link collectSurveyBundle} restarts before giving up. A
 * restart happens when a refresh lands mid-collection; refreshes are minutes
 * apart and a survey is a handful of pages, so more than a couple of restarts
 * means something is wrong rather than merely busy, and a caller waiting on a
 * tally deserves the error instead of a loop.
 */
export const MAX_BUNDLE_RESYNCS = 3;

/**
 * Read a survey's whole bundle from a paged source: page one, then each
 * continuation, responses concatenated and verdicts merged in arrival order.
 *
 * A page that reports `resync` was minted against a different snapshot than the
 * pages before it, so the collection is abandoned and restarted rather than
 * stitched — see the module header on why a bundle is stricter than a list.
 * A source that does not page (no `nextCursor` on its answer) returns from the
 * first call, so this is safe to wrap around any bundle read.
 */
export async function collectSurveyBundle(
  fetchPage: (cursor: string | null) => Promise<SurveyBundlePayload>,
): Promise<SurveyBundlePayload> {
  for (let attempt = 0; ; attempt++) {
    const first = await fetchPage(null);
    const responses = [...first.responses];
    const verdicts = { ...first.verdicts };
    let cursor = first.nextCursor ?? null;
    let restart = false;
    while (cursor !== null) {
      const page = await fetchPage(cursor);
      if (page.resync) {
        restart = true;
        break;
      }
      responses.push(...page.responses);
      Object.assign(verdicts, page.verdicts);
      cursor = page.nextCursor ?? null;
    }
    if (!restart)
      return {
        ...first,
        responses,
        ...(first.verdicts !== undefined && { verdicts }),
        nextCursor: null,
      };
    if (attempt >= MAX_BUNDLE_RESYNCS)
      throw new Error(
        `survey bundle kept changing under pagination (${MAX_BUNDLE_RESYNCS} restarts)`,
      );
  }
}
