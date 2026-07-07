import { describe, expect, it } from "vitest";
import type { Credential, SurveyDefinition } from "cip-179";
import { refKey, type ChainTip, type SurveyRecord } from "cip-179/domain";

import type { SurveyListPayload } from "./source";
import { aggregateSurveyList } from "./surveyList";

const TIP: ChainTip = {
  epoch: 10,
  slot: 1050,
  epochSlot: 50,
  time: 1_000_000,
  govActionLifetime: 6,
};
const TXID = Uint8Array.of(0xaa);

const keyOwner = (b: number): Credential => ({
  type: "key",
  keyHash: Uint8Array.of(b),
});

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
  epochNo: 9,
  ref: { txId: TXID, index },
  definition: d,
});

describe("aggregateSurveyList — finalized-cancelled overlay (finding 19)", () => {
  // A cancelled-then-closed survey: the scan ships its cancellation with
  // proof: null (it only verifies proofs for open surveys), so client-side
  // verification alone would show it as "Ended" with only an unverified-claim
  // warning. The serving tier's finalizedCancelled keys carry the artifact's
  // verdict past close, which also supersedes that claim warning.
  const closed = survey(0, def(keyOwner(1), 8)); // endEpoch 8 < tip epoch 10
  const list = (finalizedCancelled?: readonly string[]): SurveyListPayload => ({
    surveys: [closed],
    cancellations: [
      {
        txHash: "c0-850",
        slot: 850,
        epochNo: 8,
        target: { txId: TXID, index: 0 },
        proof: null,
      },
    ],
    govLinks: [],
    tip: TIP,
    responseCounts: {},
    ...(finalizedCancelled && { finalizedCancelled }),
  });

  it("a finalized-cancelled key marks the closed survey cancelled", () => {
    const a = aggregateSurveyList(list([refKey(closed.ref)]))[0]!;
    expect(a.cancelled).toBe(true);
    expect(a.cancellationClaimed).toBe(false);
    expect(a.status).toBe("cancelled");
  });

  it("without the overlay the closed survey stays 'ended' but keeps the claim warning", () => {
    const a = aggregateSurveyList(list())[0]!;
    expect(a.cancelled).toBe(false);
    expect(a.cancellationClaimed).toBe(true);
    expect(a.status).toBe("ended");
  });
});
