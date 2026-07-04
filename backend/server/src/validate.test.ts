import { describe, expect, it, vi } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import { bytesToHex, hexToBytes } from "@tessera/core";
import type {
  Cip179Records,
  GovLink,
  ResponseRecord,
  SurveyRecord,
  TxProof,
} from "@tessera/core";

import type { ValidatedResponseRow } from "./store";
import { memBackendStore, type MemBackendStore } from "./store-mem";
import { validateNewResponses } from "./validate";

// --- in-memory store + fake Koios source ---------------------------------------

function memTallyStore(): MemBackendStore & {
  rows: Map<string, ValidatedResponseRow>;
} {
  const store = memBackendStore();
  return Object.assign(store, { rows: store.validated });
}

function fakeSource(
  proofByTx: Record<string, TxProof | null>,
  blockIndexByTx: Record<string, number>,
) {
  return {
    txBlockIndices: vi.fn(async (hashes: readonly string[]) => {
      const m = new Map<string, number>();
      for (const h of hashes)
        if (h in blockIndexByTx) m.set(h, blockIndexByTx[h]!);
      return m;
    }),
    txProofs: vi.fn(async (hashes: readonly string[]) => {
      const m = new Map<string, TxProof | null>();
      for (const h of hashes) m.set(h, proofByTx[h] ?? null);
      return m;
    }),
  };
}

// --- fixtures ------------------------------------------------------------------

const SURVEY_TX = "aa".repeat(32);
const SURVEY_KEY = `${SURVEY_TX}:0`;

const keyCred = (b: number): Credential => ({
  type: "key",
  keyHash: Uint8Array.of(b),
});
const hexOf = (b: number) => bytesToHex(Uint8Array.of(b));

const DEF: SurveyDefinition = {
  specVersion: 4,
  owner: keyCred(0),
  title: "t",
  description: "",
  eligibleRoles: [0, 3] as Role[],
  endEpoch: 1345,
  submissionMode: { type: "public" },
  questions: [],
};

const survey: SurveyRecord = {
  txHash: SURVEY_TX,
  slot: 100,
  epochNo: 1340,
  ref: { txId: hexToBytes(SURVEY_TX), index: 0 },
  definition: DEF,
};

function response(
  txHash: string,
  cred: number,
  role: Role = Role.Stakeholder,
  responseIndex = 0,
): ResponseRecord {
  return {
    txHash,
    slot: 200,
    epochNo: 1341,
    responseIndex,
    response: {
      specVersion: 4,
      surveyRef: survey.ref,
      role,
      credential: keyCred(cred),
      answers: { type: "public", answers: [] },
    },
  };
}

const records = (...responses: ResponseRecord[]): Cip179Records => ({
  surveys: [survey],
  responses,
  cancellations: [],
});

const signedProof = (b: number): TxProof => ({
  requiredSigners: [hexOf(b)],
  nativeScripts: [],
  votes: [],
});

// --- tests ----------------------------------------------------------------------

