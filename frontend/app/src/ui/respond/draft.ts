/**
 * Unsent answers, kept across a reload until they are submitted or queued.
 *
 * The answering spine writes every edit to the stash it is given; this is the
 * one the app gives it, so a reload (routine here: wallet popups, extension
 * reloads, emergency direct mode) brings the answers back. A survey's form is
 * filed beside its Pro rationale, and the entry goes once the survey has ended,
 * since nothing can be sent to it any more.
 *
 * Sealed-survey answers are kept like any others: sealing hides them on chain,
 * and this storage never leaves the device.
 */

import type { DraftStash } from "cardano-tessera-respond-ui";

import { envNetwork } from "~/config";
import { readJson, writeJson } from "~/storage";
import type { RationaleInputs } from "./Rationale";

const storageKey = (): string => `tessera.responseDrafts.${envNetwork()}`;

/** One survey's kept state. The form is the spine's plain JSON, checked on read. */
interface SurveyEntry {
  endEpoch: number;
  form?: unknown;
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
  const update = (key: string, change: (entry: SurveyEntry) => void): void => {
    const endEpoch = survey.endEpoch();
    if (endEpoch === undefined) return;
    const kept = read();
    const entry = kept[key] ?? { endEpoch };
    change(entry);
    kept[key] = entry;
    write(kept, survey.tipEpoch());
  };

  return {
    stash: {
      get: (key) => read()[key]?.form,
      set: (key, form) =>
        update(key, (entry) => {
          entry.form = form;
        }),
      delete: (key) =>
        update(key, (entry) => {
          delete entry.form;
        }),
    },
    loadRationale: () => read()[survey.key()]?.rationale,
    storeRationale: (inputs) =>
      update(survey.key(), (entry) => {
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
    if (!isFields(entry) || !Number.isInteger(entry.endEpoch)) continue;
    const rationale = decodeRationale(entry.rationale);
    kept[key] = {
      endEpoch: entry.endEpoch as number,
      ...(entry.form !== undefined ? { form: entry.form } : {}),
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
    const empty = entry.form === undefined && entry.rationale === undefined;
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
