/**
 * Pure owner-proof verification for CIP-179 survey cancellations.
 *
 * A cancellation payload (tag 2) is a bare `survey_ref` carrying no proof of its
 * own — anyone can publish one referencing any survey. Authenticity comes from
 * the *cancelling transaction* proving the survey definition's `owner` credential
 * via CIP-179 "mechanism A":
 *   - key-based owner `[0, keyhash]`: `keyhash ∈ tx.required_signers`. The ledger
 *     guarantees a matching signature witness, so on an accepted tx this *is* the
 *     proof — no need to inspect witnesses.
 *   - native-script owner `[1, scripthash]`: the tx's `required_signers` must
 *     satisfy the native script (resolved from the tx's witness set).
 * Mechanism B (governance-vote binding) is responses-only, so a Plutus-script
 * owner has no cancellation path and can never be verified here.
 *
 * The transaction evidence ({@link CancellationProof}) is gathered by the data
 * source (it requires fetching + decoding the cancelling tx); this module stays
 * pure and unit-tested.
 */

import type { Credential } from "cip-179";

import { bytesToHex } from "~/util/hex";
import type { CancellationProof, NativeScriptInfo } from "~/data/source";

/**
 * Whether a set of signer key hashes (hex) satisfies a native script's signature
 * conditions. Timelock clauses are validity-interval constraints the ledger
 * already enforced, not signer conditions, so they evaluate to `true` here.
 */
export function nativeScriptSatisfied(
  script: NativeScriptInfo,
  signers: ReadonlySet<string>,
): boolean {
  switch (script.kind) {
    case "sig":
      return signers.has(script.keyHash);
    case "all":
      return script.scripts.every((s) => nativeScriptSatisfied(s, signers));
    case "any":
      return script.scripts.some((s) => nativeScriptSatisfied(s, signers));
    case "atLeast":
      return (
        script.scripts.filter((s) => nativeScriptSatisfied(s, signers))
          .length >= script.required
      );
    case "timelock":
      return true;
  }
}

/**
 * Whether `proof` (evidence from the cancelling tx) proves control of `owner` —
 * i.e. the cancellation is authentic per CIP-179 mechanism A. Returns `false`
 * when the proof is absent, when a key-based owner isn't among the required
 * signers, or when a script owner's native script isn't present in (or satisfied
 * by) the transaction. A Plutus-script owner is always `false`: only native
 * scripts appear in the witness set, so none will match its hash.
 */
export function cancellationVerified(
  owner: Credential,
  proof: CancellationProof | null,
): boolean {
  if (!proof) return false;
  if (owner.type === "key") {
    return proof.requiredSigners.includes(bytesToHex(owner.keyHash));
  }
  const wanted = bytesToHex(owner.scriptHash);
  const ns = proof.nativeScripts.find((s) => s.scriptHash === wanted);
  if (!ns) return false;
  return nativeScriptSatisfied(ns.script, new Set(proof.requiredSigners));
}