describe("validateNewResponses", () => {
  it("validates new responses and persists rules 1–3 inputs", async () => {
    const store = memTallyStore();
    const source = fakeSource(
      { t1: signedProof(1), t2: signedProof(9) }, // t2 signed by the WRONG key
      { t1: 4, t2: 7 },
    );
    await validateNewResponses(
      store,
      records(response("t1", 1), response("t2", 2)),
      [],
      source,
    );

    const r1 = store.rows.get("t1:0")!;
    expect(r1).toMatchObject({
      surveyKey: SURVEY_KEY,
      role: Role.Stakeholder,
      credential: `key:${hexOf(1)}`,
      epochNo: 1341,
      blockIndex: 4,
      proofOk: true,
      wellFormed: true,
    });
    expect(store.rows.get("t2:0")!.proofOk).toBe(false);
  });

  it("is incremental: a second refresh with no new responses fetches nothing", async () => {
    const store = memTallyStore();
    const source = fakeSource({ t1: signedProof(1) }, { t1: 4 });
    const recs = records(response("t1", 1));

    await validateNewResponses(store, recs, [], source);
    expect(source.txProofs).toHaveBeenCalledTimes(1);

    await validateNewResponses(store, recs, [], source);
    expect(source.txProofs).toHaveBeenCalledTimes(1); // untouched
    expect(source.txBlockIndices).toHaveBeenCalledTimes(1);
  });

  it("retries rows whose enrichment failed (NULLs) on the next refresh", async () => {
    const store = memTallyStore();
    const failing = fakeSource({ t1: null }, {}); // cbor + tx_info both failed
    const recs = records(response("t1", 1));

    await validateNewResponses(store, recs, [], failing);
    expect(store.rows.get("t1:0")).toMatchObject({
      proofOk: null,
      blockIndex: null,
      wellFormed: true, // codec validation needs no fetch — already known
    });

    const healthy = fakeSource({ t1: signedProof(1) }, { t1: 4 });
    await validateNewResponses(store, recs, [], healthy);
    expect(healthy.txProofs).toHaveBeenCalledTimes(1); // re-fetched this tx
    expect(store.rows.get("t1:0")).toMatchObject({
      proofOk: true,
      blockIndex: 4,
    });
  });

  it("skips responses referencing surveys outside the snapshot", async () => {
    const store = memTallyStore();
    const source = fakeSource({ t9: signedProof(1) }, { t9: 1 });
    const stray: ResponseRecord = {
      ...response("t9", 1),
      response: {
        ...response("t9", 1).response,
        surveyRef: { txId: hexToBytes("bb".repeat(32)), index: 0 },
      },
    };
    await validateNewResponses(
      store,
      { ...records(), responses: [stray] },
      [],
      source,
    );
    expect(store.rows.size).toBe(0);
    // And it costs no Koios subrequests — an unknown-survey response must not
    // enter the fetch set, or it taxes every refresh forever (finding 4).
    expect(source.txProofs).not.toHaveBeenCalled();
    expect(source.txBlockIndices).not.toHaveBeenCalled();
  });

  it("applies mechanism B for epoch-aligned governance links", async () => {
    const ACTION = "gov_action1linked";
    const store = memTallyStore();
    // The tx votes the linked action as a DRep with the response credential —
    // no required_signers at all, so only mechanism B can prove it.
    const source = fakeSource(
      {
        t1: {
          requiredSigners: [],
          nativeScripts: [],
          votes: [
            { voterTag: 2, credentialHash: hexOf(1), actionIds: [ACTION] },
          ],
        },
      },
      { t1: 0 },
    );
    const link: GovLink = {
      surveyKey: SURVEY_KEY,
      actionId: ACTION,
      endEpoch: DEF.endEpoch, // aligned → the survey counts as linked
      title: null,
    };
    await validateNewResponses(
      store,
      records(response("t1", 1, Role.DRep)),
      [link],
      source,
    );
    expect(store.rows.get("t1:0")!.proofOk).toBe(true);

    // Same evidence but a mis-aligned link: not linked → mechanism A → false.
    const store2 = memTallyStore();
    await validateNewResponses(
      store2,
      records(response("t1", 1, Role.DRep)),
      [{ ...link, endEpoch: DEF.endEpoch + 1 }],
      source,
    );
    expect(store2.rows.get("t1:0")!.proofOk).toBe(false);
  });

  it("leaves a bindable-role verdict pending when gov links are unreliable (finding 2)", async () => {
    const store = memTallyStore();
    // A DRep tx that only signs (mechanism A would pass) — but with links
    // unknown this refresh, a hidden binding could still override it.
    const source = fakeSource({ t1: signedProof(1), t2: signedProof(2) }, {
      t1: 1,
      t2: 1,
    });
    await validateNewResponses(
      store,
      records(response("t1", 1, Role.DRep), response("t2", 2, Role.Stakeholder)),
      [], // empty because the fetch FAILED, not because there are no links
      source,
      false, // govLinksReliable = false
    );
    // Bindable role: verdict deferred (retry). Non-bindable: frozen safely.
    expect(store.rows.get("t1:0")!.proofOk).toBe(null);
    expect(store.rows.get("t2:0")!.proofOk).toBe(true);
  });

  it("re-validates a completed row when its survey's link appears later (finding 2)", async () => {
    const ACTION = "gov_action1linked";
    const store = memTallyStore();
    // A DRep tx with no signature, only a vote binding the linked action.
    const source = fakeSource(
      {
        t1: {
          requiredSigners: [],
          nativeScripts: [],
          votes: [
            { voterTag: 2, credentialHash: hexOf(1), actionIds: [ACTION] },
          ],
        },
      },
      { t1: 3 },
    );
    const recs = records(response("t1", 1, Role.DRep));

    // First refresh: links resolved but this survey's link not yet indexed.
    await validateNewResponses(store, recs, [], source, true);
    expect(store.rows.get("t1:0")!.proofOk).toBe(false); // mechanism A fails
    expect(store.rows.get("t1:0")!.linkedActionId).toBe(null);
    expect(source.txProofs).toHaveBeenCalledTimes(1);

    // Later refresh: the link now resolves → the completed verdict is redone.
    const link: GovLink = {
      surveyKey: SURVEY_KEY,
      actionId: ACTION,
      endEpoch: DEF.endEpoch,
      title: null,
    };
    await validateNewResponses(store, recs, [link], source, true);
    expect(source.txProofs).toHaveBeenCalledTimes(2); // re-fetched on link change
    expect(store.rows.get("t1:0")!.proofOk).toBe(true); // mechanism B now proves it
    expect(store.rows.get("t1:0")!.linkedActionId).toBe(ACTION);

    // Steady state: link unchanged → no further re-fetch.
    await validateNewResponses(store, recs, [link], source, true);
    expect(source.txProofs).toHaveBeenCalledTimes(2);
  });

  it("marks ill-formed responses (ineligible role) as not well-formed", async () => {
    const store = memTallyStore();
    const source = fakeSource({ t1: signedProof(1) }, { t1: 0 });
    // Role 1 (SPO) is not in DEF.eligibleRoles.
    await validateNewResponses(
      store,
      records(response("t1", 1, Role.SPO)),
      [],
      source,
    );
    expect(store.rows.get("t1:0")).toMatchObject({
      wellFormed: false,
      proofOk: true, // proof is orthogonal — the credential did sign the tx
    });
  });

  it("validates each response of a multi-response tx separately", async () => {
    const store = memTallyStore();
    const source = fakeSource({ t1: signedProof(1) }, { t1: 2 });
    await validateNewResponses(
      store,
      records(
        response("t1", 1, Role.Stakeholder, 0),
        response("t1", 2, Role.Stakeholder, 1),
      ),
      [],
      source,
    );
    // One tx → one fetch, two rows; only cred 1 signed.
    expect(source.txProofs).toHaveBeenCalledWith(["t1"]);
    expect(store.rows.get("t1:0")!.proofOk).toBe(true);
    expect(store.rows.get("t1:1")!.proofOk).toBe(false);
  });
});
