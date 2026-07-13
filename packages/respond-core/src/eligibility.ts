/**
 * Eligibility with host-trusted credentials.
 *
 * `roles.ts` derives roles a browser wallet can claim on its own (Keyholder,
 * Stakeholder, DRep). SPO and CC need keys a browser wallet doesn't hold, so a
 * host supplies them verbatim via {@link Responder.hostCredentials}; the widget
 * trusts them and lists them in `proveCredentials` for the host to satisfy via
 * `required_signers`.
 *
 * Named `respondableRolesFor` (not `respondableRoles`) so it doesn't collide
 * with the wallet-only {@link respondableRoles} in `roles.ts` — both are
 * exported from the package index.
 */

import { Role, type Credential, type SurveyDefinition } from "cip-179";

import type { ResponderIdentity } from "./identity.js";
import { roleCredential } from "./roles.js";

export interface Responder {
  /** The slim wallet-derived identity, if the responder has a connected wallet. */
  identity?: ResponderIdentity;
  /** Host-trusted credentials for roles a browser wallet can't derive (SPO, CC). */
  hostCredentials?: Partial<Record<Role, Credential>>;
}

/**
 * Credential for a chosen role: wallet-derived first ({@link roleCredential}),
 * then a host-trusted one. Tolerates an absent `identity` (a host may embed with
 * only an SPO credential).
 */
export function credentialForRole(
  role: Role,
  responder: Responder,
): Credential | undefined {
  const fromWallet = responder.identity
    ? roleCredential(responder.identity, role)
    : undefined;
  return fromWallet ?? responder.hostCredentials?.[role];
}

/**
 * Roles the responder may claim = eligible ∩ (wallet-derivable ∪ host-provided).
 * Tolerates an absent `identity`.
 */
export function respondableRolesFor(
  def: SurveyDefinition,
  responder: Responder,
): Role[] {
  return def.eligibleRoles.filter(
    (role) => credentialForRole(role, responder) !== undefined,
  );
}
