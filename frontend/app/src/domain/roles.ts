/**
 * Wallet/ownership credential helpers that stay app-side.
 *
 * The respond-facing role logic (`claimableRoles`, `roleCredential`,
 * `respondableRoles`, `walletCredToCip179`) moved to `@tessera/respond-core`,
 * retyped over its slim `ResponderIdentity`. What remains here is the app's
 * *ownership* concern — does the connected wallet control a given credential —
 * used by `state.tsx` / `Create` / `Survey` / `Explore`. These stay because
 * they operate on the full CIP-30-shaped {@link WalletIdentity}, not the slim
 * responder identity.
 */

import { type Credential } from "cip-179";

import { bytesToHex } from "cip-179/domain";
import type { WalletCredential, WalletIdentity } from "~/wallet/types";

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
