import { describe, expect, it } from "vitest";
import { blake2b } from "@noble/hashes/blake2.js";

import { bytesToHex, hexToBytes } from "../domain/index.js";
import type { DecodedNativeScript, TxProofCodec } from "./codec.js";
import { evolutionCodec } from "../evolution/index.js";
import { decodeResolvedNativeScript, decodeTxProof } from "./txProof.js";
import { DREP_VOTE_TX_CBOR, SPO_VOTE_TX_CBOR } from "./fixtures/voteTxs.js";

/** The Cardano native-script hash (blake2b-224 of `0x00 ‖ cbor`), for a cross-check. */
function scriptHashOf(scriptCborHex: string): string {
  const cbor = hexToBytes(scriptCborHex);
  const tagged = new Uint8Array(cbor.length + 1);
  tagged.set(cbor, 1); // tagged[0] stays 0 — native-script language tag
  return bytesToHex(blake2b(tagged, { dkLen: 28 }));
}

describe("decodeTxProof — voting_procedures (real preview vote txs)", () => {
  it("decodes a DRep key vote into a (tag 2) binding with the CIP-129 action id", () => {
    const proof = decodeTxProof(evolutionCodec, DREP_VOTE_TX_CBOR);
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

  it("decodes an SPO vote into a (tag 4) binding", () => {
    const proof = decodeTxProof(evolutionCodec, SPO_VOTE_TX_CBOR);
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

  it("still surfaces the mechanism-A fields alongside the votes", () => {
    // This wallet also listed the DRep key in required_signers — both
    // mechanisms' evidence ride in the same proof.
    const proof = decodeTxProof(evolutionCodec, DREP_VOTE_TX_CBOR);
    expect(proof!.requiredSigners).toEqual([
      "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57",
    ]);
    expect(proof!.nativeScripts).toEqual([]);
  });

  it("returns null on undecodable CBOR (→ unproven, never a throw)", () => {
    expect(decodeTxProof(evolutionCodec, "not-cbor")).toBeNull();
  });
});

// A native script resolved by hash from a chain index (Koios `/script_info`),
// for mechanism-A credentials whose script the carrying tx doesn't attach
// (finding 7). CBOR for a sig script over one key hash: `[0, keyhash]`.
const KEYHASH = "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57";
const SIG_SCRIPT_CBOR = `8200581c${KEYHASH}`;

describe("decodeResolvedNativeScript", () => {
  it("decodes a real sig-script CBOR and hashes it as a native script", () => {
    const resolved = decodeResolvedNativeScript(
      evolutionCodec,
      SIG_SCRIPT_CBOR,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.script).toEqual({ kind: "sig", keyHash: KEYHASH });
    // The hash is the on-chain native-script hash, so it matches the script
    // credential a response/cancellation claims.
    expect(resolved!.scriptHash).toBe(scriptHashOf(SIG_SCRIPT_CBOR));
  });

  it("returns null for a non-native (Plutus) or garbage script — no mechanism A", () => {
    expect(decodeResolvedNativeScript(evolutionCodec, "not-cbor")).toBeNull();
  });

  it("interprets whatever the codec decodes, hashing its canonical CBOR", () => {
    // A stub codec proves the interpretation is codec-driven and the hash comes
    // from the returned `scriptCbor` (not the input hex), independent of evolution.
    const scriptCbor = hexToBytes(SIG_SCRIPT_CBOR);
    const codec: Pick<TxProofCodec, "decodeNativeScript"> = {
      decodeNativeScript: (): DecodedNativeScript => ({
        scriptCbor,
        script: { _tag: "ScriptPubKey", keyHash: hexToBytes(KEYHASH) },
      }),
    };
    const resolved = decodeResolvedNativeScript(
      codec as TxProofCodec,
      "ignored-by-the-stub",
    );
    expect(resolved).toEqual({
      scriptHash: scriptHashOf(SIG_SCRIPT_CBOR),
      script: { kind: "sig", keyHash: KEYHASH },
    });
  });

  it("returns null when the codec can't decode the bytes", () => {
    const codec: Pick<TxProofCodec, "decodeNativeScript"> = {
      decodeNativeScript: () => null,
    };
    expect(
      decodeResolvedNativeScript(codec as TxProofCodec, "whatever"),
    ).toBeNull();
  });
});
