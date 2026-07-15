/**
 * Who is answering, and which roles they can respond as.
 *
 * A {@link Responder} is just the credential the responder asserts for each
 * role it can act as — a browser wallet's payment/stake/DRep credentials,
 * host-trusted SPO/CC keys, or both, in one uniform map. respond-core takes
 * these *verbatim*: it does not (and cannot) verify that the responder controls
 * them. Authenticity is bound host-side by the carrying transaction (CIP-179
 * credential proof — a `required_signers` entry or a governance-vote binding),
 * so deriving this map from whatever identity a host holds is the host's job,
 * not respond-core's. The app builds it from a CIP-30 wallet in
 * `frontend/app/src/domain/roles.ts` (`walletResponder`).
 */

import { type Credential, type Role, type SurveyDefinition } from "cip-179";

/**
 * The credential this responder asserts for each role it can act as. Roles a
 * browser wallet derives (Keyholder / Stakeholder / DRep) and host-trusted ones
 * (SPO / CC) are all just entries here — respond-core does not distinguish
 * their provenance, and never validates them.
 */
export type Responder = Partial<Record<Role, Credential>>;

/** The credential this responder asserts for `role`, if any. */
export function credentialForRole(
  role: Role,
  responder: Responder,
): Credential | undefined {
  return responder[role];
}

/**
 * Roles the responder may claim to this survey: the survey's eligible roles
 * intersected with the roles the responder has a credential for. A *claim*
 * surface, not ledger-verified eligibility (that's the indexer's, per CIP-179).
 */
export function respondableRolesFor(
  def: SurveyDefinition,
  responder: Responder,
): Role[] {
  return def.eligibleRoles.filter((role) => responder[role] !== undefined);
}
