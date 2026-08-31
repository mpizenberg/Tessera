import { describe, expect, it, vi } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import {
  bytesToHex,
  hexToBytes,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type ResponseRecord,
  type SurveyRecord,
  type TxProof,
  type UnresolvedGovAction,
} from "cip-179/domain";

import { materializeSnapshot } from "./materialize";
import { ALL_SLOTS, testStore, type TestStore } from "./testing/store";
import { validateNewResponses } from "./validate";

// --- store + fake Koios source -------------------------------------------------

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
  specVersion: 5,
  owner: keyCred(0),
  title: "t",
  description: "",
  eligibleRoles: [0, 3] as Role[],
  endEpoch: 1345,
  submissionMode: { type: "public" },
  // One optional question so a well-formed response carries a valid answer; an
  // empty answers array is no longer well-formed (finding 9).
  questions: [
    {
      type: "singleChoice",
      prompt: "",
      options: { type: "options", labels: ["a", "b"] },
    },
  ],
};

const answer = {
  type: "singleChoice",
  questionIndex: 0,
  optionIndex: 0,
} as const;

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
      specVersion: 5,
      surveyRef: survey.ref,
      role,
      credential: keyCred(cred),
      answers: { type: "public", answers: [answer] },
    },
  };
}

const records = (...responses: ResponseRecord[]): Cip179Records => ({
  surveys: [survey],
  responses,
  cancellations: [],
});

const TIP: ChainTip = {
  epoch: 1341,
  slot: 500,
  epochSlot: 0,
  time: 1_750_000_000,
  govActionLifetime: 6,
};

/** Publish `recs` as stored rows — the corpus a windowed input no longer carries. */
async function publish(
  store: TestStore,
  recs: Cip179Records,
  links: readonly GovLink[] = [],
) {
  const snapshot = materializeSnapshot(recs, TIP, links, new Map());
  await store.reconcileSegment(
    ALL_SLOTS,
    snapshot.surveys,
    snapshot.responses,
    snapshot.cancellations,
    [],
    { tip: "{}", incomplete: false, fetchedAt: 1, listCounts: null },
  );
}

/**
 * One validation pass. Segment integration runs first in every refresh, so the
 * corpus — each survey's definition AND the links this refresh resolved for it
 * — is in the rows before validation reads a thing; the input carries only
 * what the segment listed, which by default is the corpus's own responses.
 */
async function validatePass(
  store: TestStore,
  stored: Cip179Records,
  links: readonly GovLink[],
  source: Parameters<typeof validateNewResponses>[2],
  govLinksReliable = true,
  unresolved: readonly UnresolvedGovAction[] = [],
  input: readonly ResponseRecord[] = stored.responses,
) {
  await publish(store, stored, links);
  await validateNewResponses(
    store,
    input,
    source,
    0,
    govLinksReliable,
    unresolved,
  );
}

const signedProof = (b: number): TxProof => ({
  requiredSigners: [hexOf(b)],
  nativeScripts: [],
  votes: [],
});

// --- tests ----------------------------------------------------------------------

