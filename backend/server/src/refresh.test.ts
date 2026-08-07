/**
 * What a refresh publishes as its governance links. A successful read speaks
 * for itself — classifications come from hash-verified documents, banked, so
 * they don't flicker — but a read that failed outright means "unknown", and the
 * previous snapshot's links are a better answer than none.
 */

import { describe, expect, it } from "vitest";

import type { ChainTip, GovLink } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";

import { displayGovLinks, publishSnapshot } from "./refresh";
import { snapshotTip, type SnapshotMeta } from "./store";

const link = (actionId: string, surveyKey = "aa:0"): GovLink => ({
  surveyKey,
  actionId,
  endEpoch: 510,
  title: `title of ${actionId}`,
});

const storeWith = (stored: readonly GovLink[]) => ({
  snapshotGovLinks: async () => [...stored],
});

const failingStore = {
  snapshotGovLinks: async (): Promise<GovLink[]> => {
    throw new Error("store unreachable");
  },
};

describe("displayGovLinks", () => {
  it("publishes what the refresh resolved", async () => {
    const links = [link("gov_action1a")];
    // Including when an anchor at an unsettled epoch is still unread: that is
    // this refresh's honest answer, and the stored snapshot knows no more.
    expect(
      await displayGovLinks(storeWith([link("gov_action1b")]), links, true),
    ).toEqual(links);
  });

  it("falls back to every stored link when the read failed", async () => {
    const stored = [link("gov_action1a"), link("gov_action1b")];
    expect(await displayGovLinks(storeWith(stored), [], false)).toEqual(stored);
  });

  it("publishes the failed read's empty set when the fallback also fails", async () => {
    expect(await displayGovLinks(failingStore, [], false)).toEqual([]);
  });
});

describe("publishSnapshot", () => {
  const snapshot = { surveys: [], responses: [] };
  const metaWith = (payloadDigest: string | null): SnapshotMeta => ({
    tip: "{}",
    incomplete: false,
    fetchedAt: 2,
    payloadDigest,
  });
  const spyStore = () => {
    const calls: string[] = [];
    return {
      calls,
      store: {
        reconcileSnapshot: async () => void calls.push("reconcile"),
        publishSnapshotMeta: async () => void calls.push("meta"),
      },
    };
  };

  it("republishes only the envelope when the stored digest matches", async () => {
    const { calls, store } = spyStore();
    await publishSnapshot(store, metaWith("d1"), snapshot, metaWith("d1"));
    expect(calls).toEqual(["meta"]);
  });

  it("reconciles fully on a digest change", async () => {
    const { calls, store } = spyStore();
    await publishSnapshot(store, metaWith("d1"), snapshot, metaWith("d2"));
    expect(calls).toEqual(["reconcile"]);
  });

  it("reconciles fully when either digest is unknown", async () => {
    // No previous envelope, a pre-digest envelope, and an uncomputed digest:
    // none may match anything, or rows could go permanently unstored.
    for (const [previous, next] of [
      [null, metaWith("d1")],
      [metaWith(null), metaWith("d1")],
      [metaWith(null), metaWith(null)],
    ] as const) {
      const { calls, store } = spyStore();
      await publishSnapshot(store, previous, snapshot, next);
      expect(calls).toEqual(["reconcile"]);
    }
  });
});

describe("snapshotTip", () => {
  // Two upstream reads are skipped by trusting this round-trip: a refresh
  // rebanks `gov_action_lifetime` when the stored epoch still holds, and
  // `/api/pparams` keys its Koios read on that same epoch. Every field must
  // therefore survive the wire encoding unwrapped — one bigint or bytes field
  // would come back as an object and silently break both.
  it("recovers the stored ChainTip as plain numbers", () => {
    const tip: ChainTip = {
      epoch: 511,
      slot: 1_000,
      time: 1_750_000_000,
      epochSlot: 100,
      govActionLifetime: 6,
    };

    const meta = {
      tip: JSON.stringify(toJsonSafe(tip)),
      incomplete: false,
      fetchedAt: 1_750_000_000,
      payloadDigest: null,
    };

    expect(snapshotTip(meta)).toEqual(tip);
  });
});
