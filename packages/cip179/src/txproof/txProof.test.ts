import { describe, expect, it } from "vitest";

import { decodeTxProof } from "./txProof.js";
import { DREP_VOTE_TX_CBOR, SPO_VOTE_TX_CBOR } from "./fixtures/voteTxs.js";

describe("decodeTxProof — voting_procedures (real preview vote txs)", () => {
  it("decodes a DRep key vote into a (tag 2) binding with the CIP-129 action id", async () => {
    const proof = await decodeTxProof(DREP_VOTE_TX_CBOR);
    expect(proof).not.toBeNull();
    expect(proof!.votes).toEqual([
      {
        voterTag: 2,
        credentialHash:
          "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57",
        actionIds: [
          "gov_action1z79yzpcrex5g6w9vern7qqshwghe3e5heqnwh5g9urzmatejuq8sq5ak6sd",
        ],
      },
    ]);
  });

  it("decodes an SPO vote into a (tag 4) binding", async () => {
    const proof = await decodeTxProof(SPO_VOTE_TX_CBOR);
    expect(proof).not.toBeNull();
    expect(proof!.votes).toEqual([
      {
        voterTag: 4,
        credentialHash:
          "f78bfaffa191e3b6e676f74a2235f0eeb90cd72a1dbda134f6271b5f",
        actionIds: [
          "gov_action1kvwtx85su7x7720fn5vn870wdsy2pv36j9vqk66m740yzfa7n0ksqvdz06a",
        ],
      },
    ]);
  });

  it("still surfaces the mechanism-A fields alongside the votes", async () => {
    // This wallet also listed the DRep key in required_signers — both
    // mechanisms' evidence ride in the same proof.
    const proof = await decodeTxProof(DREP_VOTE_TX_CBOR);
    expect(proof!.requiredSigners).toEqual([
      "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57",
    ]);
    expect(proof!.nativeScripts).toEqual([]);
  });

  it("returns null on undecodable CBOR (→ unproven, never a throw)", async () => {
    expect(await decodeTxProof("not-cbor")).toBeNull();
  });
});
