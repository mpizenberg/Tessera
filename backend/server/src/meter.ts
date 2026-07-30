/**
 * Upstream request metering: count requests by the budget they spend, then
 * drain the counts into `upstream_tally`.
 *
 * Three budgets, three kinds, because they are three separate quotas — the
 * operator's Koios account, the segregated account behind `/api/tx_status`, and
 * whatever hosts serve governance anchor documents. Folding them into one
 * number makes every comparison against a limit wrong in one direction or the
 * other.
 *
 * A meter's lifetime is whatever produces a coherent batch of writes. The
 * refresh builds one per run and drains it once at the end; the serving tier
 * keeps one for the app and drains it after each request, where the write still
 * lands inside the request's lifetime — a Worker may cancel work started after
 * a response is returned.
 */

import {
  sumUpstream,
  zeroUpstream,
  type HealthStore,
  type UpstreamKind,
  type UpstreamTotals,
} from "./store";

export interface UpstreamMeter {
  /** An `onRequest` hook charging every request it sees to `kind`. */
  hook(kind: UpstreamKind): () => void;
  /** What has been counted since the last drain. */
  counted(): UpstreamTotals;
  /**
   * Write what's counted into the bucket containing `nowSec` and reset. Writes
   * nothing when nothing was counted, so a request that served from cache costs
   * no storage.
   */
  drain(nowSec: number): Promise<void>;
}

export function upstreamMeter(
  store: Pick<HealthStore, "addUpstreamCalls">,
): UpstreamMeter {
  let counted = zeroUpstream();
  return {
    hook: (kind) => (): void => {
      counted[kind] += 1;
    },
    counted: () => ({ ...counted }),
    async drain(nowSec) {
      // Reset before awaiting: a concurrent request draining the same meter
      // then finds an empty counter rather than writing these calls twice.
      const calls = counted;
      counted = zeroUpstream();
      if (sumUpstream(calls) > 0) await store.addUpstreamCalls(nowSec, calls);
    },
  };
}
