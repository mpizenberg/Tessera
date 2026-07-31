/**
 * Turning a queue of actions into the transactions that publish them.
 *
 * CIP-179 allows one event kind per label-17 payload, so a definition and a
 * response can never share a transaction; a governance proposal is a different
 * transaction type again and never batches with anything. What is left is free
 * to batch, up to the ledger's maximum transaction size.
 *
 * What cannot be batched can still be *chained*. An action about a survey whose
 * defining transaction is still in flight names that transaction as a
 * dependency, and the builder makes the new transaction spend an output that
 * exists only if it was included — so no block can carry a response without the
 * survey it answers.
 *
 * Pure and synchronous. Measuring a payload is the one step that needs a CBOR
 * encoder, and it is injected, so this module names no serialization library.
 */

import type {
  Cip179Payload,
  Credential,
  SurveyCancellation,
  SurveyDefinition,
  SurveyResponse,
} from "cip-179";
import { credentialKey, refKey } from "cip-179/domain";

import { BASE_TX_BYTES, MAX_TX_BYTES } from "~/domain/fee";

/** What kind of submission an action is. */
export type ActionKind = "survey" | "response" | "cancel" | "govAction";

interface ActionBase {
  /**
   * Credentials the transaction must prove control of (CIP-179 credential
   * proof, mechanism A) — never a fee-paying wallet identity, since anyone can
   * pay fees.
   */
  readonly proveCredentials: readonly Credential[];
  /** Human label for the pending indicator, for payloads that carry none. */
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
 * inverse of what the planner does, for a payload that arrives already encoded
 * (the embeddable widget emits one) rather than assembled action by action.
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

/** What a planned transaction carries — the two transaction shapes we build. */
export type PlannedBody =
  | { readonly type: "metadata"; readonly payload: Cip179Payload }
  | {
      readonly type: "proposal";
      readonly anchorUrl: string;
      readonly anchorDataHash: Uint8Array;
      readonly surveyKey: string | undefined;
    };

/** One transaction of a plan. */
export interface PlannedTx {
  readonly body: PlannedBody;
  readonly proveCredentials: readonly Credential[];
  /**
   * Hashes of transactions already in flight that this one must build on. It
   * spends an output of theirs, so no block can include it without them.
   */
  readonly dependsOn: readonly string[];
  readonly title: string | undefined;
}

export interface PlanContext {
  /**
   * Surveys whose defining transaction has not been confirmed yet, mapped to
   * it. Anything about one of those surveys has to chain onto its definition.
   */
  readonly definingTx: ReadonlyMap<string, string>;
  /** Serialized byte size of a label-17 payload — the CBOR encoder, injected. */
  readonly measure: (payload: Cip179Payload) => number;
}

/**
 * Partition `actions` into transactions, deterministically: definitions first
 * (a survey has to exist before anything can be said about it), then responses,
 * cancellations, and finally one transaction per governance proposal.
 */
export function plan(
  actions: readonly Action[],
  ctx: PlanContext,
): PlannedTx[] {
  return [
    ...metadataTxs(
      ofKind(actions, "survey"),
      (batch) => ({
        type: "definitions",
        definitions: batch.map((a) => a.definition),
      }),
      ctx,
    ),
    ...metadataTxs(
      ofKind(actions, "response"),
      (batch) => ({
        type: "responses",
        responses: batch.map((a) => a.response),
      }),
      ctx,
    ),
    ...metadataTxs(
      ofKind(actions, "cancel"),
      (batch) => ({
        type: "cancellations",
        cancellations: batch.map((a) => a.cancellation),
      }),
      ctx,
    ),
    ...ofKind(actions, "govAction").map(
      (action): PlannedTx => ({
        body: {
          type: "proposal",
          anchorUrl: action.anchorUrl,
          anchorDataHash: action.anchorDataHash,
          surveyKey: action.surveyKey,
        },
        proveCredentials: action.proveCredentials,
        dependsOn: dependencies([action], ctx),
        title: action.title,
      }),
    ),
  ];
}

function ofKind<K extends ActionKind>(
  actions: readonly Action[],
  kind: K,
): Extract<Action, { kind: K }>[] {
  return actions.filter(
    (a): a is Extract<Action, { kind: K }> => a.kind === kind,
  );
}

function metadataTxs<A extends Action>(
  actions: readonly A[],
  wrap: (batch: readonly A[]) => Cip179Payload,
  ctx: PlanContext,
): PlannedTx[] {
  return pack(actions, wrap, ctx.measure).map((batch) => ({
    body: { type: "metadata", payload: wrap(batch) },
    proveCredentials: dedupeCredentials(batch),
    dependsOn: dependencies(batch, ctx),
    // A batch spanning several actions has no single one to label the row with.
    title: batch.length === 1 ? batch[0]!.title : undefined,
  }));
}

/**
 * Fill transactions greedily up to the ledger's size limit. An action too large
 * to fit anywhere still gets a transaction of its own: the builder is where an
 * oversized payload is reported, not here.
 */
function pack<A>(
  actions: readonly A[],
  wrap: (batch: readonly A[]) => Cip179Payload,
  measure: (payload: Cip179Payload) => number,
): A[][] {
  const batches: A[][] = [];
  let current: A[] = [];
  for (const action of actions) {
    const grown = [...current, action];
    if (
      current.length > 0 &&
      measure(wrap(grown)) + BASE_TX_BYTES > MAX_TX_BYTES
    ) {
      batches.push(current);
      current = [action];
    } else {
      current = grown;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function dependencies(
  batch: readonly Action[],
  ctx: PlanContext,
): readonly string[] {
  const hashes = new Set<string>();
  for (const action of batch) {
    const key = actionSurveyKey(action);
    const parent = key === undefined ? undefined : ctx.definingTx.get(key);
    if (parent !== undefined) hashes.add(parent);
  }
  return [...hashes];
}

function dedupeCredentials(batch: readonly Action[]): readonly Credential[] {
  const byKey = new Map<string, Credential>();
  for (const action of batch) {
    for (const cred of action.proveCredentials) {
      byKey.set(credentialKey(cred), cred);
    }
  }
  return [...byKey.values()];
}
