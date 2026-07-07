import { describe, expect, it } from "vitest";
import type { Credential, SurveyDefinition } from "../index.js";

import { bytesToHex } from "./hex.js";
import type {
  CancellationProof,
  CancellationRecord,
  ChainTip,
  Cip179Records,
  SurveyRecord,
} from "./records.js";
import { aggregateSurveys, voteDeadlineUnix } from "./survey.js";

// Cancellation tri-state keys off tip.epoch vs the survey's end_epoch: a survey
// is "open" (its cancellations are considered) while tip.epoch ≤ end_epoch, and
// "closed" otherwise. TIP sits at epoch 10, so end_epoch 10 is open and end_epoch
// 8 is closed. The cancellation slots in the fixtures are inert — kept only as
// plausible data, since open-vs-closed no longer depends on the cancellation slot.
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
  epochNo: 9,
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
  epochNo: Math.floor(slot / 100),
  target: { txId: TXID, index },
  proof: p,
});

const recs = (
  surveys: SurveyRecord[],
  cancellations: CancellationRecord[],
): Cip179Records => ({ surveys, responses: [], cancellations });

const agg1 = (r: Cip179Records) => aggregateSurveys(r, TIP)[0]!;

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

  it("keeps an in-window cancellation on a closed survey visible as a claim (finding 6)", () => {
    // endEpoch 8 < tip epoch 10 → closed. The cancellation lands in-window
    // (epoch 8), but a closed survey's proof is never fetched/verified here, so
    // it surfaces as an unverified *claim* (the warning stays visible) while
    // `cancelled` stays false — only the finalized-cancelled overlay closes it.
    const a = agg1(
      recs(
        [survey(0, def(keyOwner(1), 8))],
        [cancel(0, 800, proof([ownerHex(1)]))],
      ),
    );
    expect(a.cancelled).toBe(false);
    expect(a.cancellationClaimed).toBe(true);
    expect(a.status).toBe("ended");
  });

  it("ignores a cancellation published after the survey's window closed", () => {
    // endEpoch 8, cancellation in epoch 9 (slot 950) → after the window, so
    // invalid per §6.3 and not even a claim.
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

describe("voteDeadlineUnix", () => {
  // TIP: epoch 10 began at unix 999_950 (time 1_000_000 − epochSlot 50).
  // Each epoch spans SPE = 100s, so epoch N starts at 999_950 + (N − 10) * 100.
  const SPE = 100;

  it("is the start of the epoch after endEpoch (responses valid through it)", () => {
    // endEpoch 10 → cutoff is the start of epoch 11.
    expect(voteDeadlineUnix(10, TIP, SPE)).toBe(1_000_050);
    // endEpoch 12 → start of epoch 13.
    expect(voteDeadlineUnix(12, TIP, SPE)).toBe(1_000_250);
  });

  it("handles a survey ending in the previous epoch (cutoff = current start)", () => {
    // endEpoch 9 → cutoff is the start of epoch 10 = 999_950.
    expect(voteDeadlineUnix(9, TIP, SPE)).toBe(999_950);
  });
});
