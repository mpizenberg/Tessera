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
 *    votes on one of the survey's linked actions with the very same credential,
 *    and the Conway voter tag's role matches the claimed role (0/1→CC, 2/3→DRep,
 *    4→SPO). A survey may be linked by several actions (CIP-179 v5); a vote on
 *    *any one* of them satisfies. A qualifying vote proves on its own; anything
 *    else — no vote, a vote on an unrelated action, a mismatched role — is
 *    simply not a binding, and evaluation falls back to mechanism A (a
 *    non-qualifying vote never invalidates). No votable-window check is needed:
 *    the ledger only accepts votes on actions still in the proposal set, so an
 *    on-chain binding was necessarily cast while the action was votable.
 *    Stakeholder/Keyholder roles have no voter tag and therefore can never bind.
 *
 * The transaction evidence ({@link TxProof}) is decoded by the data source;
 * this module stays pure and unit-tested.
 */

import type { Credential, SurveyResponse } from "../index.js";
import { Role } from "../index.js";

import { bytesToHex } from "./hex.js";
import { cancellationVerified } from "./cancellation.js";
import type { TxProof, VoteBinding } from "./records.js";

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

/**
 * Mechanism A: required signers / satisfied native script. This is exactly the
 * cancellation owner-proof over the same evidence (TxProof extends
 * CancellationProof), so reuse it rather than duplicate the evaluation.
 */
function mechanismA(credential: Credential, proof: TxProof): boolean {
  return cancellationVerified(credential, proof);
}

/**
 * Whether `response`'s carrying transaction proves its claimed credential.
 * `proof` is the tx's decoded evidence (`null` = unfetchable → unproven);
 * `linkedActionIds` are the survey's linking governance actions (bech32
 * CIP-129 `gov_action1…`, empty for a standalone survey — mechanism B only
 * exists for linked surveys).
 */
export function responseCredentialProven(
  response: SurveyResponse,
  proof: TxProof | null,
  linkedActionIds: readonly string[],
): boolean {
  if (!proof) return false;

  if (linkedActionIds.length > 0) {
    // Mechanism B: a vote by the response credential on any linked action,
    // with the voter tag's role matching the claimed role, proves on its own.
    // Non-qualifying votes are not bindings — they never invalidate; mechanism
    // A below still decides. Votability needs no separate check: the ledger
    // only accepts votes on active actions.
    const qualifies = bindingsByCredential(
      response.credential,
      proof.votes,
    ).some(
      (b) =>
        b.actionIds.some((id) => linkedActionIds.includes(id)) &&
        roleOfVoterTag(b.voterTag) === response.role,
    );
    if (qualifies) return true;
  }

  return mechanismA(response.credential, proof);
}
