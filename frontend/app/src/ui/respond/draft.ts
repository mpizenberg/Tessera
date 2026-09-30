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

import type { DraftStash } from "cardano-tessera-respond-ui";

import { envNetwork } from "~/config";
import { readJson, writeJson } from "~/storage";
import type { RationaleInputs } from "./Rationale";

const storageKey = (): string => `tessera.responseDrafts.${envNetwork()}`;

/** One survey's kept state. Forms are the spine's plain JSON, checked on read. */
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
      get: (formKey) => read()[survey.key()]?.forms[formKey],
      set: (formKey, form) =>
        update((entry) => {
          entry.forms[formKey] = form;
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
  const raw = readJson(storageKey());
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
  writeJson(storageKey(), Object.keys(kept).length === 0 ? undefined : kept);
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
