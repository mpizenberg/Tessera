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

import type { Cip179Payload, Credential } from "cip-179";
import { credentialKey } from "cip-179/domain";

import { BASE_TX_BYTES, MAX_TX_BYTES } from "~/domain/fee";
import { actionSurveyKey, type Action, type ActionKind } from "./action";

/** What a planned transaction carries — the two transaction shapes we build. */
export type PlannedBody =
  | { readonly type: "metadata"; readonly payload: Cip179Payload }
  | {
      readonly type: "proposal";
      readonly anchorUrl: string;
      readonly anchorDataHash: Uint8Array;
    };

/** One transaction of a plan. */
export interface PlannedTx {
  readonly body: PlannedBody;
  /** The queued actions it publishes — how a plan maps back onto the cart. */
  readonly actions: readonly Action[];
  readonly proveCredentials: readonly Credential[];
  /**
   * Hashes of transactions already in flight that this one must build on. It
   * spends an output of theirs, so no block can include it without them.
   */
  readonly dependsOn: readonly string[];
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
        },
        actions: [action],
        proveCredentials: action.proveCredentials,
        dependsOn: dependencies([action], ctx),
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
    actions: batch,
    proveCredentials: dedupeCredentials(batch),
    dependsOn: dependencies(batch, ctx),
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
