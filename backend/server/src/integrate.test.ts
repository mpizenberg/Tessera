/**
 * Segment integration against its oracle: `materializeSnapshot`, the pure
 * whole-corpus rebuild. The differential suite drives seeded-random event
 * sequences — new surveys/responses/cancellations, rollbacks, link changes,
 * epoch turnover, finalized-cancelled overlays — through per-refresh segment
 * integration and asserts the stored tables are byte-identical to a full
 * rebuild's after every step. The targeted tests pin the update-matrix lines
 * that random sequences hit only occasionally.
 */

import { describe, expect, it, vi } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import {
  hexToBytes,
  refKey,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type MechanismAProof,
  type ResponseRecord,
  type SurveyRecord,
} from "cip-179/domain";

import { integrateSegment } from "./integrate";
import { listCountsOf, materializeSnapshot } from "./materialize";
import type { SlotRange, SnapshotMeta } from "./store";
import { memBackendStore, type MemBackendStore } from "./store-mem";

// --- fixtures ------------------------------------------------------------------

/** Slots per model epoch — the tip's epoch is derived from its slot. */
const EPOCH_SLOTS = 200;
/** Segment depth each refresh re-derives (the model's settlement margin). */
const MARGIN = 120;
/** Rollbacks only ever remove txs this close to the tip (stability window). */
const STABILITY = 60;

const tipAt = (slot: number): ChainTip => ({
  epoch: Math.floor(slot / EPOCH_SLOTS),
  slot,
  epochSlot: slot % EPOCH_SLOTS,
  time: 1_750_000_000 + slot,
  govActionLifetime: 6,
});

const keyCred = (b: number): Credential => ({
  type: "key",
  keyHash: Uint8Array.of(b),
});

const txHashOf = (n: number): string =>
  n.toString(16).padStart(2, "0").repeat(32);

function surveyAt(
  n: number,
  slot: number,
  endEpoch: number,
  ownerByte: number,
): SurveyRecord {
  const txHash = txHashOf(n);
  return {
    txHash,
    slot,
    epochNo: Math.floor(slot / EPOCH_SLOTS),
    ref: { txId: hexToBytes(txHash), index: 0 },
    definition: {
      specVersion: 5,
      owner: keyCred(ownerByte),
      title: `survey ${n}`,
      description: "",
      eligibleRoles: [Role.DRep, Role.Stakeholder],
      endEpoch,
      submissionMode: { type: "public" },
      questions: [
        {
          type: "singleChoice",
          prompt: "",
          options: { type: "options", labels: ["a", "b"] },
        },
      ],
    } satisfies SurveyDefinition,
  };
}

function responseAt(
  n: number,
  slot: number,
  target: SurveyRecord,
  credByte: number,
): ResponseRecord {
  return {
    txHash: txHashOf(n),
    slot,
    epochNo: Math.floor(slot / EPOCH_SLOTS),
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: target.ref,
      role: Role.Stakeholder,
      credential: keyCred(credByte),
      answers: {
        type: "public",
        answers: [{ type: "singleChoice", questionIndex: 0, optionIndex: 0 }],
      },
    },
  };
}

function cancellationAt(
  n: number,
  slot: number,
  target: SurveyRecord,
  proof: MechanismAProof | null,
): CancellationRecord {
  return {
    txHash: txHashOf(n),
    slot,
    epochNo: Math.floor(slot / EPOCH_SLOTS),
    target: target.ref,
    proof,
  };
}

/** Mechanism-A evidence signed by `signerByte`'s key hash. */
const signerProof = (signerByte: number): MechanismAProof => ({
  requiredSigners: [signerByte.toString(16).padStart(2, "0")],
  nativeScripts: [],
});

const govLinkTo = (
  target: SurveyRecord,
  actionId: string,
  endEpoch = target.definition.endEpoch,
): GovLink => ({
  surveyKey: refKey(target.ref),
  actionId,
  endEpoch,
  title: `title of ${actionId}`,
});

const metaAt = (tip: ChainTip): SnapshotMeta => ({
  tip: JSON.stringify({ epoch: tip.epoch }),
  incomplete: false,
  fetchedAt: tip.time,
  listCounts: null,
});

/** A source whose proof fetch must not be needed (all evidence in-record). */
const untouchedSource = () => ({
  txProofs: vi.fn(async () => {
    throw new Error("unexpected txProofs fetch");
  }),
});

