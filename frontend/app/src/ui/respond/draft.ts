/**
 * Unsent answers, kept across a reload until they are submitted or queued.
 *
 * The answering spine writes every edit to the stash it is given; this is the
 * one the app gives it, so a reload (routine here: wallet popups, extension
 * reloads, emergency direct mode) brings the answers back. Forms are filed per
 * survey beside the survey's Pro rationale, and a survey's entry goes once the
 * survey has ended, since nothing can be sent to it any more.
 *
 * Sealed-survey answers are kept like any others: sealing hides them on chain,
 * and this storage never leaves the device.
 */

import type { Question } from "cip-179";
import { fromJsonSafe, toJsonSafe } from "cip-179/tally";
import {
  optionCount,
  type Draft,
  type DraftValue,
} from "cardano-tessera-respond-core";
import type { DraftStash } from "cardano-tessera-respond-ui";

import { envNetwork } from "~/config";
import type { RationaleInputs } from "./Rationale";

const storageKey = (): string => `tessera.responseDrafts.${envNetwork()}`;

/** One survey's kept state. Forms stay `toJsonSafe`-encoded until read. */
interface SurveyEntry {
  endEpoch: number;
  forms: Record<string, unknown>;
  rationale?: RationaleInputs;
}

type Kept = Record<string, SurveyEntry>;

export interface ResponseDrafts {
  /** The stash for the answering spine, filed under this survey. */
  readonly stash: DraftStash;
  readonly loadRationale: () => RationaleInputs | undefined;
  /** Keep the rationale, or forget it when `undefined` or empty (best-effort). */
  readonly storeRationale: (inputs: RationaleInputs | undefined) => void;
}

/**
 * Kept state for the survey a screen answers. Writing needs `endEpoch`, so it
 * waits for the survey to load; reading needs only the key, so a reload can
 * restore before it has.
 */
export function responseDrafts(survey: {
  readonly key: () => string;
  readonly endEpoch: () => number | undefined;
  readonly tipEpoch: () => number | undefined;
}): ResponseDrafts {
  const update = (change: (entry: SurveyEntry) => void): void => {
    const endEpoch = survey.endEpoch();
    if (endEpoch === undefined) return;
    const kept = read();
    const entry = kept[survey.key()] ?? { endEpoch, forms: {} };
    change(entry);
    kept[survey.key()] = entry;
    write(kept, survey.tipEpoch());
  };

  return {
    stash: {
      get: (formKey, questions) => {
        const form = read()[survey.key()]?.forms[formKey];
        return form === undefined ? undefined : decodeForm(form, questions);
      },
      set: (formKey, drafts) =>
        update((entry) => {
          entry.forms[formKey] = toJsonSafe(drafts);
        }),
      delete: (formKey) =>
        update((entry) => {
          delete entry.forms[formKey];
        }),
    },
    loadRationale: () => read()[survey.key()]?.rationale,
    storeRationale: (inputs) =>
      update((entry) => {
        if (inputs && hasText(inputs)) entry.rationale = inputs;
        else delete entry.rationale;
      }),
  };
}

function read(): Kept {
  let raw: unknown;
  try {
    const text = localStorage.getItem(storageKey());
    if (!text) return {};
    raw = JSON.parse(text);
  } catch {
    return {}; // storage unavailable, or not JSON — nothing kept
  }
  const kept: Kept = {};
  if (!isFields(raw)) return kept;
  for (const [key, entry] of Object.entries(raw)) {
    if (
      !isFields(entry) ||
      !Number.isInteger(entry.endEpoch) ||
      !isFields(entry.forms)
    )
      continue;
    const rationale = decodeRationale(entry.rationale);
    kept[key] = {
      endEpoch: entry.endEpoch as number,
      forms: entry.forms,
      ...(rationale ? { rationale } : {}),
    };
  }
  return kept;
}

/**
 * Store `kept` without the entries left with nothing in them, or whose survey
 * has ended. While the tip is unknown nothing counts as ended.
 */
