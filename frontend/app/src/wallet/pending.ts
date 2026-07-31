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

import {
  decodePayload,
  encodePayload,
  isMetadatum,
  type Cip179Payload,
} from "cip-179";
import { hexToBytes, refKey, type SurveyRecord } from "cip-179/domain";
import { fromJsonSafe, toJsonSafe } from "cip-179/tally";

import { envNetwork } from "~/config";

/** What kind of submission a pending transaction carries. */
export type PendingKind = "survey" | "response" | "cancel" | "govAction";

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
  /** Its label-17 payload; a governance proposal carries none. */
  payload: Cip179Payload | undefined;
  /** Survey this transaction concerns, for a contextual "View" link. */
  surveyKey: string | undefined;
  /** Human label (a survey title) shown in the pending indicator. */
  title: string | undefined;
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

/** Which kind of submission this is — a fact about the payload, not a tag. */
export function pendingKind(p: PendingTx): PendingKind {
  switch (p.payload?.type) {
    case "definitions":
      return "survey";
    case "responses":
      return "response";
    case "cancellations":
      return "cancel";
    case undefined:
      return "govAction";
  }
}

/**
 * The survey a payload concerns, when it concerns exactly one — what the
 * pending row's "View survey" link points at. A batch spanning several surveys
 * has no single one to point at.
 */
export function payloadSurveyKey(
  payload: Cip179Payload,
  txHash: string,
): string | undefined {
  switch (payload.type) {
    case "definitions":
      return payload.definitions.length === 1 ? `${txHash}:0` : undefined;
    case "responses": {
      const only = payload.responses.length === 1 ? payload.responses[0] : null;
      return only ? refKey(only.surveyRef) : undefined;
    }
    case "cancellations": {
      const only =
        payload.cancellations.length === 1 ? payload.cancellations[0] : null;
      return only ? refKey(only) : undefined;
    }
  }
}

/**
 * The survey records a pending definitions payload will put on chain — the
 * domain projection Explore and the survey screens overlay on indexed data.
 * Empty for every other kind.
 */
export function pendingSurveyRecords(p: PendingTx): SurveyRecord[] {
  if (p.payload?.type !== "definitions") return [];
  return p.payload.definitions.map((definition, index) => ({
    txHash: p.txHash,
    // Slot and epoch are unknown until the transaction is indexed; neither is
    // surfaced for a freshly published survey.
    slot: 0,
    epochNo: 0,
    ref: { txId: hexToBytes(p.txHash), index },
    definition,
  }));
}

/** `"<txHash>#<index>"` — how UTxOs are matched across wallet and projection. */
export function outrefKey(txHash: string, index: number | bigint): string {
  return `${txHash}#${index}`;
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

// --- persistence ------------------------------------------------------------

const storageKey = (): string => `tessera.pendingTxs.${envNetwork()}`;

/**
 * The durable half of a {@link PendingTx}. Status and the stall flag are not
 * stored: inclusion is re-checked against the chain on the next poll, and the
 * stall clock runs from `submittedAt`.
 */
interface StoredPendingTx {
  readonly txHash: string;
  readonly txCbor: string;
  readonly submittedAt: number;
  readonly surveyKey?: string;
  readonly title?: string;
  /**
   * The label-17 metadatum as submitted, `toJsonSafe`-encoded. Stored in its
   * on-chain form rather than as a decoded payload so reading it back runs the
   * same codec (and the same validation) as reading it off the chain.
   */
  readonly payload?: unknown;
}

/**
 * Read the persisted set. Entries that no longer decode, or that are too old to
 * still be coming, are dropped; everything else comes back `pending` with its
 * stall clock still running from the original submission.
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

  let payload: Cip179Payload | undefined;
  if (s.payload !== undefined) {
    try {
      const metadatum = fromJsonSafe(s.payload);
      if (!isMetadatum(metadatum)) return null;
      payload = decodePayload(metadatum);
    } catch {
      return null;
    }
  }
  return {
    txHash: s.txHash,
    txCbor: s.txCbor,
    payload,
    surveyKey: typeof s.surveyKey === "string" ? s.surveyKey : undefined,
    title: typeof s.title === "string" ? s.title : undefined,
    submittedAt: s.submittedAt,
    status: "pending",
    stalled: now - s.submittedAt > STALL_AFTER_MS,
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
    ...(p.surveyKey !== undefined && { surveyKey: p.surveyKey }),
    ...(p.title !== undefined && { title: p.title }),
    ...(p.payload !== undefined && {
      payload: toJsonSafe(encodePayload(p.payload)),
    }),
  };
}
