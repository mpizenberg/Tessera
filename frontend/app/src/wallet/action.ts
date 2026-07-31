/**
 * An action: one thing the user means to publish, and its durable form.
 *
 * Actions are what the app persists — the queued drafts of `./cart.ts` and the
 * contents of each submitted transaction in `./pending.ts` alike. A transaction
 * is disposable (it can stall, be forgotten, be rebuilt from scratch); what the
 * user meant to publish is not, so that is what survives a reload.
 *
 * A CIP-179 action is stored as the label-17 metadatum it publishes, so reading
 * one back runs the same codec — and the same validation — as reading it off
 * the chain. A governance proposal publishes no metadatum and stores its anchor
 * instead.
 */

import {
  decodePayload,
  encodePayload,
  isMetadatum,
  type Cip179Payload,
  type Credential,
  type SurveyCancellation,
  type SurveyDefinition,
  type SurveyResponse,
} from "cip-179";
import {
  bytesToHex,
  credentialKey,
  hexToBytes,
  parseCredentialKey,
  refKey,
} from "cip-179/domain";
import { fromJsonSafe, toJsonSafe } from "cip-179/tally";

/** What kind of submission an action is. */
export type ActionKind = "survey" | "response" | "cancel" | "govAction";

interface ActionBase {
  /**
   * Credentials the transaction must prove control of (CIP-179 credential
   * proof, mechanism A) — never a fee-paying wallet identity, since anyone can
   * pay fees.
   */
  readonly proveCredentials: readonly Credential[];
  /** Human label for the cart and the pending indicator (a survey title). */
  readonly title?: string | undefined;
}

/** One queued thing to publish — the unit a transaction batches. */
export type Action =
  | (ActionBase & {
      readonly kind: "survey";
      readonly definition: SurveyDefinition;
    })
  | (ActionBase & {
      readonly kind: "response";
      readonly response: SurveyResponse;
    })
  | (ActionBase & {
      readonly kind: "cancel";
      readonly cancellation: SurveyCancellation;
    })
  | (ActionBase & {
      readonly kind: "govAction";
      readonly anchorUrl: string;
      readonly anchorDataHash: Uint8Array;
      /** Survey the anchor advertises; a proposal carries no payload to read it from. */
      readonly surveyKey: string | undefined;
    });

/**
 * The survey an action concerns, where that survey already has a key. A
 * definition's is `<its own transaction hash>:<index>`, so it has none until it
 * is submitted.
 */
export function actionSurveyKey(action: Action): string | undefined {
  switch (action.kind) {
    case "survey":
      return undefined;
    case "response":
      return refKey(action.response.surveyRef);
    case "cancel":
      return refKey(action.cancellation);
    case "govAction":
      return action.surveyKey;
  }
}

/**
 * The actions a label-17 payload publishes — one per item it carries. The
 * inverse of the batching a transaction does, for a payload that arrives
 * already encoded (the embeddable widget emits one, and so does storage) rather
 * than assembled action by action.
 */
export function payloadActions(
  payload: Cip179Payload,
  proveCredentials: readonly Credential[],
): Action[] {
  switch (payload.type) {
    case "definitions":
      return payload.definitions.map((definition) => ({
        kind: "survey",
        definition,
        proveCredentials,
      }));
    case "responses":
      return payload.responses.map((response) => ({
        kind: "response",
        response,
        proveCredentials,
      }));
    case "cancellations":
      return payload.cancellations.map((cancellation) => ({
        kind: "cancel",
        cancellation,
        proveCredentials,
      }));
  }
}

// --- durable form -----------------------------------------------------------

/** An action as persisted: JSON-safe, and re-validated on the way back in. */
interface StoredAction {
  readonly kind: ActionKind;
  /** Credentials in their `credentialKey` form. */
  readonly proveCredentials: readonly string[];
  readonly title?: string;
  /** The `toJsonSafe`-encoded label-17 metadatum publishing this one action. */
  readonly payload?: unknown;
  readonly anchorUrl?: string;
  readonly anchorDataHash?: string;
  readonly surveyKey?: string;
}

/** Encode one action for storage. */
export function encodeAction(action: Action): unknown {
  const base = {
    kind: action.kind,
    proveCredentials: action.proveCredentials.map(credentialKey),
    ...(action.title !== undefined && { title: action.title }),
  };
  const stored = (payload: Cip179Payload): unknown =>
    toJsonSafe(encodePayload(payload));
  switch (action.kind) {
    case "survey":
      return {
        ...base,
        payload: stored({
          type: "definitions",
          definitions: [action.definition],
        }),
      };
    case "response":
      return {
        ...base,
        payload: stored({ type: "responses", responses: [action.response] }),
      };
    case "cancel":
      return {
        ...base,
        payload: stored({
          type: "cancellations",
          cancellations: [action.cancellation],
        }),
      };
    case "govAction":
      return {
        ...base,
        anchorUrl: action.anchorUrl,
        anchorDataHash: bytesToHex(action.anchorDataHash),
        ...(action.surveyKey !== undefined && { surveyKey: action.surveyKey }),
      };
  }
}

/**
 * Read one stored action back, or `null` for anything that no longer decodes —
 * a hand-edited entry, or one written by a version that spelled it differently.
 */
export function decodeAction(raw: unknown): Action | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as StoredAction;
  if (!Array.isArray(s.proveCredentials)) return null;
  try {
    const proveCredentials = s.proveCredentials.map(parseCredentialKey);
    const action =
      s.kind === "govAction"
        ? proposalAction(s, proveCredentials)
        : metadataAction(s, proveCredentials);
    if (!action) return null;
    return typeof s.title === "string" ? { ...action, title: s.title } : action;
  } catch {
    return null;
  }
}

function proposalAction(
  s: StoredAction,
  proveCredentials: readonly Credential[],
): Action | null {
  if (typeof s.anchorUrl !== "string" || typeof s.anchorDataHash !== "string") {
    return null;
  }
  return {
    kind: "govAction",
    anchorUrl: s.anchorUrl,
    anchorDataHash: hexToBytes(s.anchorDataHash),
    surveyKey: typeof s.surveyKey === "string" ? s.surveyKey : undefined,
    proveCredentials,
  };
}

function metadataAction(
  s: StoredAction,
  proveCredentials: readonly Credential[],
): Action | null {
  const metadatum = fromJsonSafe(s.payload);
  if (!isMetadatum(metadatum)) return null;
  const actions = payloadActions(decodePayload(metadatum), proveCredentials);
  // The stored payload publishes exactly this one action; anything else was not
  // written by `encodeAction`.
  const only = actions.length === 1 ? actions[0] : undefined;
  return only && only.kind === s.kind ? only : null;
}
