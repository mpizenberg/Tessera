import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SPEC_VERSION, type SurveyDefinition } from "cip-179";
import { bytesToHex } from "cip-179/domain";

import type { Action } from "./action";
import {
  STALL_AFTER_MS,
  descendantOutrefs,
  loadPendingTxs,
  pendingKind,
  pendingSurveyKey,
  pendingSurveyRecords,
  pendingTitle,
  projectOutrefs,
  storePendingTxs,
  type PendingTx,
} from "./pending";

// Same shim as config.test.ts: these tests run in plain Node, no DOM.
const store = new Map<string, string>();
const KEY = "tessera.pendingTxs.preview";
const NOW = 1_800_000_000_000;
const TX = "aa".repeat(32);

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

const definition: SurveyDefinition = {
  specVersion: SPEC_VERSION,
  owner: { type: "key", keyHash: new Uint8Array(28).fill(1) },
  title: "Which way?",
  description: "",
  eligibleRoles: [],
  endEpoch: 42,
  submissionMode: { type: "public" },
  questions: [],
};
const publish: Action = {
  kind: "survey",
  definition,
  proveCredentials: [],
  title: "Which way?",
};
const propose: Action = {
  kind: "govAction",
  anchorUrl: "ipfs://doc",
  anchorDataHash: new Uint8Array(32),
  surveyKey: undefined,
  proveCredentials: [],
};

const entry = (over: Partial<PendingTx> = {}): PendingTx => ({
  txHash: TX,
  txCbor: "84a4",
  actions: [propose],
  submittedAt: NOW,
  status: "pending",
  stalled: false,
  ...over,
});

describe("UTxO projection", () => {
  test("a pending tx removes what it spends and adds what it makes", () => {
    const { drop, add } = projectOutrefs(
      ["a#0", "b#0"],
      [{ spent: ["a#0"], produced: ["t1#0"] }],
    );
    expect([...drop]).toEqual(["a#0"]);
    expect([...add]).toEqual(["t1#0"]);
  });

  test("an output the wallet already lists is not offered twice", () => {
    const { add } = projectOutrefs(
      ["t1#0"],
      [{ spent: ["a#0"], produced: ["t1#0"] }],
    );
    expect(add.size).toBe(0);
  });

  test("a chained output is spent before it ever becomes selectable", () => {
    const { drop, add } = projectOutrefs(
      ["a#0"],
      [
        { spent: ["a#0"], produced: ["t1#0"] },
        { spent: ["t1#0"], produced: ["t2#0"] },
      ],
    );
    expect(drop.has("t1#0")).toBe(true);
    expect([...add]).toEqual(["t2#0"]);
  });
});

describe("what a transaction leaves to build on", () => {
  const flows = [
    { txHash: "t1", spent: ["a#0"], produced: ["t1#0"] },
    { txHash: "t2", spent: ["t1#0"], produced: ["t2#0"] },
    { txHash: "t3", spent: ["b#0"], produced: ["t3#0"] },
  ];

  test("its own outputs, and whatever they end up funding", () => {
    expect([...descendantOutrefs("t1", flows)]).toEqual(["t1#0", "t2#0"]);
  });

  test("nothing an unrelated transaction made", () => {
    expect(descendantOutrefs("t3", flows).has("t2#0")).toBe(false);
  });

  test("a transaction we know nothing about leaves nothing", () => {
    expect(descendantOutrefs("t9", flows).size).toBe(0);
  });

  test("order of the set doesn't decide what is reachable", () => {
    expect([...descendantOutrefs("t1", [...flows].reverse())].sort()).toEqual([
      "t1#0",
      "t2#0",
    ]);
  });
});

describe("persistence", () => {
  test("an entry comes back with what it publishes decoded", () => {
    storePendingTxs([entry({ actions: [publish] })]);
    const [back] = loadPendingTxs(NOW);
    expect(back?.actions).toEqual([publish]);
    expect(back?.txCbor).toBe("84a4");
  });

  test("inclusion is re-checked, so entries come back pending", () => {
    storePendingTxs([entry({ status: "confirmed" })]);
    expect(loadPendingTxs(NOW)[0]?.status).toBe("pending");
  });

  test("the stall clock keeps running across a reload", () => {
    storePendingTxs([entry({ submittedAt: NOW - STALL_AFTER_MS - 1 })]);
    expect(loadPendingTxs(NOW)[0]?.stalled).toBe(true);
  });

  test("entries too old to still be coming are dropped", () => {
    storePendingTxs([entry({ submittedAt: NOW - 25 * 60 * 60 * 1000 })]);
    expect(loadPendingTxs(NOW)).toEqual([]);
  });

  test("an unreadable entry goes without taking the rest with it", () => {
    store.set(
      KEY,
      JSON.stringify([
        { txHash: "bad", txCbor: "00", submittedAt: NOW, actions: [{ no: 1 }] },
        {
          txHash: "good",
          txCbor: "01",
          submittedAt: NOW,
          actions: [
            {
              kind: "govAction",
              proveCredentials: [],
              anchorUrl: "ipfs://doc",
              anchorDataHash: "00".repeat(32),
            },
          ],
        },
      ]),
    );
    expect(loadPendingTxs(NOW).map((p) => p.txHash)).toEqual(["good"]);
  });

  test("an emptied set clears the key rather than storing []", () => {
    storePendingTxs([entry()]);
    storePendingTxs([]);
    expect(store.has(KEY)).toBe(false);
  });
});

describe("derivations", () => {
  test("kind comes off what the transaction publishes", () => {
    expect(pendingKind(entry({ actions: [publish] }))).toBe("survey");
    expect(pendingKind(entry())).toBe("govAction");
  });

  test("each queued definition projects one survey record", () => {
    const records = pendingSurveyRecords(entry({ actions: [publish] }));
    expect(records).toHaveLength(1);
    expect(bytesToHex(records[0]!.ref.txId)).toBe(TX);
    expect(records[0]?.ref.index).toBe(0);
    expect(records[0]?.definition).toEqual(definition);
  });

  test("nothing but a definition projects a survey", () => {
    expect(pendingSurveyRecords(entry())).toEqual([]);
  });

  test("a definition names the transaction publishing it", () => {
    expect(pendingSurveyKey(entry({ actions: [publish] }))).toBe(`${TX}:0`);
  });

  test("a cancellation links to the survey it targets", () => {
    const cancel: Action = {
      kind: "cancel",
      cancellation: { txId: new Uint8Array(32).fill(3), index: 2 },
      proveCredentials: [],
    };
    expect(pendingSurveyKey(entry({ actions: [cancel] }))).toBe(
      `${"03".repeat(32)}:2`,
    );
  });

  test("only a lone action lends the row its survey and its label", () => {
    const batch = entry({ actions: [publish, publish] });
    expect(pendingSurveyKey(batch)).toBeUndefined();
    expect(pendingTitle(batch)).toBeUndefined();
    expect(pendingTitle(entry({ actions: [publish] }))).toBe("Which way?");
  });
});
