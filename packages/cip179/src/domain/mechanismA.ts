/**
 * Pure CIP-179 "mechanism A" evaluation: does a transaction prove control of a
 * credential?
 *
 *   - key-based `[0, keyhash]`: `keyhash ∈ tx.required_signers`. The ledger
 *     guarantees a matching signature witness, so on an accepted tx this *is* the
 *     proof — no need to inspect witnesses.
 *   - native-script `[1, scripthash]`: the tx's `required_signers` must satisfy
 *     the native script (resolved from the tx's witness set).
 *   - Plutus-script `[1, scripthash]`: never provable this way — a Plutus script
 *     needs a redeemer, and metadata has no redeemer tag.
 *
 * Three CIP-179 obligations reduce to exactly this evaluation over the same
 * evidence, which is why it lives in one place: a definition transaction proving
 * its `owner`, a cancelling transaction proving that same `owner`, and a
 * response transaction proving its responder `credential` (which may *also* use
 * mechanism B — see {@link import("./proof")}, the only one of the three with a
 * second path).
 *
 * The transaction evidence ({@link MechanismAProof}) is gathered by the data
 * source (it requires fetching + decoding the transaction); this module stays
 * pure and unit-tested.
 */

import type { Credential } from "../index.js";

import { bytesToHex } from "./hex.js";
import type { MechanismAProof, NativeScriptInfo } from "./records.js";

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
 * Whether `proof` (a transaction's evidence) proves control of `credential`.
 * Returns `false` when the proof is absent, when a key credential isn't among
 * the required signers, or when a script credential's native script isn't
 * present in (or satisfied by) the transaction. A Plutus-script credential is
 * always `false`: only native scripts appear in the witness set, so none will
 * match its hash.
 *
 * `false` means *this evidence does not prove it*, which is a final verdict only
 * when the evidence was actually read. A caller that couldn't fetch the tx holds
 * `null` for two different reasons and must not collapse them — see how
 * `finalize` postpones on an unresolved proof rather than treating it as a
 * negative.
 */
export function mechanismAProven(
  credential: Credential,
  proof: MechanismAProof | null,
): boolean {
  if (!proof) return false;
  if (credential.type === "key") {
    return proof.requiredSigners.includes(bytesToHex(credential.keyHash));
  }
  const wanted = bytesToHex(credential.scriptHash);
  const ns = proof.nativeScripts.find((s) => s.scriptHash === wanted);
  if (!ns) return false;
  return nativeScriptSatisfied(ns.script, new Set(proof.requiredSigners));
}
