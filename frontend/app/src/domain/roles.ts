/**
 * Wallet role/credential + ownership helpers — all app-side.
 *
 * `cardano-tessera-respond-core` deliberately knows nothing about wallets: its
 * `Responder` is a plain role→credential map it takes verbatim (it never
 * validates a credential — the carrying transaction does, host-side). So the
 * wallet→role derivation lives here, next to the wallet seam, operating on the
 * full CIP-30-shaped {@link WalletIdentity}:
 * - `claimableRoles` / `roleCredential` / `respondableRoles` — which roles a
 *   wallet can claim and the credential each carries;
 * - `ownerCredential` — the credential a survey it creates is owned by;
 * - `walletResponder` — the `Responder` map handed to `<tessera-respond>`;
 * - `walletOwns` / `walletCanProveOwner` — the *ownership* concern (does the
 *   wallet control a given credential, and can it prove that), used by `Survey`
 *   and `Explore`.
 */

import { Role, type Credential, type SurveyDefinition } from "cip-179";

import { bytesToHex, hexToBytes } from "cip-179/domain";
import type { Responder } from "cardano-tessera-respond-core";
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
 * Derived from {@link roleCredential} so a role is offered exactly when the
 * credential backing it can be proven.
 */
export function claimableRoles(identity: WalletIdentity): Role[] {
  return [Role.Stakeholder, Role.DRep, Role.Keyholder].filter(
    (role) => roleCredential(identity, role) !== undefined,
  );
}

/**
 * A wallet credential the app can actually prove control of, as a CIP-179
 * {@link Credential} — undefined when it can't. The in-browser CIP-179 proof is
 * a `required_signers` signature, which only a key credential can produce, so a
 * script credential yields nothing. Every credential the app would have the
 * wallet prove passes through here, so a script wallet is never offered an
 * action it would only fail to submit.
 */
function provable(cred: WalletCredential | undefined): Credential | undefined {
  return cred?.kind === "key" ? walletCredToCip179(cred) : undefined;
}

/**
 * The credential a response carries when the wallet responds as `role`:
 * Keyholder → payment, Stakeholder → stake, DRep → DRep. Undefined for a role
 * the wallet can't act in, including the never-wallet-derivable SPO / CC and
 * any role a script credential would back (see {@link provable}).
 */
export function roleCredential(
  identity: WalletIdentity,
  role: Role,
): Credential | undefined {
  let cred: WalletCredential | undefined;
  switch (role) {
    case Role.Keyholder:
      cred = identity.payment;
      break;
    case Role.Stakeholder:
      cred = identity.stake;
      break;
    case Role.DRep:
      cred = identity.drep;
      break;
  }
  return provable(cred);
}

/**
 * The credential a survey created by this wallet is owned by: its payment
 * credential, which signs the funding transaction anyway, so ownership is
 * proven on publication and provable again on a later cancellation. Undefined
 * when that credential is script-based (see {@link provable}) — such a wallet
 * can't author a survey from the browser at all.
 */
export function ownerCredential(
  identity: WalletIdentity,
): Credential | undefined {
  return provable(identity.payment);
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

/**
 * Does the wallet control this credential — its payment or its stake one? Note
 * that a script credential can match: controlling one and being able to *prove*
 * control of it are different questions, and this answers the first.
 */
export function walletOwns(
  identity: WalletIdentity,
  owner: Credential,
): boolean {
  const target = toWalletCredential(owner);
  if (credEquals(identity.payment, target)) return true;
  return identity.stake !== undefined && credEquals(identity.stake, target);
}

/**
 * Can the wallet publish a transaction proving it owns this survey — the tag-2
 * cancellation? Owning it isn't enough: the proof is a `required_signers`
 * signature (see {@link provable}), so a script owner the wallet controls can
 * be matched but never proven.
 */
export function walletCanProveOwner(
  identity: WalletIdentity,
  owner: Credential,
): boolean {
  return owner.type === "key" && walletOwns(identity, owner);
}
