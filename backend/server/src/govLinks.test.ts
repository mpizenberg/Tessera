/**
 * The refresh's governance-link pass: fetch-once banking, per-epoch settlement
 * with bounded patience, and the pruning that keeps both bounded.
 *
 * The properties under test are the ones the design rests on — an anchor is
 * fetched at most once ever, an epoch's answer is frozen once the epoch is
 * frozen, waiting on a dead anchor ends, and nothing that a settled epoch still
 * needs is thrown away.
 */

import { describe, expect, it, vi } from "vitest";

import type { ContentAnchor } from "cip-179";
import { hexToBytes } from "cip-179/domain";
import type { GovProposal } from "@tessera/koios";

import {
  ANCHOR_ATTEMPTS_PER_REFRESH,
  SETTLEMENT_PATIENCE_EPOCHS,
  refreshGovLinks,
} from "./govLinks";
import { memBackendStore, type MemBackendStore } from "./store-mem";

const TXID = "9a1c".repeat(16);

/** A CIP-108 document carrying a survey link at `body.cip179`. */
const linkDoc = (index: number) => ({
  hashAlgorithm: "blake2b-256",
  body: {
    title: `link to ${index}`,
    cip179: {
      specVersion: 5,
      kind: "survey-link",
      surveyTxId: TXID,
      surveyIndex: index,
    },
  },
});

const PLAIN_DOC = { body: { title: "Just a normal action" } };

const hashOf = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const proposal = (n: number, endEpoch: number): GovProposal => ({
  actionId: `gov_action1_${n}`,
  endEpoch,
  anchor: { uri: `https://anchor.example/${n}`, hash: hexToBytes(hashOf(n)) },
  anchorHash: hashOf(n),
});

/** A source serving fixed proposals, recording which epochs were asked for. */
function sourceOf(proposals: readonly GovProposal[]) {
  const asked: number[][] = [];
  return {
    asked,
    fetchGovProposals: async (endEpochs: readonly number[]) => {
      asked.push([...endEpochs]);
      const wanted = new Set(endEpochs);
      return proposals.filter((p) => wanted.has(p.endEpoch));
    },
  };
}

/** Serves `docs` by anchor hash; anything else is an unreachable anchor. */
function docs(byHash: Record<string, unknown>) {
  const fetchDoc = vi.fn(async (anchor: ContentAnchor) => {
    const hash = anchor.uri.split("/").pop()!;
    const doc = byHash[hash];
    if (doc === undefined) throw new Error(`anchor ${hash} unreachable`);
    return doc;
  });
  return fetchDoc;
}

const run = (
  store: MemBackendStore,
  source: ReturnType<typeof sourceOf>,
  endEpochs: readonly number[],
  tipEpoch: number,
  fetchDoc: ReturnType<typeof docs>,
  nowSec = 1000,
) =>
  refreshGovLinks(store, source, endEpochs, tipEpoch, nowSec, {
    fetchDoc,
    rotate: 0,
  });

describe("refreshGovLinks — fetch once, bank forever", () => {
  it("never re-fetches an anchor it has verified", async () => {
    const store = memBackendStore();
    const source = sourceOf([proposal(1, 510), proposal(2, 510)]);
    const fetchDoc = docs({ "1": linkDoc(0), "2": PLAIN_DOC });

    const first = await run(store, source, [510], 500, fetchDoc);
    expect(fetchDoc).toHaveBeenCalledTimes(2);
    expect(first.links).toEqual([
      {
        surveyKey: `${TXID}:0`,
        actionId: "gov_action1_1",
        endEpoch: 510,
        title: "link to 0",
      },
    ]);
    expect(first.unresolved).toEqual([]);

    // A second refresh over the same open epoch reads the bank and asks nobody.
    const second = await run(store, source, [510], 500, fetchDoc);
    expect(fetchDoc).toHaveBeenCalledTimes(2);
    expect(second.links).toEqual(first.links);
    // Including the verified non-link: banked as null, never re-fetched.
    expect(store.govAnchors.get(hashOf(2))).toBeNull();
  });

  it("keeps an unreadable anchor out of the bank and reports it unresolved", async () => {
    const store = memBackendStore();
    const source = sourceOf([proposal(1, 510), proposal(2, 510)]);
    const fetchDoc = docs({ "1": linkDoc(0) }); // 2 is unreachable

    const scan = await run(store, source, [510], 500, fetchDoc);
    expect(scan.unresolved).toEqual([
      { actionId: "gov_action1_2", endEpoch: 510 },
    ]);
    expect(store.govAnchors.has(hashOf(2))).toBe(false);

    // …and keeps asking about it, since a failure is not a verdict.
    await run(store, source, [510], 500, fetchDoc);
    expect(fetchDoc).toHaveBeenCalledTimes(3); // 1 + 2 on the first pass, 2 again
  });

  it("attempts at most a bounded number of anchors per refresh", async () => {
    const store = memBackendStore();
    const many = Array.from({ length: ANCHOR_ATTEMPTS_PER_REFRESH + 3 }, (_, i) =>
      proposal(i + 1, 510),
    );
    const source = sourceOf(many);
    const fetchDoc = docs(
      Object.fromEntries(many.map((_, i) => [String(i + 1), PLAIN_DOC])),
    );

    await run(store, source, [510], 500, fetchDoc);
    expect(fetchDoc).toHaveBeenCalledTimes(ANCHOR_ATTEMPTS_PER_REFRESH);
    // The rest converge over later refreshes rather than failing forever.
    await run(store, source, [510], 500, fetchDoc);
    expect(store.govAnchors.size).toBe(many.length);
  });
});

