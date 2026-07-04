/**
 * Pure role + credential logic for a connected wallet.
 *
 * Scope (per product decision): a browser wallet can act as Stakeholder (holds
 * a stake credential), DRep (exposes a CIP-95 DRep key), and Keyholder (its
 * payment/spending credential — every wallet has one). SPO and CC require keys
 * browser wallets don't hold and are therefore never claimable here.
 *
 * Eligibility is "claimed, then validated independently" per CIP-179 — this
 * decides what the wallet may *claim*; ledger-state validation is the indexer's.
 */

import { Role, type Credential, type SurveyDefinition } from "cip-179";

import { bytesToHex, hexToBytes } from "@tessera/core";
import type { WalletCredential, WalletIdentity } from "~/wallet/types";

/** Roles the wallet may claim globally. */
export function claimableRoles(identity: WalletIdentity): Role[] {
  const roles: Role[] = [];
  if (identity.stake) roles.push(Role.Stakeholder);
  if (identity.drepKeyHex) roles.push(Role.DRep);
  // Keyholder needs only a payment credential, which every wallet has. Listed
  // last so a stake/DRep-capable wallet defaults to its most specific role.
  roles.push(Role.Keyholder);
  return roles;
}

/** A CIP-179 credential as a comparable {kind, hashHex}. */
export function toWalletCredential(cred: Credential): WalletCredential {
  return cred.type === "key"
    ? { kind: "key", hashHex: bytesToHex(cred.keyHash) }
    : { kind: "script", hashHex: bytesToHex(cred.scriptHash) };
}

function credEquals(a: WalletCredential, b: WalletCredential): boolean {
  return a.kind === b.kind && a.hashHex === b.hashHex;
}

/** Does the wallet control this credential (payment or stake)? */
export function walletControls(
  identity: WalletIdentity,
  cred: Credential,
): boolean {
  const target = toWalletCredential(cred);
  if (credEquals(identity.payment, target)) return true;
  return identity.stake !== undefined && credEquals(identity.stake, target);
}

/** Is the wallet the owner of a survey (its credential matches the owner)? */
export function walletOwns(
  identity: WalletIdentity,
  owner: Credential,
): boolean {
  return walletControls(identity, owner);
}

/** A wallet credential ({kind, hashHex}) as a CIP-179 {@link Credential}. */
export function walletCredToCip179(c: WalletCredential): Credential {
  return c.kind === "key"
    ? { type: "key", keyHash: hexToBytes(c.hashHex) }
    : { type: "script", scriptHash: hexToBytes(c.hashHex) };
}

/**
 * The credential a response carries when the wallet responds as `role`, or
 * undefined if the wallet can't act in that role:
 * - Keyholder   → the wallet's payment (spending) credential;
 * - Stakeholder → the wallet's stake credential;
 * - DRep        → the wallet's DRep credential (hash of its CIP-95 key).
 *
 * SPO/CC are unsupported in-browser and always yield undefined.
 */
export function roleCredential(
  identity: WalletIdentity,
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
 * Roles the wallet can actually respond as to this survey: the survey's eligible
 * roles intersected with the roles the wallet can produce a credential for.
 *
 * This is a *claim* surface, not ledger-verified eligibility (role membership at
 * the end-epoch snapshot is the indexer's job per CIP-179).
 */
export function respondableRoles(
  definition: SurveyDefinition,
  identity: WalletIdentity,
): Role[] {
  return definition.eligibleRoles.filter(
    (role) => roleCredential(identity, role) !== undefined,
  );
}
