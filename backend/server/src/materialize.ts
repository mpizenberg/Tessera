/**
 * Project on-chain records into the rows the serving routes read. The
 * per-record projections are shared by the runtime segment integration
 * (`integrate.ts`, applied per touched survey) and by `materializeSnapshot` —
 * the pure whole-corpus rebuild kept as the differential-test oracle:
 * windowed integration over any event sequence must leave exactly the rows a
 * full rebuild would produce. Aggregation (verified cancellations,
 * epoch-aligned governance links, deduped response counts) reuses the exact
 * core domain code the app runs, so a row's flags always agree with what a
 * client would derive from the full payload; the segment integration counts
 * responders from the stored identity columns instead of the records, over
 * the same `(survey, role, credential)` key `dedupeResponses` collapses.
 *
 * The counts here are the oracle's spelling — `responseCounts` and
 * `auditResponses` over whole records. Integration reaches the same numbers
 * from banked identity columns, and the differential test is what holds the
 * two spellings together.
 */

import type { SurveyDefinition } from "cip-179";
import {
  aggregate,
  auditResponses,
  byCancellationChainOrder,
  credentialKey,
  proofVerdictKey,
  refKey,
  responseCounts,
  responseIsCountable,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type ProofVerdicts,
  type ResponseRecord,
  type SurveyRecord,
} from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";
import { surveyHaystack, type SurveyFinalState } from "cardano-tessera-core";

import type {
  BankedListCounts,
  CancellationRow,
  ResponseRow,
  SurveyIndexRow,
} from "./store";

export interface MaterializedSnapshot {
  readonly surveys: SurveyIndexRow[];
  readonly responses: ResponseRow[];
  readonly cancellations: CancellationRow[];
  /**
   * Credential-free chip counts over all rows, against this snapshot's tip —
   * what the refresh banks with the envelope so the list route serves them
   * without aggregating. Mirrors core `pageSurveyList`'s counts with no
   * search terms.
   */
  readonly listCounts: BankedListCounts;
}

/** The three per-survey figures a row's count columns carry. */
export interface SurveyCounts {
  /** Distinct responders across roles — no validity, deadline or proof filter. */
  readonly responders: number;
  /**
   * The audited count per CIP-179 role (the role integer as an object key):
   * `auditResponses`' counted set — in-window, valid against the definition,
   * latest-valid-wins, refuted proofs dropped, pending verdicts counted —
   * grouped by the responder's role. Empty rather than absent when nothing
   * counts, so the wire never distinguishes "zero" from "unknown".
   *
   * Provisional by construction: a pending verdict counts (not-yet-checked
   * must never read as failed), and the artifact additionally applies
   * end-epoch role membership, so the final per-role set can only be smaller.
   */
  readonly countedByRole: Record<string, number>;
  /**
   * How many refuted proofs {@link countedByRole} was computed against — the
   * row's stamp. A refutation is decided after the integration that projected
   * the row, and can land on a survey no segment touches, so a stamp that
   * disagrees with the live count is what makes the row stale.
   */
  readonly refuted: number;
}

const NO_COUNTS: SurveyCounts = {
  responders: 0,
  countedByRole: {},
  refuted: 0,
};

/**
 * Role counts as stored and served, in ascending role order. The oracle builds
 * the map in response order and the segment integration in banked-then-window
 * order, and the two projections have to be the same bytes.
 */
const roleCountsJson = (counts: Record<string, number>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => Number(a) - Number(b)),
    ),
  );

/**
 * The static half of the audit rule: in-window (the record's authoritative
 * epoch against the survey's deadline) and valid against the definition.
 * Both operands are immutable, so this is settled when a response row is
 * projected and is stored on it — only a refuted credential proof can still
 * take a countable response out of the count.
 */
export const responseCountable = (
  definition: SurveyDefinition,
  r: ResponseRecord,
): boolean =>
  r.epochNo <= definition.endEpoch &&
  responseIsCountable(definition, r.response);

/**
 * Every count column of the given surveys, from whole records — the oracle's
 * spelling of the rule, and the reference the segment integration's banked
 * arithmetic is held to.
 */
export function surveyCountsOf(
  surveys: readonly SurveyRecord[],
  responses: readonly ResponseRecord[],
  refuted: ReadonlySet<string>,
): Record<string, SurveyCounts> {
  const verdicts: ProofVerdicts = Object.fromEntries(
    [...refuted].map((key) => [key, false]),
  );
  const responders = responseCounts(responses);
  const bySurvey = new Map<string, ResponseRecord[]>();
  for (const r of responses) {
    const key = refKey(r.response.surveyRef);
    const list = bySurvey.get(key);
    if (list) list.push(r);
    else bySurvey.set(key, [r]);
  }
  const out: Record<string, SurveyCounts> = {};
  for (const s of surveys) {
    const key = refKey(s.ref);
    const own = bySurvey.get(key) ?? [];
    const countedByRole: Record<string, number> = {};
    for (const r of auditResponses(own, s.definition, verdicts).counted)
      countedByRole[r.response.role] =
        (countedByRole[r.response.role] ?? 0) + 1;
    out[key] = {
      responders: responders[key] ?? 0,
      countedByRole,
      refuted: own.filter((r) => refuted.has(proofVerdictKey(r))).length,
    };
  }
  return out;
}

