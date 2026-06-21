/**
 * Pure role + credential logic for a connected wallet.
 *
 * Scope (per product decision): a browser wallet can act as Stakeholder (holds
 * a stake credential), DRep (exposes a CIP-95 DRep key), and Owner (its
 * credential matches a survey's owner). SPO and CC require keys browser wallets
 * don't hold and are therefore never claimable here.
 *
 * Eligibility is "claimed, then validated independently" per CIP-179 — this
 * decides what the wallet may *claim*; ledger-state validation is the indexer's.
 */

import { Role, type Credential } from "cip-179";

import { bytesToHex } from "~/util/hex";
import type { WalletCredential, WalletIdentity } from "~/wallet/types";

/** Roles the wallet may claim globally (Owner is per-survey, see `walletOwns`). */
export function claimableRoles(identity: WalletIdentity): Role[] {
  const roles: Role[] = [];
  if (identity.stake) roles.push(Role.Stakeholder);
  if (identity.drepKeyHex) roles.push(Role.DRep);
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
