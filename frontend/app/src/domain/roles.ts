/**
 * Wallet role/credential + ownership helpers — all app-side.
 *
 * `@tessera/respond-core` deliberately knows nothing about wallets: its
 * `Responder` is a plain role→credential map it takes verbatim (it never
 * validates a credential — the carrying transaction does, host-side). So the
 * wallet→role derivation lives here, next to the wallet seam, operating on the
 * full CIP-30-shaped {@link WalletIdentity}:
 * - `claimableRoles` / `roleCredential` / `respondableRoles` — which roles a
 *   wallet can claim and the credential each carries;
 * - `walletResponder` — the `Responder` map handed to `<tessera-respond>`;
 * - `walletControls` / `walletOwns` — the *ownership* concern (does the wallet
 *   control a given credential), used by `state.tsx` / `Create` / `Survey` /
 *   `Explore`.
 */

import { Role, type Credential, type SurveyDefinition } from "cip-179";

import { bytesToHex, hexToBytes } from "cip-179/domain";
import type { Responder } from "@tessera/respond-core";
import type { WalletCredential, WalletIdentity } from "~/wallet/types";

/** A wallet credential ({kind, hashHex}) as a CIP-179 {@link Credential}. */
export function walletCredToCip179(c: WalletCredential): Credential {
  return c.kind === "key"
    ? { type: "key", keyHash: hexToBytes(c.hashHex) }
    : { type: "script", scriptHash: hexToBytes(c.hashHex) };
}

/**
 * Roles the wallet may claim globally (independent of any survey). Keyholder is
 * listed last so a stake/DRep-capable wallet defaults to its most specific role.
 */
export function claimableRoles(identity: WalletIdentity): Role[] {
  const roles: Role[] = [];
  if (identity.stake) roles.push(Role.Stakeholder);
  if (identity.drep) roles.push(Role.DRep);
  roles.push(Role.Keyholder);
  return roles;
}

/**
 * The credential a response carries when the wallet responds as `role`:
 * Keyholder → payment, Stakeholder → stake, DRep → DRep. Undefined for a role
 * the wallet can't act in, including the never-wallet-derivable SPO / CC.
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

/** Roles the wallet can respond as to `def`: its eligible roles ∩ claimable. */
export function respondableRoles(
  def: SurveyDefinition,
  identity: WalletIdentity,
): Role[] {
  return def.eligibleRoles.filter(
    (role) => roleCredential(identity, role) !== undefined,
  );
}

/**
 * The wallet's role→credential {@link Responder} for `<tessera-respond>`: every
 * role the wallet can claim, mapped to the credential it would carry. SPO / CC
 * keys a browser wallet can't hold are absent — a host that vouches for one adds
 * it as an extra entry before handing the map to the widget.
 */
export function walletResponder(identity: WalletIdentity): Responder {
  const responder: Responder = {};
  for (const role of claimableRoles(identity)) {
    const cred = roleCredential(identity, role);
    if (cred) responder[role] = cred;
  }
  return responder;
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
