/**
 * Decode owner-proof evidence from a cancelling transaction's CBOR.
 *
 * Owner-proof for a CIP-179 cancellation lives in the transaction, not the
 * metadata: the survey's `owner` credential must be proven via the tx body's
 * `required_signers` (key-based) or a native script in the witness set that they
 * satisfy (mechanism A). This reads exactly those two fields and nothing else.
 *
 * evolution-sdk is heavy and otherwise confined to the write path, so it (and
 * the blake2b hasher) are dynamically imported here — the module's static
 * footprint on the read path is negligible, and the SDK chunk loads only when a
 * cancellation actually needs verifying. `Transaction.fromCBORHex` decodes every
 * post-Alonzo transaction (all CIP-179 txs are recent); any decode failure
 * returns `null`, so the cancellation is treated as unverified — the safe side.
 */

import { bytesToHex } from "@tessera/core";
import type { CancellationProof, NativeScriptInfo } from "@tessera/core";

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
 * Decode `required_signers` and witness-set native scripts from a transaction's
 * CBOR hex, or `null` if the transaction can't be decoded (→ unverified).
 */
export async function decodeCancellationProof(
  txCborHex: string,
): Promise<CancellationProof | null> {
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

    return { requiredSigners, nativeScripts };
  } catch (err) {
    console.warn(`could not decode cancellation proof: ${String(err)}`);
    return null;
  }
}
