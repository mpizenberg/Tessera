/**
 * The cart — actions the user has queued but not yet published.
 *
 * Queuing is what makes batching and chaining possible: several responses ride
 * in one transaction, and a cancellation follows the definition it concerns.
 * The queue is persisted per network because a draft that a page reload
 * silently drops is worse than no queue at all, and reloads are routine here
 * (toggling emergency direct mode reloads the page).
 *
 * Actions leave the cart only when the transaction publishing them has been
 * submitted, so a refused signature or a rejected submission leaves them
 * exactly where they were.
 */

import { envNetwork } from "~/config";
import { decodeAction, encodeAction, type Action } from "./action";

const storageKey = (): string => `tessera.cart.${envNetwork()}`;

/** Read the queue back, dropping entries that no longer decode. */
export function loadCart(): Action[] {
  let raw: unknown;
  try {
    const text = localStorage.getItem(storageKey());
    if (!text) return [];
    raw = JSON.parse(text);
  } catch {
    return []; // storage unavailable, or not JSON — start empty
  }
  if (!Array.isArray(raw)) return [];
  const actions: Action[] = [];
  for (const entry of raw) {
    const action = decodeAction(entry);
    if (action) actions.push(action);
  }
  return actions;
}

/** Persist the queue for this network (best-effort). */
export function storeCart(actions: readonly Action[]): void {
  try {
    if (actions.length === 0) localStorage.removeItem(storageKey());
    else
      localStorage.setItem(
        storageKey(),
        JSON.stringify(actions.map(encodeAction)),
      );
  } catch {
    // storage unavailable or full — the queue just won't survive a reload
  }
}
