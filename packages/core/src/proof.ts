/**
 * Pure credential-proof evaluation for CIP-179 survey responses — §6.3 rule 2,
 * "not deferrable past the first tally": without it, anyone can publish a
 * response claiming any credential.
 *
 * A response proves its credential through its carrying transaction:
 *  - **Mechanism A** — the credential's key hash is in the tx body's
 *    `required_signers` (ledger-guaranteed signature), or its native script is
 *    in the witness set and satisfied by those signers. Same evidence, same
 *    evaluation as cancellation owner-proof ({@link cancellationVerified}).
 *  - **Mechanism B** (governance-linked surveys only) — the transaction also
 *    votes on the survey's linked action with the very same credential, and
 *    the Conway voter tag's role matches the claimed role (0/1→CC, 2/3→DRep,
 *    4→SPO). A binding by the response credential that is *present but
 *    failing* (wrong action, wrong role) invalidates the response even if
 *    mechanism A would pass; an *absent* binding is not a failure — evaluation
 *    just falls back to mechanism A. Stakeholder/Keyholder roles have no voter tag
 *    and therefore can never bind.
 *
 * The transaction evidence ({@link TxProof}) is decoded by the data source;
 * this module stays pure and unit-tested.
 */

import type { Credential, SurveyResponse } from "cip-179";
import { Role } from "cip-179";

import { bytesToHex } from "./hex";
import { nativeScriptSatisfied } from "./cancellation";
import type { TxProof, VoteBinding } from "./source";

/** The CIP-179 role a Conway voter tag proves, or null for an unknown tag. */
export function roleOfVoterTag(voterTag: number): Role | null {
  switch (voterTag) {
    case 0:
    case 1:
      return Role.CC;
    case 2:
    case 3:
      return Role.DRep;
    case 4:
      return Role.SPO;
    default:
      return null;
  }
}

/** Whether a voter tag carries a key (vs native/Plutus script) credential. */
function voterTagIsKey(voterTag: number): boolean {
  // 0 CC hot key, 2 DRep key, 4 SPO pool key; 1/3 are script credentials.
  return voterTag === 0 || voterTag === 2 || voterTag === 4;
}

function credentialHashHex(credential: Credential): string {
  return credential.type === "key"
    ? bytesToHex(credential.keyHash)
    : bytesToHex(credential.scriptHash);
}

/** The tx's vote bindings cast *by the response credential* (hash AND kind). */
function bindingsByCredential(
  credential: Credential,
  votes: readonly VoteBinding[],
): VoteBinding[] {
  const hash = credentialHashHex(credential);
  const isKey = credential.type === "key";
  return votes.filter(
    (v) => v.credentialHash === hash && voterTagIsKey(v.voterTag) === isKey,
  );
}

/** Mechanism A: required signers / satisfied native script (same as owner-proof). */
function mechanismA(credential: Credential, proof: TxProof): boolean {
  if (credential.type === "key") {
    return proof.requiredSigners.includes(bytesToHex(credential.keyHash));
  }
  const wanted = bytesToHex(credential.scriptHash);
  const ns = proof.nativeScripts.find((s) => s.scriptHash === wanted);
  if (!ns) return false;
  return nativeScriptSatisfied(ns.script, new Set(proof.requiredSigners));
}

/**
 * Whether `response`'s carrying transaction proves its claimed credential.
 * `proof` is the tx's decoded evidence (`null` = unfetchable → unproven);
 * `linkedActionId` is the survey's linking governance action (bech32
 * CIP-129 `gov_action1…`), or `null` for a standalone survey — mechanism B
 * only exists for linked surveys.
 */
export function responseCredentialProven(
  response: SurveyResponse,
  proof: TxProof | null,
  linkedActionId: string | null,
): boolean {
  if (!proof) return false;

  if (linkedActionId !== null) {
    const bindings = bindingsByCredential(response.credential, proof.votes);
    if (bindings.length > 0) {
      // A binding by this credential exists — it alone decides (a failing
      // binding invalidates even when mechanism A would pass).
      return bindings.some(
        (b) =>
          b.actionIds.includes(linkedActionId) &&
          roleOfVoterTag(b.voterTag) === response.role,
      );
    }
  }

  return mechanismA(response.credential, proof);
}
