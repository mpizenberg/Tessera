/**
 * What a refresh publishes as its governance links. A successful read speaks
 * for itself — classifications come from hash-verified documents, banked, so
 * they don't flicker — but a read that failed outright means "unknown", and the
 * previous snapshot's links are a better answer than none.
 */

import { describe, expect, it } from "vitest";

import type { GovLink } from "cip-179/domain";

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