describe("validateNewResponses", () => {
  it("validates new responses and persists rules 1–3 inputs", async () => {
    const store = testStore();
    const source = fakeSource(
      { t1: signedProof(1), t2: signedProof(9) }, // t2 signed by the WRONG key
      { t1: 4, t2: 7 },
    );
    await validatePass(
      store,
      records(response("t1", 1), response("t2", 2)),
      [],
      source,
    );

    const r1 = store.validated.get("t1:0")!;
    expect(r1).toMatchObject({
      surveyKey: SURVEY_KEY,
      role: Role.Stakeholder,
      credential: `key:${hexOf(1)}`,
      epochNo: 1341,
      blockIndex: 4,
      proofOk: true,
      wellFormed: true,
    });
    expect(store.validated.get("t2:0")!.proofOk).toBe(false);
  });

  it("is incremental: a second refresh with no new responses fetches nothing", async () => {
    const store = testStore();
    const source = fakeSource({ t1: signedProof(1) }, { t1: 4 });
    const recs = records(response("t1", 1));

    await validatePass(store, recs, [], source);
    expect(source.txProofs).toHaveBeenCalledTimes(1);

    await validatePass(store, recs, [], source);
    expect(source.txProofs).toHaveBeenCalledTimes(1); // untouched
    expect(source.txBlockIndices).toHaveBeenCalledTimes(1);
  });

  it("re-judges a response that rolled back and re-landed elsewhere", async () => {
    const store = testStore();
    const landed = response("t1", 1);
    await validatePass(
      store,
      records(landed),
      [],
      fakeSource({ t1: signedProof(1) }, { t1: 4 }),
    );
    expect(store.validated.get("t1:0")).toMatchObject({
      slot: 200,
      blockIndex: 4,
    });

    // The same content-addressed transaction, re-included past an epoch
    // boundary: a verdict left at its old coordinates would window the response
    // against the wrong epoch and order it by a block index that moved.
    const source = fakeSource({ t1: signedProof(1) }, { t1: 9 });
    await validatePass(
      store,
      records({ ...landed, slot: 260, epochNo: 1342 }),
      [],
      source,
    );

    expect(source.txBlockIndices).toHaveBeenCalledTimes(1);
    expect(store.validated.get("t1:0")).toMatchObject({
      slot: 260,
      epochNo: 1342,
      blockIndex: 9,
    });
  });

  it("retries rows whose enrichment failed (NULLs) on the next refresh", async () => {
    const store = testStore();
    const failing = fakeSource({ t1: null }, {}); // cbor + tx_info both failed
    const recs = records(response("t1", 1));

    await validatePass(store, recs, [], failing);
    expect(store.validated.get("t1:0")).toMatchObject({
      proofOk: null,
      blockIndex: null,
      wellFormed: true, // codec validation needs no fetch — already known
    });

    const healthy = fakeSource({ t1: signedProof(1) }, { t1: 4 });
    await validatePass(store, recs, [], healthy);
    expect(healthy.txProofs).toHaveBeenCalledTimes(1); // re-fetched this tx
    expect(store.validated.get("t1:0")).toMatchObject({
      proofOk: true,
      blockIndex: 4,
    });
  });

  it("skips responses referencing surveys outside the snapshot", async () => {
    const store = testStore();
    const source = fakeSource({ t9: signedProof(1) }, { t9: 1 });
    const stray: ResponseRecord = {
      ...response("t9", 1),
      response: {
        ...response("t9", 1).response,
        surveyRef: { txId: hexToBytes("bb".repeat(32)), index: 0 },
      },
    };
    await validatePass(store, { ...records(), responses: [stray] }, [], source);
    expect(store.validated.size).toBe(0);
    // And it costs no Koios subrequests — an unknown-survey response must not
    // enter the fetch set, or it taxes every refresh forever (finding 4).
    expect(source.txProofs).not.toHaveBeenCalled();
    expect(source.txBlockIndices).not.toHaveBeenCalled();
  });

  it("applies mechanism B for epoch-aligned governance links", async () => {
    const ACTION = "gov_action1linked";
    const store = testStore();
    // The link reaches this pass only through the survey's stored row: below
    // the settlement floor the refresh never asks about the epoch again, so
    // the row is the one place a verdict can read it from.
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
    await validatePass(
      store,
      records(response("t1", 1, Role.DRep)),
      [link],
      source,
    );
    expect(store.validated.get("t1:0")!.proofOk).toBe(true);

    // Same evidence but a mis-aligned link: not linked → mechanism A → false.
    const store2 = testStore();
    await validatePass(
      store2,
      records(response("t1", 1, Role.DRep)),
      [{ ...link, endEpoch: DEF.endEpoch + 1 }],
      source,
    );
    expect(store2.validated.get("t1:0")!.proofOk).toBe(false);
  });

  it("defers only bindable-role FAILING verdicts when gov links are unreliable (finding 2)", async () => {
    const store = testStore();
    // t1 signs (mechanism A passes) — final even with links unknown, since a
    // hidden link could only ADD a mechanism-B proof, never invalidate. t3
    // neither signs nor binds — a hidden link could flip that false, so defer.
    const source = fakeSource(
      {
        t1: signedProof(1),
        t2: signedProof(2),
        t3: { requiredSigners: [], nativeScripts: [], votes: [] },
      },
      { t1: 1, t2: 1, t3: 1 },
    );
    await validatePass(
      store,
      records(
        response("t1", 1, Role.DRep),
        response("t2", 2, Role.Stakeholder),
        response("t3", 3, Role.DRep),
      ),
      [], // empty because the fetch FAILED, not because there are no links
      source,
      false, // govLinksReliable = false
    );
    expect(store.validated.get("t1:0")!.proofOk).toBe(true); // A pass is final
    expect(store.validated.get("t2:0")!.proofOk).toBe(true); // non-bindable: frozen
    expect(store.validated.get("t3:0")!.proofOk).toBe(null); // failing DRep: retry
  });

  it("re-validates a completed row when its survey's link appears later (finding 2)", async () => {
    const ACTION = "gov_action1linked";
    const store = testStore();
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
    await validatePass(store, recs, [], source, true);
    expect(store.validated.get("t1:0")!.proofOk).toBe(false); // mechanism A fails
    expect(store.validated.get("t1:0")!.linkedActionId).toBe(null);
    expect(source.txProofs).toHaveBeenCalledTimes(1);

    // Later refresh: the link now resolves → the completed verdict is redone.
    const link: GovLink = {
      surveyKey: SURVEY_KEY,
      actionId: ACTION,
      endEpoch: DEF.endEpoch,
      title: null,
    };
    await validatePass(store, recs, [link], source, true);
    expect(source.txProofs).toHaveBeenCalledTimes(2); // re-fetched on link change
    expect(store.validated.get("t1:0")!.proofOk).toBe(true); // mechanism B now proves it
    expect(store.validated.get("t1:0")!.linkedActionId).toBe(ACTION);

    // Steady state: link unchanged → no further re-fetch.
    await validatePass(store, recs, [link], source, true);
    expect(source.txProofs).toHaveBeenCalledTimes(2);
  });

  it("holds a bindable verdict whose only possible proof votes an unresolved-anchor action (finding 6)", async () => {
    const ACTION = "gov_action1unresolved";
    const store = testStore();
    // t1: DRep, no signature — mechanism A fails; it votes the action whose
    // anchor document couldn't be read, so whether it links this survey is
    // unknown.
    // t2: DRep signing a different credential — mechanism A fails and it never
    // voted the unresolved action, so nothing could ever prove it: final false.
    const source = fakeSource(
      {
        t1: {
          requiredSigners: [],
          nativeScripts: [],
          votes: [
            { voterTag: 2, credentialHash: hexOf(1), actionIds: [ACTION] },
          ],
        },
        t2: signedProof(9),
      },
      { t1: 3, t2: 4 },
    );
    await validatePass(
      store,
      records(response("t1", 1, Role.DRep), response("t2", 2, Role.DRep)),
      [], // no RESOLVED links this refresh
      source,
      true, // the fetch itself succeeded
      [{ actionId: ACTION, endEpoch: DEF.endEpoch }], // but this anchor is unresolved
    );
    expect(store.validated.get("t1:0")!.proofOk).toBe(null); // unknown → retry
    expect(store.validated.get("t2:0")!.proofOk).toBe(false); // didn't vote it → final

    // Once that action's expiration epoch settles, the anchor leaves the
    // unresolved set for good and the held verdict finally freezes. Without
    // that, a permanently dead anchor postpones this survey's artifact forever
    // — finalization postpones on any null verdict.
    await validatePass(
      store,
      records(response("t1", 1, Role.DRep), response("t2", 2, Role.DRep)),
      [],
      source,
      true,
      [], // epoch settled: nothing is unknown any more
    );
    expect(store.validated.get("t1:0")!.proofOk).toBe(false);
  });

  it("an unresolved anchor at a DIFFERENT epoch never clouds the survey (finding 6)", async () => {
    const ACTION = "gov_action1elsewhere";
    const store = testStore();
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
    // The unresolved action expires at a different epoch than the survey ends,
    // so epoch-alignment rules it out — it can't link this survey regardless of
    // its content, and the negative is final rather than deferred.
    await validatePass(
      store,
      records(response("t1", 1, Role.DRep)),
      [],
      source,
      true,
      [{ actionId: ACTION, endEpoch: DEF.endEpoch + 1 }],
    );
    expect(store.validated.get("t1:0")!.proofOk).toBe(false);
  });

  it("revives a stored response absent from the input when its survey's link set changes", async () => {
    const ACTION = "gov_action1linked";
    const store = testStore();
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
    const full = records(response("t1", 1, Role.DRep));
    await validatePass(store, full, [], source, true);
    expect(store.validated.get("t1:0")!.proofOk).toBe(false);

    // Next refresh, windowed: the input no longer carries the response, but
    // the link appearing re-validates it from its stored row.
    const link: GovLink = {
      surveyKey: SURVEY_KEY,
      actionId: ACTION,
      endEpoch: DEF.endEpoch,
      title: null,
    };
    await validatePass(store, full, [link], source, true, [], []);
    expect(source.txProofs).toHaveBeenCalledTimes(2);
    expect(store.validated.get("t1:0")!.proofOk).toBe(true);
    expect(store.validated.get("t1:0")!.linkedActionId).toBe(ACTION);
  });

  it("retries an enrichment-pending verdict whose response left the input", async () => {
    const store = testStore();
    const full = records(response("t1", 1));
    await validatePass(store, full, [], fakeSource({ t1: null }, {}));
    expect(store.validated.get("t1:0")!.proofOk).toBeNull();

    const healthy = fakeSource({ t1: signedProof(1) }, { t1: 4 });
    await validatePass(store, full, [], healthy, true, [], []);
    expect(healthy.txProofs).toHaveBeenCalledTimes(1);
    expect(store.validated.get("t1:0")).toMatchObject({
      proofOk: true,
      blockIndex: 4,
    });
  });

  it("defers transactions past the per-pass fetch cap as pending, then drains them", async () => {
    const store = testStore();
    // 260 responses on 260 txs, one credential each (keyCred takes a byte, so
    // reuse credentials across txs — dedupe is not what this test is about).
    const many = Array.from({ length: 260 }, (_, i) =>
      response(`tx${i}`, i % 200),
    );
    const proofs = Object.fromEntries(
      many.map((r) => [r.txHash, signedProof(Number(r.txHash.slice(2)) % 200)]),
    );
    const source = fakeSource(
      proofs,
      Object.fromEntries(many.map((r) => [r.txHash, 1])),
    );
    await validatePass(store, records(...many), [], source);
    // One fetch pair over the first 250 txs; every response has a row, the
    // deferred ten as enrichment-pending.
    expect(source.txProofs).toHaveBeenCalledTimes(1);
    expect(source.txProofs.mock.calls[0]![0]).toHaveLength(250);
    expect(store.validated.size).toBe(260);
    const pending = [...store.validated.values()].filter(
      (r) => r.proofOk === null,
    );
    expect(pending).toHaveLength(10);

    // Next pass, with nothing in the input: the pending rows put the survey
    // on the retry list and only the deferred txs are fetched.
    await validatePass(store, records(...many), [], source, true, [], []);
    expect(source.txProofs).toHaveBeenCalledTimes(2);
    expect(source.txProofs.mock.calls[1]![0]).toHaveLength(10);
    expect(
      [...store.validated.values()].filter((r) => r.proofOk === null),
    ).toHaveLength(0);
  });

  it("marks ill-formed responses (ineligible role) as not well-formed", async () => {
    const store = testStore();
    const source = fakeSource({ t1: signedProof(1) }, { t1: 0 });
    // Role 1 (SPO) is not in DEF.eligibleRoles.
    await validatePass(store, records(response("t1", 1, Role.SPO)), [], source);
    expect(store.validated.get("t1:0")).toMatchObject({
      wellFormed: false,
      proofOk: true, // proof is orthogonal — the credential did sign the tx
    });
  });

  it("validates each response of a multi-response tx separately", async () => {
    const store = testStore();
    const source = fakeSource({ t1: signedProof(1) }, { t1: 2 });
    await validatePass(
      store,
      records(
        response("t1", 1, Role.Stakeholder, 0),
        response("t1", 2, Role.Stakeholder, 1),
      ),
      [],
      source,
    );
    // One tx → one fetch, two rows; only cred 1 signed. Key credentials, so no
    // native scripts to resolve by hash (empty needed-scripts map).
    expect(source.txProofs).toHaveBeenCalledWith(["t1"], new Map());
    expect(store.validated.get("t1:0")!.proofOk).toBe(true);
    expect(store.validated.get("t1:1")!.proofOk).toBe(false);
  });

  it("hands a script credential's hash to txProofs for by-hash resolution (finding 7)", async () => {
    const store = testStore();
    const scriptCred: Credential = {
      type: "script",
      scriptHash: Uint8Array.of(9),
    };
    const scriptHashHex = bytesToHex(scriptCred.scriptHash);
    // The proof `txProofs` returns already carries the chain-resolved script
    // (the merge happens inside the real `txProofs`; the fake just supplies the
    // post-merge proof), so mechanism A verifies.
    const proof: TxProof = {
      requiredSigners: [hexOf(9)],
      nativeScripts: [
        {
          scriptHash: scriptHashHex,
          script: { kind: "sig", keyHash: hexOf(9) },
        },
      ],
      votes: [],
    };
    const source = fakeSource({ ts: proof }, { ts: 3 });
    const scriptResp: ResponseRecord = {
      txHash: "ts",
      slot: 200,
      epochNo: 1341,
      responseIndex: 0,
      response: {
        specVersion: 5,
        surveyRef: survey.ref,
        role: Role.DRep,
        credential: scriptCred,
        answers: { type: "public", answers: [answer] },
      },
    };
    await validatePass(store, records(scriptResp), [], source);
    // The script hash is passed so the source can resolve it by hash when the
    // carrying tx doesn't attach it; a key-credentialed response passes nothing.
    expect(source.txProofs).toHaveBeenCalledWith(
      ["ts"],
      new Map([["ts", [scriptHashHex]]]),
    );
    expect(store.validated.get("ts:0")!.proofOk).toBe(true);
  });
});
