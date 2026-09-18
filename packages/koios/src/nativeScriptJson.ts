/**
 * A native script as Koios serves it: `/script_info`'s `value`, cardano-api's
 * JSON form (db-sync keeps native scripts as JSON only, never their bytes).
 */

import { NativeScripts } from "@evolution-sdk/evolution";

import { hexToBytes, type NativeScriptInfo } from "cip-179/domain";
import { evolutionCodec } from "cip-179/evolution";
import { decodeResolvedNativeScript } from "cip-179/txproof";

export type NativeScriptJson =
  | { readonly type: "sig"; readonly keyHash: string }
  | {
      readonly type: "all" | "any";
      readonly scripts: readonly NativeScriptJson[];
    }
  | {
      readonly type: "atLeast";
      readonly required: number;
      readonly scripts: readonly NativeScriptJson[];
    }
  | { readonly type: "after" | "before"; readonly slot: number };

function variant(json: NativeScriptJson): NativeScripts.NativeScriptVariants {
  switch (json.type) {
    case "sig":
      return { _tag: "ScriptPubKey", keyHash: hexToBytes(json.keyHash) };
    case "all":
      return { _tag: "ScriptAll", scripts: json.scripts.map(variant) };
    case "any":
      return { _tag: "ScriptAny", scripts: json.scripts.map(variant) };
    case "atLeast":
      return {
        _tag: "ScriptNOfK",
        required: BigInt(json.required),
        scripts: json.scripts.map(variant),
      };
    case "after":
      return { _tag: "InvalidBefore", slot: BigInt(json.slot) };
    case "before":
      return { _tag: "InvalidHereafter", slot: BigInt(json.slot) };
    default:
      throw new Error(
        `unknown native script type: ${String((json as { type: unknown }).type)}`,
      );
  }
}

/**
 * The script rebuilt as canonical CBOR, decoded and hashed; null if the JSON
 * describes no native script. The hash is the on-chain one exactly when the
 * script was canonically encoded on chain.
 */
export function rebuildNativeScript(
  json: NativeScriptJson | null,
): { scriptHash: string; script: NativeScriptInfo } | null {
  if (!json) return null;
  try {
    const cbor = NativeScripts.toCBORHex(
      new NativeScripts.NativeScript({ script: variant(json) }),
    );
    return decodeResolvedNativeScript(evolutionCodec, cbor);
  } catch (err) {
    console.warn(`could not rebuild native script: ${String(err)}`);
    return null;
  }
}