/**
 * Project the given surveys' index rows from their full aggregation inputs:
 * each survey's definition record, every cancellation targeting it, its
 * counts, and the current links/tip/overlay. Callers own the scoping — the
 * oracle passes the whole corpus, the segment integration passes the touched
 * surveys with their merged stored+segment inputs.
 */
export function surveyRowsOf(
  surveys: readonly SurveyRecord[],
  cancellations: readonly CancellationRecord[],
  counts: Record<string, SurveyCounts>,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalStates: ReadonlyMap<string, SurveyFinalState>,
): SurveyIndexRow[] {
  // Grouped in chain order, so the projected JSON is identical whether the
  // inputs arrive in scan order (the oracle) or as stored-plus-segment merges
  // (the segment integration).
  const cancellationsByKey = new Map<string, CancellationRecord[]>();
  for (const c of [...cancellations].sort(byCancellationChainOrder)) {
    const key = refKey(c.target);
    const list = cancellationsByKey.get(key);
    if (list) list.push(c);
    else cancellationsByKey.set(key, [c]);
  }
  // All links naming the survey ride along (the client re-checks alignment
  // from the raw records, as it does today); the `govLinked` flag is the
  // verified (epoch-aligned) one the filters and section buckets use.
  const linksByKey = new Map<string, GovLink[]>();
  for (const l of govLinks) {
    const list = linksByKey.get(l.surveyKey);
    if (list) list.push(l);
    else linksByKey.set(l.surveyKey, [l]);
  }
  // `aggregate` only needs the cancelled overlay; the other final states never
  // change how a survey aggregates.
  const finalizedCancelled = new Set(
    [...finalStates]
      .filter(([, s]) => s.state === "cancelled")
      .map(([key]) => key),
  );
  return aggregate(
    surveys,
    cancellations,
    Object.fromEntries(
      Object.entries(counts).map(([key, c]) => [key, c.responders]),
    ),
    tip,
    govLinks,
    finalizedCancelled,
  ).map((a) => {
    const finalState = finalStates.get(a.key) ?? null;
    const count = counts[a.key] ?? NO_COUNTS;
    return {
      surveyKey: a.key,
      slot: a.record.slot,
      endEpoch: a.record.definition.endEpoch,
      sealed: a.sealed,
      cancelled: a.cancelled,
      govLinked: a.govLinks.length > 0,
      owner: credentialKey(a.record.definition.owner),
      haystack: surveyHaystack(a.record, a.govLinks),
      record: JSON.stringify(toJsonSafe(a.record)),
      cancellations: JSON.stringify(
        toJsonSafe(cancellationsByKey.get(a.key) ?? []),
      ),
      govLinks: JSON.stringify(toJsonSafe(linksByKey.get(a.key) ?? [])),
      responseCount: a.responseCount,
      countedByRole: roleCountsJson(count.countedByRole),
      refutedCount: count.refuted,
      finalState: finalState?.state ?? null,
      artifactHash:
        finalState && "artifactHash" in finalState
          ? finalState.artifactHash
          : null,
    };
  });
}

/**
 * `definition` is the target survey's, or undefined when no record holds it —
 * a response to a survey that rolled back or predates the scan floor, which
 * cannot be counted against a rule that does not exist. Its survey has no row
 * either; if one revives, the rescan re-derives the response with it.
 */
export const responseRowOf = (
  r: ResponseRecord,
  definition: SurveyDefinition | undefined,
): ResponseRow => ({
  txHash: r.txHash,
  responseIndex: r.responseIndex,
  surveyKey: refKey(r.response.surveyRef),
  role: r.response.role,
  credential: credentialKey(r.response.credential),
  slot: r.slot,
  countable: definition !== undefined && responseCountable(definition, r),
  record: JSON.stringify(toJsonSafe(r)),
});

export const cancellationRowOf = (c: CancellationRecord): CancellationRow => ({
  txHash: c.txHash,
  surveyKey: refKey(c.target),
  slot: c.slot,
  record: JSON.stringify(toJsonSafe(c)),
});

/** Chip counts over projected rows — the SQL aggregate's in-memory twin. */
export function listCountsOf(
  surveys: readonly SurveyIndexRow[],
  tipEpoch: number,
): BankedListCounts {
  const active = surveys.filter((r) => !r.cancelled && r.endEpoch >= tipEpoch);
  return {
    all: surveys.length,
    linked: surveys.filter((r) => r.govLinked).length,
    active: active.length,
    sealed: active.filter((r) => r.sealed).length,
    public: active.filter((r) => !r.sealed).length,
  };
}

export function materializeSnapshot(
  records: Cip179Records,
  tip: ChainTip,
  govLinks: readonly GovLink[],
  finalStates: ReadonlyMap<string, SurveyFinalState>,
  refuted: ReadonlySet<string> = new Set(),
): MaterializedSnapshot {
  const surveys = surveyRowsOf(
    records.surveys,
    records.cancellations,
    surveyCountsOf(records.surveys, records.responses, refuted),
    tip,
    govLinks,
    finalStates,
  );
  const defByKey = new Map(
    records.surveys.map((s) => [refKey(s.ref), s.definition]),
  );
  return {
    listCounts: listCountsOf(surveys, tip.epoch),
    surveys,
    responses: records.responses.map((r) =>
      responseRowOf(r, defByKey.get(refKey(r.response.surveyRef))),
    ),
    cancellations: records.cancellations.map(cancellationRowOf),
  };
}
