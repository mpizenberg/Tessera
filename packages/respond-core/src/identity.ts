/**
 * The slim responder identity the role/eligibility logic runs on.
 *
 * This is deliberately *not* the app's CIP-30-shaped `WalletIdentity` (network
 * id, change address, wallet name, …). It carries only the credentials role
 * derivation needs, so a host embedding `<tessera-respond>` never has to
 * fabricate app-only fields — it maps whatever identity it has down to this.
 */

/** A key- or script-hash credential, as hex. Moved from the app's wallet seam. */
export interface WalletCredential {
  readonly kind: "key" | "script";
  readonly hashHex: string;
}

/**
 * Everything role derivation needs — nothing CIP-30- or app-shaped:
 * - `payment`: the spending credential every wallet has (→ Keyholder);
 * - `stake`: the stake credential, if any (→ Stakeholder);
 * - `drep`: the DRep credential (hash of the CIP-95 key), if any (→ DRep).
 */
export interface ResponderIdentity {
  readonly payment: WalletCredential;
  readonly stake?: WalletCredential;
  readonly drep?: WalletCredential;
}
