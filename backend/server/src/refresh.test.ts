/**
 * What a refresh publishes as its governance links. Koios resolves anchors
 * lazily and its nodes disagree about which are resolved, so the scan regularly
 * comes back *missing* a link it returned minutes ago — the flicker this logic
 * exists to absorb.
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
  it("publishes the fresh scan when every anchor resolved", async () => {
    const scan = { links: [link("gov_action1a")], unresolved: [] };
    expect(await displayGovLinks(storeWith([]), scan, true)).toEqual(
      scan.links,
    );
  });

  it("keeps the stored link of an action this scan couldn't read", async () => {
    const scan = {
      links: [link("gov_action1a")],
      unresolved: [{ actionId: "gov_action1b", endEpoch: 510 }],
    };
    const stored = [link("gov_action1a"), link("gov_action1b")];
    expect(
      (await displayGovLinks(storeWith(stored), scan, true)).map(
        (l) => l.actionId,
      ),
    ).toEqual(["gov_action1a", "gov_action1b"]);
  });

  it("adds nothing for an unresolved action never seen as a link", async () => {
    const scan = {
      links: [],
      unresolved: [{ actionId: "gov_action1never", endEpoch: 510 }],
    };
    expect(
      await displayGovLinks(storeWith([link("gov_action1a")]), scan, true),
    ).toEqual([]);
  });

  it("falls back to every stored link when the scan itself failed", async () => {
    const stored = [link("gov_action1a"), link("gov_action1b")];
    expect(
      await displayGovLinks(
        storeWith(stored),
        { links: [], unresolved: [] },
        false,
      ),
    ).toEqual(stored);
  });

  it("publishes the fresh scan when recovery itself fails", async () => {
    const scan = {
      links: [link("gov_action1a")],
      unresolved: [{ actionId: "gov_action1b", endEpoch: 510 }],
    };
    expect(await displayGovLinks(failingStore, scan, true)).toEqual(scan.links);
  });
});
