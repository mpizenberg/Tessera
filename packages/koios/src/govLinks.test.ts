/**
 * Resolving a proposal's anchor into a link — the half of discovery that reads
 * off-chain documents. What matters here is which of the three outcomes each
 * action lands in: a link, a verified non-link, or *unresolved* (unknown, not
 * "none" — finding 6), and that one fetch answers for every action sharing an
 * anchor.
 */

import { describe, expect, it, vi } from "vitest";

import { blake2b256 } from "cip-179/content";
import { bytesToHex, hexToBytes } from "cip-179/domain";

import {
  govLinkScan,
  govProposal,
  resolveGovAnchors,
  type GovProposal,
} from "./govLinks";

const TXID = "9a1c".repeat(16);

const linkDoc = (index = 2, title: unknown = "Ratify the budget") => ({
  hashAlgorithm: "blake2b-256",
  body: {
    title,
    cip179: {
      specVersion: 5,
      kind: "survey-link",
      surveyTxId: TXID,
      surveyIndex: index,
    },
  },
});

const proposal = (
  actionId: string,
  anchorHash: string,
  endEpoch = 41,
): GovProposal => ({
  actionId,
  endEpoch,
  anchor: {
    uri: `https://anchor.example/${anchorHash}`,
    hash: hexToBytes(anchorHash),
  },
  anchorHash,
});

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const HASH_C = "cc".repeat(32);

describe("resolveGovAnchors", () => {
  it("fetches each distinct anchor once, however many actions point at it", async () => {
    const fetchDoc = vi.fn(async () => linkDoc());
    const docs = await resolveGovAnchors(
      [
        proposal("gov_action1a", HASH_A),
        proposal("gov_action1b", HASH_A), // same document, second action
      ],
      { fetchDoc },
    );
    expect(fetchDoc).toHaveBeenCalledTimes(1);
    expect(docs).toEqual(
      new Map([
        [HASH_A, { surveyKey: `${TXID}:2`, title: "Ratify the budget" }],
      ]),
    );
  });

  // A document that verifiably isn't a link is as final as one that is — it is
  // banked as `null`, not retried forever.
  it("records a verified non-link as null, distinct from unresolved", async () => {
    const docs = await resolveGovAnchors(
      [proposal("gov_action1a", HASH_A), proposal("gov_action1b", HASH_B)],
      {
        fetchDoc: async (anchor) =>
          anchor.uri.endsWith(HASH_A)
            ? { body: { title: "Just a normal action" } }
            : Promise.reject(new Error("404")),
      },
    );
    expect(docs.get(HASH_A)).toBeNull();
    expect(docs.has(HASH_A)).toBe(true);
    expect(docs.has(HASH_B)).toBe(false); // couldn't read it — no verdict
  });

  it("resolves nothing for no proposals, without fetching", async () => {
    const fetchDoc = vi.fn(async () => linkDoc());
    expect(await resolveGovAnchors([], { fetchDoc })).toEqual(new Map());
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  // The default path (no injected `fetchDoc`) is the one that matters in
  // production: a document only classifies an action if it hashes to what that
  // action committed to on-chain. A served document that doesn't is no evidence
  // at all — not a non-link, which would be a decision taken on a forgery.
  it("by default accepts only a document matching the on-chain anchor hash", async () => {
    const body = new TextEncoder().encode(JSON.stringify(linkDoc(2)));
    const served: GovProposal = {
      actionId: "gov_action1a",
      endEpoch: 41,
      anchor: {
        uri: "https://anchor.example/doc.json",
        hash: blake2b256(body),
      },
      anchorHash: bytesToHex(blake2b256(body)),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    try {
      expect(
        (await resolveGovAnchors([served]))?.get(served.anchorHash),
      ).toEqual({ surveyKey: `${TXID}:2`, title: "Ratify the budget" });

      // Same URL, same action — but the bytes no longer hash to the commitment.
      const tampered: GovProposal = {
        ...served,
        anchor: { ...served.anchor, hash: hexToBytes(HASH_A) },
        anchorHash: HASH_A,
      };
      expect(await resolveGovAnchors([tampered])).toEqual(new Map());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("govLinkScan", () => {
  it("splits actions into links, silent non-links, and unresolved", async () => {
    const proposals = [
      proposal("gov_action1link", HASH_A),
      proposal("gov_action1plain", HASH_B),
      proposal("gov_action1unread", HASH_C),
    ];
    const docs = new Map([
      [HASH_A, { surveyKey: `${TXID}:2`, title: "T" }],
      [HASH_B, null], // verified: not a link
    ]);
    expect(govLinkScan(proposals, docs)).toEqual({
      links: [
        {
          surveyKey: `${TXID}:2`,
          actionId: "gov_action1link",
          endEpoch: 41,
          title: "T",
        },
      ],
      // Only the action we couldn't read is unknown; the verified non-link is
      // settled and appears nowhere (finding 6).
      unresolved: [{ actionId: "gov_action1unread", endEpoch: 41 }],
    });
  });

  // One document, two actions: the link's survey and title come from the shared
  // document, its id and expiry epoch from each action's own on-chain row.
  it("gives every action pointing at one document its own link", () => {
    const docs = new Map([[HASH_A, { surveyKey: `${TXID}:2`, title: "T" }]]);
    expect(
      govLinkScan(
        [
          proposal("gov_action1a", HASH_A, 41),
          proposal("gov_action1b", HASH_A, 77),
        ],
        docs,
      ).links,
    ).toEqual([
      {
        surveyKey: `${TXID}:2`,
        actionId: "gov_action1a",
        endEpoch: 41,
        title: "T",
      },
      {
        surveyKey: `${TXID}:2`,
        actionId: "gov_action1b",
        endEpoch: 77,
        title: "T",
      },
    ]);
  });
});

describe("govProposal", () => {
  it("normalizes an upper-case anchor hash to the key it is banked under", () => {
    const p = govProposal({
      proposal_id: "gov_action1a",
      expiration: 42,
      meta_url: "ipfs://cid",
      meta_hash: "AB".repeat(32),
    });
    expect(p?.anchorHash).toBe("ab".repeat(32));
    expect(p?.anchor).toEqual({
      uri: "ipfs://cid",
      hash: hexToBytes("ab".repeat(32)),
    });
    expect(p?.endEpoch).toBe(41);
  });
});
