/**
 * Decode credential-proof evidence from a transaction's CBOR.
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
 * evolution-sdk is heavy and otherwise confined to the write path, so it (and
 * the blake2b hasher) are dynamically imported here — the module's static
 * footprint on the read path is negligible, and the SDK chunk loads only when a
 * proof actually needs decoding. `Transaction.fromCBORHex` decodes every
 * post-Alonzo transaction (all CIP-179 txs are recent); any decode failure
 * returns `null`, so the credential is treated as unproven — the safe side.
 */

import { bytesToHex } from "@tessera/core";
import type { NativeScriptInfo, TxProof, VoteBinding } from "@tessera/core";

import { govActionId } from "./bech32";

/**
 * Minimal structural view of an evolution-sdk native script that tolerates both
 * runtime shapes: the `{_tag:"NativeScript", script}` wrapper and a bare variant
 * (nested children have been observed in either form). Narrowed locally so the
 * recursion is typed without depending on the SDK's effect-schema types.
 */
type RawNativeScript =
  | { readonly _tag: "NativeScript"; readonly script: RawNativeScript }
  | { readonly _tag: "ScriptPubKey"; readonly keyHash: Uint8Array }
  | { readonly _tag: "ScriptAll"; readonly scripts: readonly RawNativeScript[] }
  | { readonly _tag: "ScriptAny"; readonly scripts: readonly RawNativeScript[] }
  | {
      readonly _tag: "ScriptNOfK";
      readonly required: bigint;
      readonly scripts: readonly RawNativeScript[];
    }
  | {
      readonly _tag: "InvalidBefore" | "InvalidHereafter";
      readonly slot: bigint;
    };

/** blake2b-224 over `0x00 ‖ scriptCbor` — the Cardano native-script hash. */
function nativeScriptHash(
  blake2b: (msg: Uint8Array, opts: { dkLen: number }) => Uint8Array,
  scriptCbor: Uint8Array,
): string {
  const tagged = new Uint8Array(scriptCbor.length + 1);
  tagged[0] = 0x00; // native script language tag
  tagged.set(scriptCbor, 1);
  return bytesToHex(blake2b(tagged, { dkLen: 28 }));
}

/** Convert an SDK native script (wrapper or bare variant) to {@link NativeScriptInfo}. */
function toInfo(node: RawNativeScript): NativeScriptInfo {
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

/**
 * Minimal structural view of a decoded `voting_procedures` entry — the SDK's
 * runtime shape (verified against real preview vote transactions), narrowed
 * locally like {@link RawNativeScript}. `procedures` is a
 * `Map<voter, Map<govActionId, procedure>>` at runtime; typed as iterables of
 * pairs so both Maps and plain pair-arrays satisfy it.
 */
interface RawVotingProcedures {
  readonly procedures: Iterable<
    readonly [RawVoter, Iterable<readonly [RawGovActionId, unknown]>]
  >;
}

type RawVoter =
  | {
      readonly _tag: "ConstitutionalCommitteeVoter";
      readonly credential:
        | { readonly _tag: "KeyHash"; readonly hash: Uint8Array }
        | { readonly _tag: "ScriptHash"; readonly hash: Uint8Array };
    }
  | {
      readonly _tag: "DRepVoter";
      readonly drep:
        | {
            readonly _tag: "KeyHashDRep";
            readonly keyHash: { readonly hash: Uint8Array };
          }
        | {
            readonly _tag: "ScriptHashDRep";
            readonly scriptHash: { readonly hash: Uint8Array };
          }
        | { readonly _tag: "AlwaysAbstainDRep" }
        | { readonly _tag: "AlwaysNoConfidenceDRep" };
    }
  | {
      readonly _tag: "StakePoolVoter";
      readonly poolKeyHash: { readonly hash: Uint8Array };
    };

interface RawGovActionId {
  readonly transactionId: { readonly hash: Uint8Array | string };
  readonly govActionIndex: bigint | number;
}

/** Conway voter tag + credential hash of a voter, or null (Abstain/NoConf). */
function voterCredential(
  voter: RawVoter,
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

/** The tx's vote bindings, as (voter tag, credential, voted action ids). */
async function decodeVotes(
  votingProcedures: RawVotingProcedures | undefined | null,
): Promise<VoteBinding[]> {
  if (!votingProcedures?.procedures) return [];
  const votes: VoteBinding[] = [];
  for (const [voter, entries] of votingProcedures.procedures) {
    const cred = voterCredential(voter);
    if (!cred) continue;
    const actionIds = await Promise.all(
      [...entries].map(([ga]) => {
        const hash = ga.transactionId.hash;
        const txIdHex = typeof hash === "string" ? hash : bytesToHex(hash);
        return govActionId(txIdHex, Number(ga.govActionIndex));
      }),
    );
    votes.push({ ...cred, actionIds });
  }
  return votes;
}

/**
 * Decode a transaction's credential-proof evidence — `required_signers`,
 * witness-set native scripts (mechanism A) and vote bindings (mechanism B) —
 * from its CBOR hex, or `null` if it can't be decoded (→ unproven).
 */
export async function decodeTxProof(
  txCborHex: string,
): Promise<TxProof | null> {
  try {
    const [{ Transaction, KeyHash, NativeScripts }, { blake2b }] =
      await Promise.all([
        import("@evolution-sdk/evolution"),
        import("@noble/hashes/blake2.js"),
      ]);

    const tx = Transaction.fromCBORHex(txCborHex);

    const requiredSigners = (tx.body.requiredSigners ?? []).map((k) =>
      KeyHash.toHex(k),
    );

    const raw = tx.witnessSet?.nativeScripts;
    const nativeScripts =
      Array.isArray(raw) && raw.length > 0
        ? raw.map((ns) => ({
            scriptHash: nativeScriptHash(
              blake2b,
              NativeScripts.toCBORBytes(ns),
            ),
            script: toInfo(ns as unknown as RawNativeScript),
          }))
        : [];

    const votes = await decodeVotes(
      tx.body.votingProcedures as unknown as RawVotingProcedures | undefined,
    );

    return { requiredSigners, nativeScripts, votes };
  } catch (err) {
    console.warn(`could not decode tx proof: ${String(err)}`);
    return null;
  }
}

/**
 * Cancellation owner-proof is the mechanism-A slice of {@link decodeTxProof};
 * kept as a named alias for the read path that only verifies cancellations.
 */
export const decodeCancellationProof = decodeTxProof;
