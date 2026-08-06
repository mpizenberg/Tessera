/**
 * What a refresh publishes as its governance links. A successful read speaks
 * for itself — classifications come from hash-verified documents, banked, so
 * they don't flicker — but a read that failed outright means "unknown", and the
 * previous snapshot's links are a better answer than none.
 */

import { describe, expect, it } from "vitest";

import type { ChainTip, GovLink } from "cip-179/domain";
import { toJsonSafe } from "cip-179/tally";

import { displayGovLinks } from "./refresh";

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

describe("the stored tip a refresh banks gov_action_lifetime from", () => {
  // A refresh skips its /epoch_params read by comparing the previous snapshot's
  // stored tip against the epoch it just read, parsing that tip as plain JSON.
  // Both fields must therefore survive the wire encoding unwrapped — a bigint
  // or bytes field would come back as an object and silently break the reuse.
  it("keeps epoch and gov_action_lifetime as plain numbers", () => {
    const tip: ChainTip = {
      epoch: 511,
      slot: 1_000,
      time: 1_750_000_000,
      epochSlot: 100,
      govActionLifetime: 6,
    };

    expect(JSON.parse(JSON.stringify(toJsonSafe(tip)))).toMatchObject({
      epoch: 511,
      govActionLifetime: 6,
    });
  });
});
