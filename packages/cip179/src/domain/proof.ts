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

/**
 * Roles that carry a Conway voter tag and so *can* be proven via a governance
 * vote binding (mechanism B) — the only roles whose verdict depends on a
 * survey's gov links. Stakeholder/Keyholder have no voter tag, so their proof
 * is link-independent (mechanism A only) and never turns "unknown" on an
 * unresolved anchor.
 */
export const BINDABLE_ROLES: ReadonlySet<Role> = new Set([
  Role.CC,
  Role.DRep,
  Role.SPO,
]);

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
 * Whether the response casts a *qualifying* mechanism-B vote — by its own
 * credential (hash AND kind), on one of `actionIds`, with the voter tag's role
 * matching the claimed role. Shared by the resolved-link check (does it prove?)
 * and the unresolved-link check (could it yet prove?).
 */
function qualifiesVia(
  response: SurveyResponse,
  proof: TxProof,
  actionIds: readonly string[],
): boolean {
  return bindingsByCredential(response.credential, proof.votes).some(
    (b) =>
      b.actionIds.some((id) => actionIds.includes(id)) &&
      roleOfVoterTag(b.voterTag) === response.role,
  );
}

/**
 * Three-valued credential-proof verdict:
 *  - `proven` — mechanism A, or a qualifying vote on a *resolved* linked action;
 *  - `unproven` — no evidence proves it and none could (final);
 *  - `unknown` — not proven by resolved evidence, but the response casts a
 *    qualifying vote on an epoch-aligned action whose anchor couldn't be
 *    resolved, so if that anchor turns out to link this survey the verdict flips
 *    to proven. The caller must NOT freeze `unknown` as a negative (finding 6).
 */
export type CredentialProof = "proven" | "unproven" | "unknown";

/**
 * Three-valued form of {@link responseCredentialProven}. `linkedActionIds` are
 * the survey's *resolved* linking actions; `unresolvedActionIds` are its
 * epoch-aligned actions whose anchor couldn't be resolved (pass empty when links
 * are fully resolved — then the result is only `proven`/`unproven`). A `proven`
 * verdict is final regardless of unresolved anchors (mechanism B only ever adds
 * proof), so the unknown branch is reached only for an otherwise-unproven
 * response — keeping the uncertainty as narrow as possible.
 */
export function responseCredentialProof(
  response: SurveyResponse,
  proof: TxProof | null,
  linkedActionIds: readonly string[],
  unresolvedActionIds: readonly string[] = [],
): CredentialProof {
  if (!proof) return "unproven";

  // Mechanism B on a resolved link, then mechanism A: either proves outright.
  // A non-qualifying vote is not a binding — it never invalidates. Votability
  // needs no separate check: the ledger only accepts votes on active actions.
  if (
    linkedActionIds.length > 0 &&
    qualifiesVia(response, proof, linkedActionIds)
  )
    return "proven";
  if (mechanismA(response.credential, proof)) return "proven";

  // Not proven by resolved evidence. Could an as-yet-unresolved epoch-aligned
  // link the response voted on still prove it? Then the verdict is not final.
  if (
    unresolvedActionIds.length > 0 &&
    qualifiesVia(response, proof, unresolvedActionIds)
  )
    return "unknown";

  return "unproven";
}

/**
 * Whether `response`'s carrying transaction proves its claimed credential.
 * `proof` is the tx's decoded evidence (`null` = unfetchable → unproven);
 * `linkedActionIds` are the survey's linking governance actions (bech32
 * CIP-129 `gov_action1…`, empty for a standalone survey — mechanism B only
 * exists for linked surveys). Thin two-valued wrapper over
 * {@link responseCredentialProof} for callers that don't distinguish "unknown".
 */
export function responseCredentialProven(
  response: SurveyResponse,
  proof: TxProof | null,
  linkedActionIds: readonly string[],
): boolean {
  return responseCredentialProof(response, proof, linkedActionIds) === "proven";
}
