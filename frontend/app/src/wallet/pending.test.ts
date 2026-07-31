import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  SPEC_VERSION,
  type Cip179Payload,
  type SurveyDefinition,
} from "cip-179";
import { bytesToHex } from "cip-179/domain";

import {
  STALL_AFTER_MS,
  loadPendingTxs,
  payloadSurveyKey,
  pendingKind,
  pendingSurveyRecords,
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
const definitions: Cip179Payload = {
  type: "definitions",
  definitions: [definition],
};

const entry = (over: Partial<PendingTx> = {}): PendingTx => ({
  txHash: TX,
  txCbor: "84a4",
  payload: undefined,
  surveyKey: undefined,
  title: undefined,
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

describe("persistence", () => {
  test("an entry comes back with its payload decoded", () => {
    storePendingTxs([
      entry({
        payload: definitions,
        surveyKey: `${TX}:0`,
        title: "Which way?",
      }),
    ]);
    const [back] = loadPendingTxs(NOW);
    expect(back?.payload).toEqual(definitions);
    expect(back?.txCbor).toBe("84a4");
    expect(back?.surveyKey).toBe(`${TX}:0`);
    expect(back?.title).toBe("Which way?");
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
        { txHash: "bad", txCbor: "00", submittedAt: NOW, payload: { no: 1 } },
        { txHash: "good", txCbor: "01", submittedAt: NOW },
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
  test("kind comes off the payload; a proposal carries none", () => {
    expect(pendingKind(entry({ payload: definitions }))).toBe("survey");
    expect(pendingKind(entry())).toBe("govAction");
  });

  test("a definitions payload projects one survey record per definition", () => {
    const records = pendingSurveyRecords(entry({ payload: definitions }));
    expect(records).toHaveLength(1);
    expect(bytesToHex(records[0]!.ref.txId)).toBe(TX);
    expect(records[0]?.ref.index).toBe(0);
    expect(records[0]?.definition).toEqual(definition);
  });

  test("nothing but a definitions payload projects a survey", () => {
    expect(pendingSurveyRecords(entry())).toEqual([]);
  });

  test("a cancellation links to the survey it targets", () => {
    const key = payloadSurveyKey(
      {
        type: "cancellations",
        cancellations: [{ txId: new Uint8Array(32).fill(3), index: 2 }],
      },
      TX,
    );
    expect(key).toBe(`${"03".repeat(32)}:2`);
  });

  test("a batch spanning several surveys has no single one to link", () => {
    const batch: Cip179Payload = {
      type: "definitions",
      definitions: [definition, definition],
    };
    expect(payloadSurveyKey(batch, TX)).toBeUndefined();
  });
});