function write(kept: Kept, tipEpoch: number | undefined): void {
  for (const [key, entry] of Object.entries(kept)) {
    const ended = tipEpoch !== undefined && entry.endEpoch < tipEpoch;
    const empty =
      Object.keys(entry.forms).length === 0 && entry.rationale === undefined;
    if (ended || empty) delete kept[key];
  }
  try {
    if (Object.keys(kept).length === 0) localStorage.removeItem(storageKey());
    else localStorage.setItem(storageKey(), JSON.stringify(kept));
  } catch {
    // storage unavailable or full — the answers just won't survive a reload
  }
}

type Fields = Record<string, unknown>;

const isFields = (x: unknown): x is Fields =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const hasText = (r: RationaleInputs): boolean =>
  [r.text, r.uri, r.hash].some((s) => s.trim() !== "");

function decodeRationale(raw: unknown): RationaleInputs | undefined {
  if (
    !isFields(raw) ||
    typeof raw.on !== "boolean" ||
    (raw.mode !== "write" && raw.mode !== "manual") ||
    typeof raw.text !== "string" ||
    typeof raw.uri !== "string" ||
    typeof raw.hash !== "string"
  )
    return undefined;
  const { on, mode, text, uri, hash } = raw;
  return { on, mode, text, uri, hash };
}

/**
 * A kept form, or nothing unless every question's draft fits it. A definition
 * cannot change under a survey reference, so a misfit is damage, and half a
 * form restored is worse than none.
 */
function decodeForm(
  raw: unknown,
  questions: readonly Question[],
): Draft[] | undefined {
  let form: unknown;
  try {
    form = fromJsonSafe(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(form) || form.length !== questions.length)
    return undefined;
  const drafts: Draft[] = [];
  for (const [i, q] of questions.entries()) {
    const d: unknown = form[i];
    if (!isFields(d) || typeof d.skipped !== "boolean") return undefined;
    const value = decodeValue(q, d.value);
    if (!value) return undefined;
    drafts.push({ skipped: d.skipped, value });
  }
  return drafts;
}

const isIndex = (x: unknown, count: number): x is number =>
  Number.isInteger(x) && (x as number) >= 0 && (x as number) < count;

const isIndexSet = (xs: unknown, count: number): xs is number[] =>
  Array.isArray(xs) &&
  xs.every((x) => isIndex(x, count)) &&
  new Set(xs).size === xs.length;

function decodeValue(q: Question, raw: unknown): DraftValue | undefined {
  if (!isFields(raw)) return undefined;
  switch (q.type) {
    case "singleChoice": {
      const i = raw.optionIndex;
      return raw.type === "singleChoice" &&
        (i === null || isIndex(i, optionCount(q.options)))
        ? { type: "singleChoice", optionIndex: i }
        : undefined;
    }
    case "multiSelect":
      return raw.type === "multiSelect" &&
        (raw.selected === null ||
          isIndexSet(raw.selected, optionCount(q.options)))
        ? { type: "multiSelect", selected: raw.selected }
        : undefined;
    case "ranking":
      return raw.type === "ranking" &&
        isIndexSet(raw.ranked, optionCount(q.options))
        ? { type: "ranking", ranked: raw.ranked }
        : undefined;
    case "numericRange":
      return raw.type === "numeric" &&
        (raw.value === null || typeof raw.value === "bigint")
        ? { type: "numeric", value: raw.value }
        : undefined;
    case "pointsAllocation": {
      const points = raw.points;
      return raw.type === "pointsAllocation" &&
        Array.isArray(points) &&
        points.length === optionCount(q.options) &&
        points.every(Number.isInteger)
        ? { type: "pointsAllocation", points }
        : undefined;
    }
    case "rating": {
      const ratings = raw.ratings;
      return raw.type === "rating" &&
        Array.isArray(ratings) &&
        ratings.length === optionCount(q.options) &&
        ratings.every((r) => r === null || typeof r === "bigint")
        ? { type: "rating", ratings }
        : undefined;
    }
    case "custom":
      return raw.type === "custom" && typeof raw.text === "string"
        ? { type: "custom", text: raw.text }
        : undefined;
  }
}