describe("refreshGovLinks — settlement", () => {
  it("settles a frozen epoch once every anchor is classified", async () => {
    const store = memBackendStore();
    const source = sourceOf([proposal(1, 510), proposal(2, 510)]);
    const fetchDoc = docs({ "1": linkDoc(0), "2": PLAIN_DOC });

    // Tip has reached the expiration epoch: no new proposal can land at it.
    const scan = await run(store, source, [510], 511, fetchDoc, 4242);
    expect(store.govEpochs.get(511)).toEqual({
      expiration: 511,
      links: scan.links,
      gaveUp: [],
      settledAt: 4242,
    });

    // A settled epoch leaves the query for good — this is the growth bound.
    source.asked.length = 0;
    const later = await run(store, source, [510], 520, fetchDoc);
    expect(source.asked).toEqual([]);
    expect(later.links).toEqual(scan.links);
  });

  it("does not settle an epoch the tip hasn't reached", async () => {
    const store = memBackendStore();
    const source = sourceOf([proposal(1, 510)]);
    await run(store, source, [510], 510, docs({ "1": linkDoc(0) }));
    // The action expires at epoch 511 and the tip is 510: another proposal can
    // still be posted with that expiration, so the set isn't frozen.
    expect(store.govEpochs.size).toBe(0);
  });

  // The liveness bound: most anchors in the wild never resolve, and a held
  // verdict on one of them would postpone the survey's artifact forever.
  it("settles without a dead anchor once patience runs out", async () => {
    const store = memBackendStore();
    const source = sourceOf([proposal(1, 510), proposal(2, 510)]);
    const fetchDoc = docs({ "1": linkDoc(0) }); // 2 never resolves

    const waiting = await run(store, source, [510], 511, fetchDoc);
    expect(store.govEpochs.size).toBe(0); // still asking
    expect(waiting.unresolved).toHaveLength(1);

    const settled = await run(
      store,
      source,
      [510],
      511 + SETTLEMENT_PATIENCE_EPOCHS,
      fetchDoc,
    );
    expect(store.govEpochs.get(511)?.gaveUp).toEqual(["gov_action1_2"]);
    // The action stops clouding verdicts the moment its epoch decides — that is
    // what unblocks finalization for surveys ending at 510.
    expect(settled.unresolved).toEqual([]);
    expect(settled.links).toHaveLength(1);
  });

  it("settles a frozen epoch with no proposals at all", async () => {
    const store = memBackendStore();
    const source = sourceOf([]);
    await run(store, source, [510], 511, docs({}));
    expect(store.govEpochs.get(511)).toMatchObject({ links: [], gaveUp: [] });
  });
});

describe("refreshGovLinks — bank pruning", () => {
  it("drops a settled epoch's anchors but keeps ones another epoch still needs", async () => {
    const store = memBackendStore();
    // Anchor 1 is referenced from both epochs (one document, two actions);
    // anchor 2 belongs to the settling epoch alone.
    const shared: GovProposal = { ...proposal(1, 520), actionId: "gov_action1_1b" };
    const source = sourceOf([proposal(1, 510), proposal(2, 510), shared]);
    const fetchDoc = docs({ "1": linkDoc(0), "2": PLAIN_DOC });

    // Epoch 511 is frozen and settles; 521 is still open.
    await run(store, source, [510, 520], 511, fetchDoc);
    expect([...store.govEpochs.keys()]).toEqual([511]);
    expect(store.govAnchors.has(hashOf(2))).toBe(false); // only 511 needed it
    expect(store.govAnchors.has(hashOf(1))).toBe(true); // 521 still does

    // …and the survivor is still a bank hit, not a re-fetch.
    await run(store, source, [510, 520], 511, fetchDoc);
    expect(fetchDoc).toHaveBeenCalledTimes(2);
  });
});

describe("refreshGovLinks — rebuildable cache", () => {
  it("re-scans, re-fetches and re-settles after a wipe", async () => {
    const source = sourceOf([proposal(1, 510)]);
    const fetchDoc = docs({ "1": linkDoc(0) });

    const before = memBackendStore();
    const original = await run(before, source, [510], 511, fetchDoc);

    // A fresh store is exactly a wiped cache: the epoch is unsettled again, so
    // the scan asks for it and the links come back identical rather than lost.
    const after = memBackendStore();
    const rebuilt = await run(after, source, [510], 511, fetchDoc);
    expect(rebuilt).toEqual(original);
    expect(after.govEpochs.get(511)?.links).toEqual(original.links);
  });

  it("asks nothing at all when there are no surveys", async () => {
    const store = memBackendStore();
    const source = sourceOf([proposal(1, 510)]);
    expect(await run(store, source, [], 511, docs({}))).toEqual({
      links: [],
      unresolved: [],
    });
    expect(source.asked).toEqual([]);
  });
});
