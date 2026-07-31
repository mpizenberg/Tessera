/**
 * The pending-transaction set — transactions this browser submitted that the
 * chain has not visibly confirmed yet.
 *
 * Cardano is deterministic: a signed transaction already fixes its hash, the
 * inputs it consumes and the outputs it creates. Retaining the signed CBOR (not
 * just the hash) turns that into two projections the app reads as if they were
 * chain state — the projected UTxO set in `./submit.ts`, so consecutive submits
 * cannot select the same input twice, and the optimistic survey overlay in
 * `~/state`. It also makes a stalled transaction resubmittable byte for byte,
 * which is idempotent: same bytes, same hash.
 *
 * The set is persisted per network. Reloads are routine (toggling emergency
 * direct mode reloads the page) and CIP-30 wallets differ in whether they
 * account for their own in-flight spends.
 */

import { hexToBytes, type SurveyRecord } from "cip-179/domain";

import { envNetwork } from "~/config";
import {
  actionSurveyKey,
  decodeAction,
  encodeAction,
  type Action,
  type ActionKind,
} from "./action";

/**
 * `pending` until the chain shows it, `confirmed` while the user is told, then
 * `done`: no longer announced, but still projected until the indexer serves
 * what it published.
 */
export type PendingStatus = "pending" | "confirmed" | "done";

/** A submitted transaction, and everything the projections read off it. */
export interface PendingTx {
  txHash: string;
  /** The signed transaction — resubmittable byte for byte while it stalls. */
  txCbor: string;
  /**
   * What it publishes, never empty. Forgetting the transaction returns these to
   * the cart, so they outlive it.
   */
  actions: readonly Action[];
  submittedAt: number;
  status: PendingStatus;
  /** Set once the transaction has stayed unconfirmed past {@link STALL_AFTER_MS}. */
  stalled: boolean;
}

/**
 * How long a transaction may stay unconfirmed before the app treats it as
 * stalled and offers to rebroadcast or forget it. Transactions carry no ledger
 * TTL, so this is an app-level deadline, not an expiry: a stalled transaction
 * can still be included later.
 */
export const STALL_AFTER_MS = 10 * 60_000;

/**
 * Entries older than this are dropped when the set is loaded. Nothing
 * unconfirmed for a day is still coming, and a projection that keeps
 * subtracting its inputs would shrink the wallet forever.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Which kind of submission this is — a transaction carries only one. */
export function pendingKind(p: PendingTx): ActionKind {
  return p.actions[0]!.kind;
}

/** The one action this transaction carries, when it carries exactly one. */
function loneAction(p: PendingTx): Action | undefined {
  return p.actions.length === 1 ? p.actions[0] : undefined;
}

/** Human label for the pending row — only a lone action lends the row its own. */
export function pendingTitle(p: PendingTx): string | undefined {
  return loneAction(p)?.title;
}

/**
 * The survey this transaction concerns, when it concerns exactly one — what the
 * pending row's "View survey" link points at. A batch spanning several surveys
 * has no single one to point at; a definition names the transaction publishing
 * it, which is this one.
 */
export function pendingSurveyKey(p: PendingTx): string | undefined {
  const only = loneAction(p);
  if (!only) return undefined;
  return only.kind === "survey" ? `${p.txHash}:0` : actionSurveyKey(only);
}

/**
 * The survey records this transaction will put on chain — the domain projection
 * Explore and the survey screens overlay on indexed data. Empty for every kind
 * but a definition.
 */
export function pendingSurveyRecords(p: PendingTx): SurveyRecord[] {
  return p.actions
    .filter((a) => a.kind === "survey")
    .map((a, index) => ({
      txHash: p.txHash,
      // Slot and epoch are unknown until the transaction is indexed; neither is
      // surfaced for a freshly published survey.
      slot: 0,
      epochNo: 0,
      ref: { txId: hexToBytes(p.txHash), index },
      definition: a.definition,
    }));
}

/** `"<txHash>#<index>"` — how UTxOs are matched across wallet and projection. */
export function outrefKey(txHash: string, index: number | bigint): string {
  return `${txHash}#${index}`;
}

/** What one in-flight transaction does to the wallet's UTxO set. */
export interface TxFlow {
  readonly txHash: string;
  readonly spent: readonly string[];
  /** Outrefs it creates at the wallet's own addresses — the rest are unspendable here. */
  readonly produced: readonly string[];
}

/**
 * How a set of pending transactions rewrites a wallet's UTxO set: `drop` are
 * outrefs they consume, `add` are outrefs they create that the wallet doesn't
 * already hold. `produced` must already be narrowed to outputs at the wallet's
 * own addresses.
 *
 * The two exclusions carry the whole subtlety: an output the wallet already
 * lists is one the chain confirmed and the wallet indexed, so offering it again
 * would present the same UTxO twice; and an output a *later* pending
 * transaction already spends is gone before it ever becomes selectable.
 */
