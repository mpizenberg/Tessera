/**
 * Pure role + credential logic for a responder identity.
 *
 * Scope (per product decision): a browser wallet can act as Stakeholder (holds
 * a stake credential), DRep (exposes a CIP-95 DRep key), and Keyholder (its
 * payment/spending credential — every wallet has one). SPO and CC require keys
 * browser wallets don't hold and are therefore never claimable from an identity
 * alone — a host supplies them (see `eligibility.ts`).
 *
 * Eligibility is "claimed, then validated independently" per CIP-179 — this
 * decides what an identity may *claim*; ledger-state validation is the indexer's.
 */

import { Role, type Credential, type SurveyDefinition } from "cip-179";

import { hexToBytes } from "cip-179/domain";
import type { ResponderIdentity, WalletCredential } from "./identity.js";

/** Roles the identity may claim globally. */
export function claimableRoles(identity: ResponderIdentity): Role[] {
  const roles: Role[] = [];
  if (identity.stake) roles.push(Role.Stakeholder);
  if (identity.drep) roles.push(Role.DRep);
  // Keyholder needs only a payment credential, which every wallet has. Listed
  // last so a stake/DRep-capable wallet defaults to its most specific role.
  roles.push(Role.Keyholder);
  return roles;
}

/** A wallet credential ({kind, hashHex}) as a CIP-179 {@link Credential}. */
export function walletCredToCip179(c: WalletCredential): Credential {
  return c.kind === "key"
    ? { type: "key", keyHash: hexToBytes(c.hashHex) }
    : { type: "script", scriptHash: hexToBytes(c.hashHex) };
}

/**
 * The credential a response carries when the identity responds as `role`, or
 * undefined if it can't act in that role:
 * - Keyholder   → the payment (spending) credential;
 * - Stakeholder → the stake credential;
 * - DRep        → the DRep credential (hash of the CIP-95 key).
 *
 * SPO/CC are not wallet-derivable and always yield undefined here.
 */
export function roleCredential(
  identity: ResponderIdentity,
  role: Role,
): Credential | undefined {
  switch (role) {
    case Role.Keyholder:
      return walletCredToCip179(identity.payment);
    case Role.Stakeholder:
      return identity.stake ? walletCredToCip179(identity.stake) : undefined;
    case Role.DRep:
      return identity.drep ? walletCredToCip179(identity.drep) : undefined;
    default:
      return undefined;
  }
}

/**
 * Roles the identity can actually respond as to this survey: the survey's
 * eligible roles intersected with the roles it can produce a credential for.
 *
 * This is a *claim* surface, not ledger-verified eligibility (role membership at
 * the end-epoch snapshot is the indexer's job per CIP-179). For host-trusted
 * SPO/CC credentials, see `respondableRolesFor` in `eligibility.ts`.
 */
export function respondableRoles(
  definition: SurveyDefinition,
  identity: ResponderIdentity,
): Role[] {
  return definition.eligibleRoles.filter(
    (role) => roleCredential(identity, role) !== undefined,
  );
}
