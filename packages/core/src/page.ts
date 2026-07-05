/**
 * Shared pagination semantics for the Explore survey list.
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
 */

import type { Question } from "cip-179";

import { credentialKey, refKey } from "./dedupe";
import type { GovLink, SurveyListPayload, SurveyRecord } from "./source";
import { aggregateSurveyList, type SurveyAggregate } from "./survey";

/** The Explore filter chips; `mine` matches on the caller's credentials. */
export type SurveyListFilter =
  | "all"
  | "linked"
  | "active"
  | "sealed"
  | "public"
  | "mine";

export const SURVEY_LIST_FILTERS: readonly SurveyListFilter[] = [
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
}

/** Wire form "<bucket>:<slot>:<txHex>:<index>" (the key itself contains ":"). */
export function encodeSurveyCursor(c: SurveyCursor): string {
  return `${c.bucket}:${c.slot}:${c.key}`;
}

export function parseSurveyCursor(s: string): SurveyCursor | null {
  const m = /^([0-2]):(\d+):([0-9a-f]+:\d+)$/.exec(s);
  if (!m) return null;
  return { bucket: Number(m[1]), slot: Number(m[2]), key: m[3] as string };
}

/** Normalize a search string into its lowercased AND terms. */
export function searchTermsOf(search: string | undefined): string[] {
  return (search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
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
  govLink: GovLink | null,
): string {
  const d = record.definition;
  const parts = [d.title, d.description, ...d.questions.flatMap(questionText)];
  if (govLink) {
    parts.push(govLink.actionId);
    if (govLink.title) parts.push(govLink.title);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * The register section a survey sorts into: 0 governance-linked (open or
 * closed), 1 open standalone, 2 closed standalone — the exact partition the
 * Explore screen renders.
 */
export function surveyListBucket(a: SurveyAggregate): number {
  if (a.govLink !== null) return 0;
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
      return a.govLink !== null;
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

  const rows = aggregateSurveyList(full)
    .map((a) => ({
      a,
      bucket: surveyListBucket(a),
      ownerKey: credentialKey(a.record.definition.owner),
      haystack: surveyHaystack(a.record, a.govLink),
    }))
    .filter((r) => terms.every((t) => r.haystack.includes(t)));

  const counts: SurveyListCounts = {
    all: rows.length,
    linked: rows.filter((r) => r.a.govLink !== null).length,
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
    counts,
    nextCursor:
      matching.length > params.limit && last
        ? encodeSurveyCursor({
            bucket: last.bucket,
            slot: last.a.record.slot,
            key: last.a.key,
          })
        : null,
  };
}