export function projectOutrefs(
  walletOutrefs: Iterable<string>,
  txs: readonly {
    readonly spent: readonly string[];
    readonly produced: readonly string[];
  }[],
): { readonly drop: ReadonlySet<string>; readonly add: ReadonlySet<string> } {
  const drop = new Set<string>();
  for (const tx of txs) for (const key of tx.spent) drop.add(key);
  const held = new Set(walletOutrefs);
  const add = new Set<string>();
  for (const tx of txs) {
    for (const key of tx.produced) {
      if (!held.has(key) && !drop.has(key)) add.add(key);
    }
  }
  return { drop, add };
}

/**
 * Outrefs that can exist only if `parentTxHash` is included: the outputs it
 * creates, plus what transactions spending those create, and so on. Spending
 * any one of them ties the spender's fate to the parent's.
 *
 * The walk has to be transitive because an intervening submission may already
 * have consumed the parent's change — that submission then depends on the
 * parent itself, so its own outputs carry the same guarantee.
 */
export function descendantOutrefs(
  parentTxHash: string,
  txs: readonly TxFlow[],
): ReadonlySet<string> {
  const reachable = new Set<string>();
  for (const tx of txs) {
    if (tx.txHash !== parentTxHash) continue;
    for (const key of tx.produced) reachable.add(key);
  }
  // Fixpoint rather than one pass: the set is not held in dependency order.
  let grew = true;
  while (grew) {
    grew = false;
    for (const tx of txs) {
      if (!tx.spent.some((key) => reachable.has(key))) continue;
      for (const key of tx.produced) {
        if (!reachable.has(key)) {
          reachable.add(key);
          grew = true;
        }
      }
    }
  }
  return reachable;
}

// --- persistence ------------------------------------------------------------

const storageKey = (): string => `tessera.pendingTxs.${envNetwork()}`;

/**
 * The durable half of a {@link PendingTx}. The stall flag is not stored — its
 * clock runs from `submittedAt` — but inclusion is: asking the chain again
 * about a transaction it has already shown can only get the same answer.
 */
interface StoredPendingTx {
  readonly txHash: string;
  readonly txCbor: string;
  readonly submittedAt: number;
  readonly actions: readonly unknown[];
  /** Whether the chain showed it before the app was last closed. */
  readonly confirmed: boolean;
}

/**
 * Read the persisted set. Entries that no longer decode, or that are too old to
 * still be coming, are dropped. What the chain had not shown comes back
 * `pending`, with its stall clock still running from the original submission;
 * what it had comes back `done` — not announced a second time, and not
 * re-checked, but still projected until the indexer serves what it published.
 */
export function loadPendingTxs(now: number = Date.now()): PendingTx[] {
  let raw: unknown;
  try {
    const text = localStorage.getItem(storageKey());
    if (!text) return [];
    raw = JSON.parse(text);
  } catch {
    return []; // storage unavailable, or not JSON — start empty
  }
  if (!Array.isArray(raw)) return [];
  const txs: PendingTx[] = [];
  for (const entry of raw) {
    const tx = revive(entry, now);
    if (tx) txs.push(tx);
  }
  return txs;
}

function revive(entry: unknown, now: number): PendingTx | null {
  if (entry === null || typeof entry !== "object") return null;
  const s = entry as StoredPendingTx;
  if (typeof s.txHash !== "string" || typeof s.txCbor !== "string") return null;
  if (typeof s.submittedAt !== "number") return null;
  if (now - s.submittedAt > MAX_AGE_MS) return null;
  if (!Array.isArray(s.actions)) return null;

  const actions: Action[] = [];
  for (const raw of s.actions) {
    const action = decodeAction(raw);
    // Half a transaction's contents would misreport what it publishes, and the
    // half that survived would come back to the cart alone if it were forgotten.
    if (!action) return null;
    actions.push(action);
  }
  if (actions.length === 0) return null;

  // Absent in entries written before confirmation was stored: re-checking those
  // costs one poll and settles them.
  const confirmed = s.confirmed === true;
  return {
    txHash: s.txHash,
    txCbor: s.txCbor,
    actions,
    submittedAt: s.submittedAt,
    status: confirmed ? "done" : "pending",
    stalled: !confirmed && now - s.submittedAt > STALL_AFTER_MS,
  };
}

/** Persist the set for this network (best-effort). */
export function storePendingTxs(txs: readonly PendingTx[]): void {
  try {
    if (txs.length === 0) localStorage.removeItem(storageKey());
    else localStorage.setItem(storageKey(), JSON.stringify(txs.map(toStored)));
  } catch {
    // storage unavailable or full — the set just won't survive a reload
  }
}

function toStored(p: PendingTx): StoredPendingTx {
  return {
    txHash: p.txHash,
    txCbor: p.txCbor,
    submittedAt: p.submittedAt,
    actions: p.actions.map(encodeAction),
    // Every status but `pending` is reached by the chain showing the
    // transaction — dismissing a row is only offered once it has.
    confirmed: p.status !== "pending",
  };
}
