import { describe, expect, it } from "vitest";
import type { Credential, SurveyDefinition } from "cip-179";

import { bytesToHex } from "~/util/hex";
import type {
  CancellationProof,
  CancellationRecord,
  ChainTip,
  Cip179Records,
  SurveyRecord,
} from "~/data/source";
import { aggregateSurveys } from "./survey";

// epoch start slot = tip.slot − tip.epochSlot = 1000; secondsPerEpoch 100, so
// slot 950 → epoch 9, slot 1050 → epoch 10.
const TIP: ChainTip = {
  epoch: 10,
  slot: 1050,
  epochSlot: 50,
  time: 1_000_000,
  govActionLifetime: 6,
};
const SPE = 100;
const TXID = Uint8Array.of(0xaa);

const keyOwner = (b: number): Credential => ({
  type: "key",
  keyHash: Uint8Array.of(b),
});
const ownerHex = (b: number) => bytesToHex(Uint8Array.of(b));

const def = (owner: Credential, endEpoch: number): SurveyDefinition => ({
  specVersion: 4,
  owner,
  title: "t",
  description: "",
  eligibleRoles: [],
  endEpoch,
  submissionMode: { type: "public" },
  questions: [],
});

const survey = (index: number, d: SurveyDefinition): SurveyRecord => ({
  txHash: `s${index}`,
  slot: 900,
  ref: { txId: TXID, index },
  definition: d,
});

const proof = (signers: string[]): CancellationProof => ({
  requiredSigners: signers,
  nativeScripts: [],
});

const cancel = (
  index: number,
  slot: number,
  p: CancellationProof | null,
): CancellationRecord => ({
  txHash: `c${index}-${slot}`,
  slot,
  target: { txId: TXID, index },
  proof: p,
});

const recs = (
  surveys: SurveyRecord[],
  cancellations: CancellationRecord[],
): Cip179Records => ({ surveys, responses: [], cancellations });

const agg1 = (r: Cip179Records) => aggregateSurveys(r, TIP, SPE)[0]!;

describe("aggregateSurveys — cancellation tri-state", () => {
  it("owner-proven cancellation marks the survey cancelled", () => {
    const a = agg1(
      recs(
        [survey(0, def(keyOwner(1), 10))],
        [cancel(0, 950, proof([ownerHex(1)]))],
      ),
    );
    expect(a.cancelled).toBe(true);
    expect(a.cancellationClaimed).toBe(false);
    expect(a.status).toBe("cancelled");
  });

  it("unproven cancellation is a claim only — survey stays active", () => {
    const a = agg1(
      recs(
        [survey(0, def(keyOwner(1), 10))],
        [cancel(0, 950, proof([ownerHex(2)]))],
      ),
    );
    expect(a.cancelled).toBe(false);
    expect(a.cancellationClaimed).toBe(true);
    expect(a.status).toBe("active");
  });

  it("missing proof (unfetchable tx) is treated as an unverified claim", () => {
    const a = agg1(
      recs([survey(0, def(keyOwner(1), 10))], [cancel(0, 950, null)]),
    );
    expect(a.cancelled).toBe(false);
    expect(a.cancellationClaimed).toBe(true);
  });

  it("a verified cancellation wins even when an unverified one also exists", () => {
    const a = agg1(
      recs(
        [survey(0, def(keyOwner(1), 10))],
        [
          cancel(0, 950, proof([ownerHex(2)])),
          cancel(0, 960, proof([ownerHex(1)])),
        ],
      ),
    );
    expect(a.cancelled).toBe(true);
    expect(a.cancellationClaimed).toBe(false);
  });

  it("a cancellation after end_epoch is invalid and ignored", () => {
    // endEpoch 8, cancellation at slot 950 → epoch 9 > 8, so it doesn't count.
    const a = agg1(
      recs(
        [survey(0, def(keyOwner(1), 8))],
        [cancel(0, 950, proof([ownerHex(1)]))],
      ),
    );
    expect(a.cancelled).toBe(false);
    expect(a.cancellationClaimed).toBe(false);
    expect(a.status).toBe("ended");
  });

  it("no cancellation → neither flag", () => {
    const a = agg1(recs([survey(0, def(keyOwner(1), 10))], []));
    expect(a.cancelled).toBe(false);
    expect(a.cancellationClaimed).toBe(false);
    expect(a.status).toBe("active");
  });
});