/** A source with no evidence to offer — an unverifiable claim stays one. */
const emptySource = {
  txProofs: async () => new Map<string, null>(),
};

// --- the differential ----------------------------------------------------------

/** mulberry32 — deterministic sequences per seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Chain {
  surveys: SurveyRecord[];
  responses: ResponseRecord[];
  cancellations: CancellationRecord[];
  govLinks: GovLink[];
  finalizedCancelled: Set<string>;
}

const fullRecords = (chain: Chain): Cip179Records => ({
  surveys: chain.surveys,
  responses: chain.responses,
  cancellations: chain.cancellations,
});

const inSegment =
  (range: SlotRange) =>
  (r: { readonly slot: number }): boolean =>
    r.slot >= range.fromSlot && r.slot <= range.toSlot;

async function runRefresh(
  store: MemBackendStore,
  chain: Chain,
  tip: ChainTip,
): Promise<void> {
  const range = { fromSlot: Math.max(0, tip.slot - MARGIN), toSlot: tip.slot };
  await integrateSegment(store, emptySource, {
    records: {
      surveys: chain.surveys.filter(inSegment(range)),
      responses: chain.responses.filter(inSegment(range)),
      cancellations: chain.cancellations.filter(inSegment(range)),
    },
    range,
    tip,
    govLinks: chain.govLinks,
    govLinksReliable: true,
    finalizedCancelled: chain.finalizedCancelled,
    meta: metaAt(tip),
  });
  await store.markFinalizedCancelled([...chain.finalizedCancelled]);
}

async function expectOracleMatch(
  store: MemBackendStore,
  chain: Chain,
  tip: ChainTip,
): Promise<void> {
  const oracle = materializeSnapshot(
    fullRecords(chain),
    tip,
    chain.govLinks,
    chain.finalizedCancelled,
  );
  const everything = { fromSlot: 0, toSlot: Number.MAX_SAFE_INTEGER };
  const bySurveyKey = <T extends { surveyKey: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (a.surveyKey < b.surveyKey ? -1 : 1));
  const byTx = <T extends { txHash: string; surveyKey: string }>(
    rows: T[],
  ): T[] =>
    [...rows].sort(
      (a, b) =>
        (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) ||
        (a.surveyKey < b.surveyKey ? -1 : 1),
    );
  expect(bySurveyKey(await store.surveyRowsEndingAtOrAfter(0))).toEqual(
    bySurveyKey(oracle.surveys),
  );
  expect(byTx(await store.responseRowsInSlotRange(everything))).toEqual(
    byTx(oracle.responses),
  );
  expect(byTx(await store.cancellationRowsInSlotRange(everything))).toEqual(
    byTx(oracle.cancellations),
  );
  const counts = await store.surveyIndexCounts(tip.epoch, [], []);
  expect(listCountsOf(oracle.surveys, tip.epoch)).toEqual({
    all: counts.all,
    linked: counts.linked,
    active: counts.active,
    sealed: counts.sealed,
    public: counts.public,
  });
}

describe("segment integration vs the full-rebuild oracle", () => {
  it("stays row-identical through random event sequences", async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const rand = prng(seed * 0x9e3779b9);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(rand() * list.length)]!;
      const chain: Chain = {
        surveys: [],
        responses: [],
        cancellations: [],
        govLinks: [],
        finalizedCancelled: new Set(),
      };
      const store = memBackendStore();
      let slot = MARGIN;
      let txCounter = 1;
      let actionCounter = 1;

      for (let step = 0; step < 40; step++) {
        slot += 5 + Math.floor(rand() * 25);
        const tip = tipAt(slot);
        const events = 1 + Math.floor(rand() * 3);
        for (let e = 0; e < events; e++) {
          const roll = rand();
          const landSlot = slot - Math.floor(rand() * 5);
          if (roll < 0.25 || chain.surveys.length === 0) {
            chain.surveys.push(
              surveyAt(
                txCounter++,
                landSlot,
                tip.epoch + Math.floor(rand() * 3),
                1 + Math.floor(rand() * 4),
              ),
            );
          } else if (roll < 0.55) {
            chain.responses.push(
              responseAt(
                txCounter++,
                landSlot,
                pick(chain.surveys),
                10 + Math.floor(rand() * 6),
              ),
            );
          } else if (roll < 0.7) {
            const target = pick(chain.surveys);
            const owner = target.definition.owner;
            const ownerByte = owner.type === "key" ? owner.keyHash[0]! : 0;
            const flavor = rand();
            chain.cancellations.push(
              cancellationAt(
                txCounter++,
                landSlot,
                target,
                // Owner-proven, forged, or unverifiable — all three occur.
                flavor < 0.6
                  ? signerProof(ownerByte)
                  : flavor < 0.8
                    ? signerProof(99)
                    : null,
              ),
            );
          } else if (roll < 0.8) {
            // Rollback: a recent tx of any kind vanishes.
            const recent = <T extends { slot: number }>(rows: T[]): T[] =>
              rows.filter((r) => r.slot > slot - STABILITY);
            const candidates = [
              ...recent(chain.surveys),
              ...recent(chain.responses),
              ...recent(chain.cancellations),
            ];
            if (candidates.length > 0) {
              const victim = pick(candidates);
              chain.surveys = chain.surveys.filter((s) => s !== victim);
              chain.responses = chain.responses.filter((r) => r !== victim);
              chain.cancellations = chain.cancellations.filter(
                (c) => c !== victim,
              );
            }
          } else if (roll < 0.9) {
            // Link set change: add an (aligned or misaligned) link, or drop one.
            if (chain.govLinks.length > 0 && rand() < 0.4) {
              chain.govLinks = chain.govLinks.filter(
                (l) => l !== pick(chain.govLinks),
              );
            } else {
              const target = pick(chain.surveys);
              chain.govLinks.push(
                govLinkTo(
                  target,
                  `gov_action1x${actionCounter++}`,
                  target.definition.endEpoch + (rand() < 0.3 ? 1 : 0),
                ),
              );
            }
          } else {
            // A cancelled survey's artifact finalizes it as cancelled.
            const cancelled = chain.cancellations
              .map((c) => refKey(c.target))
              .filter((key) =>
                chain.surveys.some((s) => refKey(s.ref) === key),
              );
            if (cancelled.length > 0)
              chain.finalizedCancelled.add(pick(cancelled));
          }
        }

        await runRefresh(store, chain, tip);
        await expectOracleMatch(store, chain, tip);
      }
    }
  });

  it("expires a verified-while-open cancellation at close, matching the oracle", async () => {
    // The one tip-dependent stored flag: `cancelled` from a client-verified
    // cancellation holds only while the survey is open. When its epoch turns
    // with no tx touching it, the expiry read must put it back on the touched
    // list — the full rebuild recomputes it from the tip every run.
    const store = memBackendStore();
    const chain: Chain = {
      surveys: [surveyAt(1, 150, 1, 3)],
      responses: [],
      cancellations: [],
      govLinks: [],
      finalizedCancelled: new Set(),
    };
    chain.cancellations.push(
      cancellationAt(2, 160, chain.surveys[0]!, signerProof(3)),
    );
    await runRefresh(store, chain, tipAt(200));
    expect((await store.surveyRowsEndingAtOrAfter(0))[0]!.cancelled).toBe(true);

    // Two epochs later, nothing on-chain moved: the flag must expire…
    await runRefresh(store, chain, tipAt(450));
    await expectOracleMatch(store, chain, tipAt(450));
    expect((await store.surveyRowsEndingAtOrAfter(0))[0]!.cancelled).toBe(
      false,
    );

    // …until the finalized artifact carries it past close for good.
    chain.finalizedCancelled.add(refKey(chain.surveys[0]!.ref));
    await runRefresh(store, chain, tipAt(480));
    await expectOracleMatch(store, chain, tipAt(480));
  });
});

describe("segment integration mechanics", () => {
  const seedChain = (): Chain => ({
    surveys: [surveyAt(1, 100, 9, 3)],
    responses: [responseAt(2, 150, surveyAt(1, 100, 9, 3), 10)],
    cancellations: [],
    govLinks: [],
    finalizedCancelled: new Set(),
  });

  it("re-projects a survey on a link-set change without any tx event", async () => {
    const store = memBackendStore();
    const chain = seedChain();
    await runRefresh(store, chain, tipAt(200));

    // Far past the survey's slot: the segment no longer carries it.
    chain.govLinks.push(govLinkTo(chain.surveys[0]!, "gov_action1new"));
    await runRefresh(store, chain, tipAt(600));
    const row = (await store.surveyRowsEndingAtOrAfter(0))[0]!;
    expect(row.govLinked).toBe(true);
    expect(row.haystack).toContain("gov_action1new");
    await expectOracleMatch(store, chain, tipAt(600));

    // Same set, different order: no churn — the reconcile changes nothing.
    chain.govLinks.push(govLinkTo(chain.surveys[0]!, "gov_action1other"));
    await runRefresh(store, chain, tipAt(620));
    chain.govLinks.reverse();
    const range = { fromSlot: 620 - MARGIN, toSlot: 640 };
    const { changes } = await integrateSegment(store, untouchedSource(), {
      records: { surveys: [], responses: [], cancellations: [] },
      range,
      tip: tipAt(640),
      govLinks: chain.govLinks,
      govLinksReliable: true,
      finalizedCancelled: chain.finalizedCancelled,
      meta: metaAt(tipAt(640)),
    });
    expect(changes).toBe(0);
  });

  it("fetches the owner-proof of a cancellation whose open target is outside the segment", async () => {
    const store = memBackendStore();
    const chain = seedChain();
    await runRefresh(store, chain, tipAt(200));

    // A proofless cancellation lands long after the definition left the
    // window; the target is still open, so the evidence must be fetched.
    const cancel = cancellationAt(3, 600, chain.surveys[0]!, null);
    const source = {
      txProofs: vi.fn(async (hashes: readonly string[]) => {
        expect(hashes).toEqual([cancel.txHash]);
        return new Map([[cancel.txHash, { ...signerProof(3), votes: [] }]]);
      }),
    };
    const range = { fromSlot: 600 - MARGIN, toSlot: 600 };
    await integrateSegment(store, source, {
      records: { surveys: [], responses: [], cancellations: [cancel] },
      range,
      tip: tipAt(600),
      govLinks: [],
      govLinksReliable: true,
      finalizedCancelled: new Set(),
      meta: metaAt(tipAt(600)),
    });
    expect(source.txProofs).toHaveBeenCalledOnce();
    const row = (await store.surveyRowsEndingAtOrAfter(0))[0]!;
    expect(row.cancelled).toBe(true);
    expect(row.cancellations).toContain("requiredSigners");
  });

  it("does not resurrect a rolled-back survey whose responses made it touched", async () => {
    const store = memBackendStore();
    const survey = surveyAt(1, 500, 9, 3);
    const early = responseAt(2, 100, survey, 10);
    const chain: Chain = {
      surveys: [survey],
      responses: [early],
      cancellations: [],
      govLinks: [],
      finalizedCancelled: new Set(),
    };
    // First: integrate the response's own region, then the survey's.
    await runRefresh(store, chain, tipAt(150));
    await runRefresh(store, chain, tipAt(550));
    expect(await store.surveyRowsEndingAtOrAfter(0)).toHaveLength(1);

    // The defining tx rolls back while its slot is still in the window. The
    // stored response outside the window puts the survey on the touched list;
    // its stored definition must not win over the sweep.
    chain.surveys = [];
    await runRefresh(store, chain, tipAt(560));
    expect(await store.surveyRowsEndingAtOrAfter(0)).toEqual([]);
    // The out-of-window response row survives as an orphan — exactly what the
    // full rebuild produces from the same records.
    await expectOracleMatch(store, chain, tipAt(560));
  });

  it("upserts without sweeping when the scan is incomplete", async () => {
    const store = memBackendStore();
    const chain = seedChain();
    await runRefresh(store, chain, tipAt(200));

    // An incomplete scan listed nothing; nothing may be deleted for it.
    await integrateSegment(store, untouchedSource(), {
      records: {
        surveys: [],
        responses: [],
        cancellations: [],
        incomplete: true,
      },
      range: null,
      tip: tipAt(210),
      govLinks: [],
      govLinksReliable: true,
      finalizedCancelled: new Set(),
      meta: { ...metaAt(tipAt(210)), incomplete: true },
    });
    expect(await store.surveyRowsEndingAtOrAfter(0)).toHaveLength(1);
    expect(
      await store.responseRowsInSlotRange({ fromSlot: 0, toSlot: 10_000 }),
    ).toHaveLength(1);
  });
});
