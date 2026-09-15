/**
 * The survey being written, kept across a reload until it is published.
 *
 * Reloads are routine while authoring (wallet popups, extension reloads,
 * toggling emergency direct mode) and a survey is the longest thing typed in
 * the app. The draft is kept per network, like the cart, and leaves storage
 * once the survey is on chain or in the cart, which own it from then on.
 *
 * Only inputs are kept. The sealed reveal round is derived from them and the
 * tip, so it is recomputed after a reload rather than restored stale.
 */

import { ROLE_VALUES } from "cip-179";

import { envNetwork } from "~/config";
import {
  QUESTION_TYPES,
  initDefinitionMeta,
  initQuestionDraft,
  type DefinitionMeta,
  type QuestionDraft,
  type QuestionType,
} from "~/domain/create";

export type DrandMode = "auto" | "manual";

export interface SurveyDraft {
  readonly meta: Omit<DefinitionMeta, "sealedRound">;
  readonly questions: readonly QuestionDraft[];
  readonly drandMode: DrandMode;
  readonly drandRoundText: string;
  /** Whether the end epoch is locked to a governance action's expiry. */
  readonly govLinked: boolean;
}

const storageKey = (): string => `tessera.createDraft.${envNetwork()}`;

/** The form as a first visit shows it. */
export function blankDraft(): SurveyDraft {
  const { sealedRound: _, ...meta } = initDefinitionMeta();
  return {
    meta,
    questions: [initQuestionDraft("singleChoice")],
    drandMode: "auto",
    drandRoundText: "",
    govLinked: false,
  };
}

/** The draft an earlier visit left, if one decodes and has text in it. */
export function loadDraft(): SurveyDraft | undefined {
  let raw: unknown;
  try {
    const text = localStorage.getItem(storageKey());
    if (!text) return undefined;
    raw = JSON.parse(text);
  } catch {
    return undefined; // storage unavailable, or not JSON — start blank
  }
  const draft = decodeDraft(raw);
  return draft && hasText(draft) ? draft : undefined;
}

/** Keep the draft for this network, or clear it when there is none (best-effort). */
export function storeDraft(draft: SurveyDraft | undefined): void {
  try {
    if (draft === undefined || !hasText(draft))
      localStorage.removeItem(storageKey());
    else localStorage.setItem(storageKey(), JSON.stringify(draft));
  } catch {
    // storage unavailable or full — the draft just won't survive a reload
  }
}

/**
 * Whether anything was typed. Choices and numbers are cheap to set again, so a
 * form holding only those is not worth restoring, and clearing every text
 * field clears the draft.
 */
function hasText(draft: SurveyDraft): boolean {
  const typed = (s: string): boolean => s.trim() !== "";
  return (
    typed(draft.meta.title) ||
    typed(draft.meta.description) ||
    draft.questions.some(
      (q) =>
        typed(q.prompt) ||
        q.labels.some(typed) ||
        q.ratingLabels.some(typed) ||
        typed(q.customUri) ||
        typed(q.customHash),
    )
  );
}

type Fields = Record<string, unknown>;

const isFields = (x: unknown): x is Fields =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const oneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T => (values.includes(value as T) ? (value as T) : fallback);

/**
 * `defaults`, with each field taken from `raw` where it has the default's
 * shape: same primitive type, a finite number, or a list of strings. A field
 * added since the draft was stored keeps its default, so the stored format
 * needs no version.
 */
function fit<T extends object>(raw: Fields, defaults: T): T {
  const fields = Object.entries(defaults).map(([key, fallback]) => {
    const v = raw[key];
    const fits = Array.isArray(fallback)
      ? Array.isArray(v) && v.every((x) => typeof x === "string")
      : typeof fallback === "number"
        ? Number.isFinite(v)
        : typeof v === typeof fallback;
    return [key, fits ? v : fallback];
  });
  return Object.fromEntries(fields) as T;
}

/** A stored question, or nothing when its type is not one the builder knows. */
function decodeQuestion(raw: unknown): QuestionDraft[] {
  if (!isFields(raw) || !QUESTION_TYPES.includes(raw.type as QuestionType))
    return [];
  const defaults = initQuestionDraft(raw.type as QuestionType);
  const q = fit(raw, defaults);
  return [
    {
      ...q,
      ratingScale: oneOf(
        q.ratingScale,
        ["numeric", "labels"],
        defaults.ratingScale,
      ),
    },
  ];
}

function decodeDraft(raw: unknown): SurveyDraft | undefined {
  if (!isFields(raw)) return undefined;
  const blank = blankDraft();
  const m = isFields(raw.meta) ? raw.meta : {};
  const meta = fit(m, blank.meta);
  const roles = m.eligibleRoles;
  const questions = Array.isArray(raw.questions)
    ? raw.questions.flatMap(decodeQuestion)
    : [];
  return {
    meta: {
      ...meta,
      eligibleRoles: Array.isArray(roles)
        ? ROLE_VALUES.filter((r) => roles.includes(r))
        : blank.meta.eligibleRoles,
      contentMode: oneOf(
        meta.contentMode,
        ["embedded", "external"],
        blank.meta.contentMode,
      ),
      mode: oneOf(meta.mode, ["public", "sealed"], blank.meta.mode),
    },
    questions: questions.length > 0 ? questions : blank.questions,
    drandMode: oneOf(raw.drandMode, ["auto", "manual"], blank.drandMode),
    drandRoundText:
      typeof raw.drandRoundText === "string"
        ? raw.drandRoundText
        : blank.drandRoundText,
    govLinked:
      typeof raw.govLinked === "boolean" ? raw.govLinked : blank.govLinked,
  };
}
