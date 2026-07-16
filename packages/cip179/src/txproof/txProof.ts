/**
 * Interpret a transaction's credential-proof evidence into a {@link TxProof}.
 *
 * CIP-179 credential proof lives in the transaction, not the metadata:
 *  - **Mechanism A** — the tx body's `required_signers` (key-based) or a native
 *    script in the witness set that they satisfy. Used by cancellation
 *    owner-proof and response credential-proof alike.
 *  - **Mechanism B** — the tx body's `voting_procedures` (Conway field 19):
 *    a response credential can prove itself by voting on the survey's linked
 *    governance action in the same transaction. Surfaced as
 *    {@link TxProof.votes}, evaluated in core's `responseCredentialProven`.
 *
 * The transaction itself is decoded by an injected {@link TxProofCodec} (the
 * `@evolution-sdk/evolution` adapter or any other Cardano stack — see
 * `cip-179/evolution`); this module imports no serialization library. It owns
 * only the CIP-179 interpretation of the neutral {@link DecodedTx}: native-script
 * hashing + render model, and the Conway voter-tag semantics. Any decode or
 * interpretation failure yields `null`, so the credential is treated as unproven
 * — the safe side.
 */

import { blake2b } from "@noble/hashes/blake2.js";

import { bytesToHex } from "../domain/index.js";
import type {
  NativeScriptInfo,
  TxProof,
  VoteBinding,
} from "../domain/index.js";

import type { NativeScriptNode, TxProofCodec, VoterNode } from "./codec.js";

/** blake2b-224 over `0x00 ‖ scriptCbor` — the Cardano native-script hash. */
function nativeScriptHash(scriptCbor: Uint8Array): string {
  const tagged = new Uint8Array(scriptCbor.length + 1);
  tagged[0] = 0x00; // native script language tag
  tagged.set(scriptCbor, 1);
  return bytesToHex(blake2b(tagged, { dkLen: 28 }));
}

/** Convert a native-script node (wrapper or bare variant) to {@link NativeScriptInfo}. */
function toInfo(node: NativeScriptNode): NativeScriptInfo {
  const v = node._tag === "NativeScript" ? node.script : node;
  switch (v._tag) {
    case "ScriptPubKey":
      return { kind: "sig", keyHash: bytesToHex(v.keyHash) };
    case "ScriptAll":
      return { kind: "all", scripts: v.scripts.map(toInfo) };
    case "ScriptAny":
      return { kind: "any", scripts: v.scripts.map(toInfo) };
    case "ScriptNOfK":
      return {
        kind: "atLeast",
        required: Number(v.required),
        scripts: v.scripts.map(toInfo),
      };
    case "InvalidBefore":
    case "InvalidHereafter":
      return { kind: "timelock" };
    default:
      // Unknown variant: throw so the caller falls back to null (unverified)
      // rather than silently mis-evaluating an unfamiliar script.
      throw new Error(
        `unknown native script variant: ${String((v as { _tag: string })._tag)}`,
      );
  }
}

/** Conway voter tag + credential hash of a voter, or null (Abstain/NoConf). */
function voterCredential(
  voter: VoterNode,
): { voterTag: number; credentialHash: string } | null {
  switch (voter._tag) {
    case "ConstitutionalCommitteeVoter":
      return {
        voterTag: voter.credential._tag === "KeyHash" ? 0 : 1,
        credentialHash: bytesToHex(voter.credential.hash),
      };
    case "DRepVoter":
      switch (voter.drep._tag) {
        case "KeyHashDRep":
          return {
            voterTag: 2,
            credentialHash: bytesToHex(voter.drep.keyHash.hash),
          };
        case "ScriptHashDRep":
          return {
            voterTag: 3,
            credentialHash: bytesToHex(voter.drep.scriptHash.hash),
          };
        default:
          // Abstain/NoConfidence carry no credential — can't bind a response.
          return null;
      }
    case "StakePoolVoter":
      return {
        voterTag: 4,
        credentialHash: bytesToHex(voter.poolKeyHash.hash),
      };
  }
}

/**
 * Interpret a native script resolved **by hash** (from a chain index, not the
 * carrying tx's witness set) into the `{ scriptHash, script }` shape a
 * {@link TxProof} carries in `nativeScripts`, or `null` if `scriptCborHex` isn't
 * a decodable native script (a Plutus script → `null`, so it resolves nothing
 * and the credential stays unproven — a Plutus owner has no mechanism-A path).
 *
 * CIP-179 mechanism A allows the native script backing a script credential to be
 * resolved through chain indexing when the metadata-only transaction that
 * carries the response/cancellation doesn't attach it. A data source fetches the
 * script CBOR by hash (e.g. Koios `/script_info`) and folds the result into the
 * relevant tx's `TxProof.nativeScripts`; the pure {@link cancellationVerified} /
 * {@link responseCredentialProven} evaluation is then unchanged — it still just
 * looks the script hash up in `nativeScripts`. The hash is recomputed from the
 * (re-canonicalised) CBOR exactly as for a witness script, so a source returning
 * bytes that don't hash to the requested credential simply won't match it.
 */
export function decodeResolvedNativeScript(
  codec: TxProofCodec,
  scriptCborHex: string,
): { scriptHash: string; script: NativeScriptInfo } | null {
  const decoded = codec.decodeNativeScript(scriptCborHex);
  if (!decoded) return null;
  try {
    return {
      scriptHash: nativeScriptHash(decoded.scriptCbor),
      script: toInfo(decoded.script),
    };
  } catch (err) {
    console.warn(`could not interpret resolved native script: ${String(err)}`);
    return null;
  }
}

/**
 * Interpret a transaction's credential-proof evidence — `required_signers`,
 * witness-set native scripts (mechanism A) and vote bindings (mechanism B) —
 * decoding its CBOR through `codec`, or `null` if it can't be decoded or
 * interpreted (→ unproven).
 */
export function decodeTxProof(
  codec: TxProofCodec,
  txCborHex: string,
): TxProof | null {
  const decoded = codec.decodeTx(txCborHex);
  if (!decoded) return null;
  try {
    const nativeScripts = decoded.nativeScripts.map((ns) => ({
      scriptHash: nativeScriptHash(ns.scriptCbor),
      script: toInfo(ns.script),
    }));

    const votes: VoteBinding[] = [];
    for (const vote of decoded.votes) {
      // Abstain/NoConfidence voters bind nothing — skip before encoding, so
      // their entries cost nothing and can't fail the whole proof.
      const cred = voterCredential(vote.voter);
      if (!cred) continue;
      const actionIds = vote.actions.map((a) =>
        codec.govActionId(a.txIdHex, a.index),
      );
      votes.push({ ...cred, actionIds });
    }

    return { requiredSigners: decoded.requiredSigners, nativeScripts, votes };
  } catch (err) {
    console.warn(`could not interpret tx proof: ${String(err)}`);
    return null;
  }
}
