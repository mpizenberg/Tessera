/**
 * The presentation model for a survey's results — the one place floats appear,
 * always derived from exact integers, never stored. No framework, no I/O.
 *
 * Two layers, and the difference between them is the point:
 *
 * - **Committed** — what a tally artifact's content hash covers. One shape,
 *   `ArtifactQuestion`, reached either by reading the artifact (chain
 *   weighting: byte-authoritative, never recomputed) or by running `cip-179`'s
 *   normative tally with every weight `1n` (one-vote, and the pre-artifact live
 *   view). There is no second tallying implementation: a live tally is the
 *   normative tally at unit weight, which is also how the count-only Keyholder
 *   role is counted.
 * - **Supplementary** — detail no artifact carries, today the verbatim custom
 *   answers. Recomputed here from the *counted responders'* answers, which both
 *   paths can resolve: a sealed artifact commits each responder's revealed
 *   answers, a public one rejoins the on-chain response. Never hashed, so
 *   anything rendered from it must say so.
 *
 * Adding a visualization means adding to {@link QuestionDetail} and its
 * builder; it never means touching `TALLY-SPEC.md` or moving `rulesetHash`.
 */

import type {
  AnswerItem,
  Question,
  RatingScale,
  Role,
  SurveyDefinition,
  SurveyResponse,
} from "cip-179";

import {
  credentialKey,
  optionLabelOf,
  parseCredentialKey,
} from "cip-179/domain";
import {
  responderAnswers,
  toArtifactQuestions,
  weightedTallySurvey,
  type ArtifactQuestion,
  type ArtifactResponder,
  type ArtifactRoleTally,
  type TallyArtifact,
  type WeightedResponder,
} from "cip-179/tally";

// ---------------------------------------------------------------------------
// Exact integers to display floats
// ---------------------------------------------------------------------------

/** Fill fraction 0–1 of `part` relative to `max` (4 decimal places). */
export function fracOf(part: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  return Number((part * 10_000n) / max) / 10_000;
}

/** `num / den` to 4 decimal places, or null when the denominator is empty. */
export function ratioOf(num: bigint, den: bigint): number | null {
  if (den <= 0n) return null;
  return Number((num * 10_000n) / den) / 10_000;
}

/** Whole-ada rendering of a lovelace amount, grouped ("512,793"). */
export function formatAda(lovelace: bigint): string {
  const ada = lovelace / 1_000_000n;
  if (ada === 0n && lovelace > 0n) return "<1";
  return ada.toLocaleString("en-US");
}

/**
 * Upper bound on how many option/level buckets any widget will materialize. A
 * hostile definition can declare an astronomically large option `count` or
 * rating span; the committed tally is sparse (it grows with responses, never
 * with the declared span), but the display refills zero-answer buckets so the
 * reader sees every choice. Without this cap that refill is an
 * attacker-controlled allocation. No real survey approaches it; a pathological
 * one renders its first buckets plus whatever higher indices were answered.
 */
export const MAX_DISPLAY_BUCKETS = 1000;

// ---------------------------------------------------------------------------
// Committed: the artifact's aggregates, made render-ready
// ---------------------------------------------------------------------------

export interface BarView {
  readonly label: string;
  readonly weight: bigint;
  readonly count: number;
  /** Fill fraction 0–1, relative to the leading bar. */
  readonly frac: number;
}

export interface RowView {
  readonly label: string;
  /** Weighted mean, or null when nothing backs it. */
  readonly avg: number | null;
  readonly count: number;
}

export type QuestionView =
  | {
      readonly kind: "bars";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      readonly bars: readonly BarView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "histogram";
      readonly bins: readonly BarView[];
      /** Weighted mean of the numeric values, or null with no answers. */
      readonly mean: number | null;
      /** Weighted median — the value where half the weight has accumulated. */
      readonly median: number | null;
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "rows";
      readonly unit: "points" | "rating";
      readonly rows: readonly RowView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    };

function barViews(
  labels: readonly string[],
  weights: readonly bigint[],
  counts: readonly number[],
): BarView[] {
  const max = weights.reduce((a, b) => (b > a ? b : a), 0n);
  return labels.map((label, i) => ({
    label,
    weight: weights[i] ?? 0n,
    count: counts[i] ?? 0,
    frac: fracOf(weights[i] ?? 0n, max),
  }));
}

/** Declared option count of a question, or null when it has no options. */
function declaredOptionCount(q: Question | undefined): number | null {
  if (q && "options" in q)
    return q.options.type === "options"
      ? q.options.labels.length
      : q.options.count;
  return null;
}

