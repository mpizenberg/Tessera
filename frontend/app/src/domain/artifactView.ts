/**
 * Pure presentation model for a final tally artifact (`TallyArtifact`): the
 * exact decimal-string aggregates become render-ready structures. This is the
 * ONLY place floats appear — derived here from exact integers, never stored:
 * fractions via `Number(x * 10_000n / max) / 10_000`, means likewise. No
 * framework, no I/O; unit-testable in isolation.
 */

import type { Question, Role, SurveyDefinition, SurveyResponse } from "cip-179";

import {
  optionLabelOf,
  parseCredentialKey,
  responderAnswers,
  toArtifactQuestions,
  weightedTallySurvey,
} from "@tessera/core";
import type {
  ArtifactResponder,
  ArtifactQuestion,
  ArtifactRoleTally,
  TallyArtifact,
  WeightedResponder,
} from "@tessera/core";

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

export interface WeightedBarView {
  readonly label: string;
  readonly weight: bigint;
  readonly count: number;
  /** Fill fraction 0–1, relative to the leading bar. */
  readonly frac: number;
}

export interface WeightedRowView {
  readonly label: string;
  /** Weighted mean, or null when nothing backs it. */
  readonly avg: number | null;
  readonly count: number;
}

export type WeightedQuestionView =
  | {
      readonly kind: "bars";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      readonly bars: readonly WeightedBarView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "histogram";
      readonly bins: readonly WeightedBarView[];
      /** Weighted mean of the numeric values, or null with no answers. */
      readonly mean: number | null;
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "rows";
      readonly unit: "points" | "rating";
      readonly rows: readonly WeightedRowView[];
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    }
  | {
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: bigint;
    };

/**
 * The two ways the same artifact is presented (`Survey` screen switch). Both
 * range over the artifact's *counted set* — the proof-validated responders it
 * committed to — differing only in the weight each responder carries:
 *
 * - `"chain"`: each responder's snapshotted stake / voting power (lovelace);
 *   turnout against the role's electorate total is meaningful.
 * - `"one"`: every responder weighs `1` (one credential, one vote); there is
 *   no ada total, so voting-weight and turnout are omitted.
 */
export type Weighting = "chain" | "one";

/** An on-chain response, keyed for joining back to an artifact responder. */
export interface CountedResponse {
  readonly txHash: string;
  readonly responseIndex: number;
  readonly response: SurveyResponse;
}

export interface RoleResultView {
  readonly role: number;
  /** Counted responders for this role. */
  readonly responderCount: number;
  /**
   * Σ counted responder weights (lovelace) in `"chain"` weighting; `null` in
   * `"one"` weighting and for count-only roles, where the count is the story.
   */
  readonly votedWeight: bigint | null;
  /** The role's electorate total, or null (count-only roles / one-vote). */
  readonly total: bigint | null;
  /** votedWeight / total, or null when there is no meaningful total. */
  readonly turnout: number | null;
  readonly questions: readonly WeightedQuestionView[];
}

function barViews(
  labels: readonly string[],
  weights: readonly bigint[],
  counts: readonly number[],
): WeightedBarView[] {
  const max = weights.reduce((a, b) => (b > a ? b : a), 0n);
  return labels.map((label, i) => ({
    label,
    weight: weights[i] ?? 0n,
    count: counts[i] ?? 0,
    frac: fracOf(weights[i] ?? 0n, max),
  }));
}

export function weightedQuestionView(
  q: Question | undefined,
  aq: ArtifactQuestion,
): WeightedQuestionView {
  switch (aq.kind) {
    case "options": {
      const weights = aq.optionWeights.map(BigInt);
      const labels = weights.map((_, i) => optionLabelOf(q, i));
      return {
        kind: "bars",
        unit: aq.unit,
        bars: barViews(labels, weights, aq.optionCounts),
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    }
    case "numeric": {
      const answeredWeight = BigInt(aq.answeredWeight);
      const weights = aq.values.map((v) => BigInt(v.weight));
      return {
        kind: "histogram",
        bins: barViews(
          aq.values.map((v) => v.value),
          weights,
          aq.values.map((v) => v.count),
        ),
        mean: ratioOf(BigInt(aq.weightedSum), answeredWeight),
        answeredCount: aq.answeredCount,
        answeredWeight,
      };
    }
    case "perOption":
      return {
        kind: "rows",
        unit: aq.unit,
        rows: aq.perOption.map((o, i) => ({
          label: optionLabelOf(q, i),
          avg: ratioOf(BigInt(o.weightedSum), BigInt(o.answeredWeight)),
          count: o.count,
        })),
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
    case "custom":
      return {
        kind: "custom",
        answeredCount: aq.answeredCount,
        answeredWeight: BigInt(aq.answeredWeight),
      };
  }
}

/**
 * Chain-weighted view of one role: the artifact's committed aggregates as-is,
 * with turnout derived from the stored electorate total. Byte-authoritative —
 * these are the exact numbers the content hash commits to.
 */
function chainRoleView(
  role: ArtifactRoleTally,
  def: SurveyDefinition,
): RoleResultView {
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
    questions: role.questions.map((aq, i) =>
      weightedQuestionView(def.questions[i], aq),
    ),
  };
}

/**
 * Resolve a counted responder's answers for the one-vote re-tally. Sealed
 * artifacts commit each responder's revealed answers (`responder.answers`),
 * which we synthesize back into a public `SurveyResponse` — the on-chain
 * response is only a ciphertext, so a chain rejoin would tally nothing. Public
 * (and legacy) artifacts commit no answers, so fall back to the on-chain
 * response by `(txHash, responseIndex)`.
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
 * One-vote view of one role: the same counted responders re-tallied with every
 * weight set to 1. Answers come from the responder's committed revealed answers
 * (sealed) or a rejoin from the on-chain responses (public/legacy) — see
 * {@link responderResponse}; a responder with neither is dropped from the
 * aggregate (can't happen for a finalized on-chain survey).
 */
function oneVoteRoleView(
  role: ArtifactRoleTally,
  def: SurveyDefinition,
  byKey: ReadonlyMap<string, SurveyResponse>,
): RoleResultView {
  const responders: WeightedResponder[] = [];
  for (const r of role.responders) {
    const response = responderResponse(r, role.role, def, byKey);
    if (response)
      responders.push({
        credentialKey: r.credential,
        weight: 1n,
        txHash: r.txHash,
        responseIndex: r.responseIndex,
        response,
      });
  }
  return {
    role: role.role,
    responderCount: role.responders.length,
    votedWeight: null,
    total: null,
    turnout: null,
    questions: toArtifactQuestions(weightedTallySurvey(def, responders)).map(
      (aq, i) => weightedQuestionView(def.questions[i], aq),
    ),
  };
}

/**
 * Per-role render models under the chosen `weighting`, in the artifact's
 * (role-ascending) order. `responses` are the survey's on-chain responses,
 * needed only to rejoin answers for the `"one"` weighting.
 */
export function resultRoleViews(
  artifact: TallyArtifact,
  def: SurveyDefinition,
  responses: readonly CountedResponse[],
  weighting: Weighting,
): RoleResultView[] {
  if (weighting === "chain") {
    return artifact.tally.perRole.map((r) => chainRoleView(r, def));
  }
  const byKey = new Map<string, SurveyResponse>();
  for (const r of responses) {
    byKey.set(`${r.txHash}|${r.responseIndex}`, r.response);
  }
  return artifact.tally.perRole.map((r) => oneVoteRoleView(r, def, byKey));
}