/**
 * Which option indices to render for a *sparse* committed question. The tally
 * carries only answered options; here we fill 0..min(declared, cap) so
 * zero-answer options still show as empty rows, then append any populated index
 * beyond that (a hostile huge-count survey answered at a high index) so nothing
 * counted is hidden — all without ever materializing the attacker-declared
 * width (see {@link MAX_DISPLAY_BUCKETS}).
 */
function renderIndices(
  q: Question | undefined,
  populated: readonly number[],
): number[] {
  const declared = declaredOptionCount(q);
  const set = new Set<number>();
  if (declared !== null) {
    const n = Math.min(declared, MAX_DISPLAY_BUCKETS);
    for (let i = 0; i < n; i++) set.add(i);
  }
  for (const i of populated) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/**
 * The value at which half the answered weight has accumulated. Bins arrive
 * value-ascending; when the halfway point falls exactly on a bin boundary the
 * two neighbours are averaged, so at unit weights this is the ordinary median.
 */
function weightedMedian(
  bins: readonly { value: string; weight: string }[],
  answeredWeight: bigint,
): number | null {
  if (answeredWeight <= 0n) return null;
  let cumulative = 0n;
  for (let i = 0; i < bins.length; i++) {
    cumulative += BigInt(bins[i]!.weight);
    const doubled = cumulative * 2n;
    if (doubled > answeredWeight) return Number(bins[i]!.value);
    if (doubled === answeredWeight) {
      const next = bins[i + 1];
      const here = Number(bins[i]!.value);
      return next ? (here + Number(next.value)) / 2 : here;
    }
  }
  return null;
}

/** One committed question tally, made render-ready against the definition. */
export function questionView(
  q: Question | undefined,
  aq: ArtifactQuestion,
): QuestionView {
  switch (aq.kind) {
    case "options": {
      const byIndex = new Map(aq.options.map((o) => [o.index, o]));
      const max = aq.options.reduce((m, o) => {
        const w = BigInt(o.weight);
        return w > m ? w : m;
      }, 0n);
      const bars = renderIndices(
        q,
        aq.options.map((o) => o.index),
      ).map((index) => {
        const o = byIndex.get(index);
        const weight = o ? BigInt(o.weight) : 0n;
        return {
          label: optionLabelOf(q, index),
          weight,
          count: o?.count ?? 0,
          frac: fracOf(weight, max),
        };
      });
      return {
        kind: "bars",
        unit: aq.unit,
        bars,
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    }
    case "numeric": {
      const answeredWeight = BigInt(aq.answeredWeight);
      return {
        kind: "histogram",
        bins: barViews(
          aq.values.map((v) => v.value),
          aq.values.map((v) => BigInt(v.weight)),
          aq.values.map((v) => v.count),
        ),
        mean: ratioOf(BigInt(aq.weightedSum), answeredWeight),
        median: weightedMedian(aq.values, answeredWeight),
        answeredCount: aq.answeredCount,
        answeredWeight,
      };
    }
    case "perOption": {
      const byIndex = new Map(aq.perOption.map((o) => [o.index, o]));
      const rows = renderIndices(
        q,
        aq.perOption.map((o) => o.index),
      ).map((index) => {
        const o = byIndex.get(index);
        // Points omits the per-option denominator (it equals the question-level
        // `answeredWeight`, identical for every option); rating commits its own.
        const denom = o?.answeredWeight ?? aq.answeredWeight;
        return {
          label: optionLabelOf(q, index),
          avg: o ? ratioOf(BigInt(o.weightedSum), BigInt(denom)) : null,
          count: o?.count ?? 0,
        };
      });
      return {
        kind: "rows",
        unit: aq.unit,
        rows,
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    }
    case "custom":
      return {
        kind: "custom",
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
  }
}

// ---------------------------------------------------------------------------
// Supplementary: detail recomputed from the counted answers
// ---------------------------------------------------------------------------

/** How many verbatim custom answers to keep. */
const SAMPLE_LIMIT = 6;

/**
 * Detail the committed tally does not carry, derived locally from the counted
 * responders' answers. Every field is optional: a question kind that has no
 * supplementary detail, or a counted set whose answers could not be resolved,
 * yields an empty object rather than a special case downstream. A richer
 * visualization adds a field here and a branch in {@link questionDetail}.
 */
export interface QuestionDetail {
  /** Custom: a few verbatim answers. */
  readonly samples?: readonly string[];
}

/** Level layout of a rating scale: how many, labelled how, spaced how. */
export function ratingScaleInfo(scale: RatingScale): {
  levels: number;
  levelLabels: string[] | null;
  numeric: boolean;
  baseMin: number;
  /** Value increment between adjacent levels (1 for label/count scales). */
  step: number;
} {
  switch (scale.type) {
    case "numeric": {
      const min = Number(scale.constraints.min);
      const max = Number(scale.constraints.max);
      // A stepped scale (e.g. 0..10 by 2) has fewer distinct levels than its
      // span; bucket on step units so the histogram has no empty gaps.
      const step =
        scale.constraints.step !== undefined && scale.constraints.step > 0n
          ? Number(scale.constraints.step)
          : 1;
      return {
        levels: Math.max(1, Math.floor((max - min) / step) + 1),
        levelLabels: null,
        numeric: true,
        baseMin: min,
        step,
      };
    }
    case "labels":
      return {
        levels: scale.labels.length,
        levelLabels: [...scale.labels],
        numeric: false,
        baseMin: 0,
        step: 1,
      };
    case "count":
      return {
        levels: scale.count,
        levelLabels: null,
        numeric: false,
        baseMin: 0,
        step: 1,
      };
  }
}

/** Every public answer to question `index`, across the counted responders. */
function answersTo(
  responders: readonly WeightedResponder[],
  index: number,
): AnswerItem[] {
  const items: AnswerItem[] = [];
  for (const r of responders) {
    if (r.response.answers.type !== "public") continue;
    for (const a of r.response.answers.answers)
      if (a.questionIndex === index) items.push(a);
  }
  return items;
}

function questionDetail(
  q: Question | undefined,
  index: number,
  responders: readonly WeightedResponder[],
): QuestionDetail {
  if (q?.type !== "custom") return {};
  const samples: string[] = [];
  for (const a of answersTo(responders, index)) {
    if (samples.length >= SAMPLE_LIMIT) break;
    if (a.type === "custom" && typeof a.value === "string")
      samples.push(a.value);
  }
  return samples.length > 0 ? { samples } : {};
}

// ---------------------------------------------------------------------------
// Per-role results
// ---------------------------------------------------------------------------

/**
 * An on-chain response, in the only three fields the results model reads: its
 * chain coordinate (which joins it to an artifact responder) and its content.
 * A full `ResponseRecord` satisfies this.
 */
export interface CountedResponse {
  readonly txHash: string;
  readonly responseIndex: number;
  readonly response: SurveyResponse;
}

/** One question's results: what the tally commits, plus what we derived. */
export interface QuestionResults {
  readonly view: QuestionView;
  readonly detail: QuestionDetail;
}

export interface RoleResults {
  readonly role: number;
  /** Counted responders for this role. */
  readonly responderCount: number;
  /**
   * Σ counted responder weights (lovelace) under chain weighting; `null` at
   * unit weight and for count-only roles, where the count is the story.
   */
  readonly votedWeight: bigint | null;
  /** The role's electorate total, or null (count-only roles / unit weight). */
  readonly total: bigint | null;
  /** votedWeight / total, or null when there is no meaningful total. */
  readonly turnout: number | null;
  readonly questions: readonly QuestionResults[];
}

/**
 * The two ways an artifact is presented. Both range over its *counted set* —
 * the proof-validated responders it committed to — differing only in the weight
 * each responder carries:
 *
 * - `"chain"`: each responder's snapshotted stake / voting power (lovelace);
 *   turnout against the role's electorate total is meaningful.
 * - `"one"`: every responder weighs `1` (one credential, one vote); there is
 *   no ada total, so voting-weight and turnout are omitted.
 */
export type Weighting = "chain" | "one";

function questionResults(
  questions: readonly ArtifactQuestion[],
  def: SurveyDefinition,
  responders: readonly WeightedResponder[],
): QuestionResults[] {
  return questions.map((aq, i) => ({
    view: questionView(def.questions[i], aq),
    detail: questionDetail(def.questions[i], i, responders),
  }));
}

/** A role's results with every weight `1n`, re-tallied from its responders. */
function unitWeightRole(
  role: number,
  responderCount: number,
  responders: readonly WeightedResponder[],
  def: SurveyDefinition,
): RoleResults {
  const unit = responders.map((r) => ({ ...r, weight: 1n }));
  return {
    role,
    responderCount,
    votedWeight: null,
    total: null,
    turnout: null,
    questions: questionResults(
      toArtifactQuestions(weightedTallySurvey(def, unit)),
      def,
      unit,
    ),
  };
}

/**
 * Resolve a counted responder's answers. Sealed artifacts commit each
 * responder's revealed answers, which we synthesize back into a public
 * `SurveyResponse` — the on-chain response is only a ciphertext. Public (and
 * legacy) artifacts commit no answers, so fall back to the on-chain response by
 * `(txHash, responseIndex)`.
 */
function responderResponse(
  r: ArtifactResponder,
  role: number,
  def: SurveyDefinition,
  byKey: ReadonlyMap<string, SurveyResponse>,
): SurveyResponse | undefined {
  const committed = responderAnswers(r);
  if (committed) {
    return {
      specVersion: def.specVersion,
      // The tally reads only role + answers; a placeholder ref is fine and never
      // rendered. Credential is parsed back from its committed identity.
      surveyRef: { txId: new Uint8Array(), index: 0 },
      role: role as Role,
      credential: parseCredentialKey(r.credential),
      answers: { type: "public", answers: committed },
    };
  }
  return byKey.get(`${r.txHash}|${r.responseIndex}`);
}

/**
 * A role's counted responders, each carrying its committed weight and its
 * resolved answers. Responders whose answers can't be resolved are dropped —
 * they contribute to no aggregate, committed or derived (and can't happen for a
 * finalized on-chain survey).
 */
function countedResponders(
  role: ArtifactRoleTally,
  def: SurveyDefinition,
  byKey: ReadonlyMap<string, SurveyResponse>,
): WeightedResponder[] {
  const out: WeightedResponder[] = [];
  for (const r of role.responders) {
    const response = responderResponse(r, role.role, def, byKey);
    if (response)
      out.push({
        credentialKey: r.credential,
        weight: BigInt(r.weight),
        txHash: r.txHash,
        responseIndex: r.responseIndex,
        response,
      });
  }
  return out;
}

/**
 * Per-role results from a finalized artifact, in its (role-ascending) order.
 * Under `"chain"` weighting the committed aggregates are rendered as-is —
 * byte-authoritative, the exact numbers the content hash covers. `responses`
 * are the survey's on-chain responses, needed to rejoin answers for the
 * one-vote re-tally and for supplementary detail.
 */
export function artifactResults(
  artifact: TallyArtifact,
  def: SurveyDefinition,
  responses: readonly CountedResponse[],
  weighting: Weighting,
): RoleResults[] {
  const byKey = new Map<string, SurveyResponse>();
  for (const r of responses)
    byKey.set(`${r.txHash}|${r.responseIndex}`, r.response);

  return artifact.tally.perRole.map((role) => {
    const responders = countedResponders(role, def, byKey);
    if (weighting === "one")
      return unitWeightRole(role.role, role.responders.length, responders, def);
    const votedWeight = role.responders.reduce(
      (sum, r) => sum + BigInt(r.weight),
      0n,
    );
    const total = role.total === null ? null : BigInt(role.total);
    return {
      role: role.role,
      responderCount: role.responders.length,
      votedWeight,
      total,
      turnout: total === null ? null : ratioOf(votedWeight, total),
      questions: questionResults(role.questions, def, responders),
    };
  });
}

/**
 * Per-role results computed in the browser from counted on-chain responses,
 * before (or instead of) a finalized artifact. Every responder weighs `1`:
 * nothing here has a stake snapshot, which only finalization can produce.
 */
export function liveResults(
  def: SurveyDefinition,
  records: readonly CountedResponse[],
): RoleResults[] {
  const byRole = new Map<number, WeightedResponder[]>();
  for (const rec of records) {
    const list = byRole.get(rec.response.role) ?? [];
    list.push({
      credentialKey: credentialKey(rec.response.credential),
      weight: 1n,
      txHash: rec.txHash,
      responseIndex: rec.responseIndex,
      response: rec.response,
    });
    byRole.set(rec.response.role, list);
  }
  return [...byRole.entries()]
    .sort(([a], [b]) => a - b)
    .map(([role, responders]) =>
      unitWeightRole(role, responders.length, responders, def),
    );
}

/**
 * Per-role response counts, role-ascending. Unlike {@link liveResults} this
 * reads nothing but the envelope, so it works while a survey is still sealed:
 * role and credential are plaintext, only the answers are not.
 */
export function roleBreakdown(
  responses: readonly SurveyResponse[],
): Array<{ role: number; count: number }> {
  const by = new Map<number, number>();
  for (const r of responses) by.set(r.role, (by.get(r.role) ?? 0) + 1);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([role, count]) => ({ role, count }));
}
