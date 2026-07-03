/**
 * Bech32 credential encodings for Koios queries and artifacts — thin wrappers
 * over evolution-sdk (no hand-rolled bech32 anywhere):
 *
 *  - `stakeAddress` — CIP-19 reward address (`stake…`/`stake_test…`) for a
 *    Stakeholder credential, what `/account_stake_history` & co. key on.
 *  - `drepId` — CIP-129 DRep id (`drep1…`, header 0x22 key / 0x23 script),
 *    what `/drep_voting_power_history` keys on.
 *  - `govActionId` — CIP-129 governance action id (`gov_action1…`,
 *    tx id ‖ index byte), the form vote bindings are compared in.
 *
 * evolution-sdk is heavy, so it's dynamically imported (same discipline as
 * `txProof.ts`) — these run on the server/verifier path only.
 */

import type { Credential } from "cip-179";

import { hexToBytes } from "@tessera/core";

type Sdk = typeof import("@evolution-sdk/evolution");

let sdkPromise: Promise<Sdk> | null = null;
function sdk(): Promise<Sdk> {
  return (sdkPromise ??= import("@evolution-sdk/evolution"));
}

/**
 * The bech32 reward (stake) address of a stake credential. CIP-19 header:
 * high nibble 0xE for a key hash, 0xF for a script hash; low nibble is the
 * network id (0 testnets, 1 mainnet).
 */
export async function stakeAddress(
  credential: Credential,
  network: string,
): Promise<string> {
  const { RewardAccount } = await sdk();
  const isScript = credential.type === "script";
  const hash = isScript ? credential.scriptHash : credential.keyHash;
  const bytes = new Uint8Array(1 + hash.length);
  bytes[0] = (isScript ? 0xf0 : 0xe0) | (network === "mainnet" ? 1 : 0);
  bytes.set(hash, 1);
  return RewardAccount.toBech32(RewardAccount.fromBytes(bytes));
}

/** The CIP-129 bech32 DRep id (`drep1…`) of a DRep credential. */
export async function drepId(credential: Credential): Promise<string> {
  const { DRep, KeyHash, ScriptHash } = await sdk();
  const drep =
    credential.type === "key"
      ? DRep.fromKeyHash(KeyHash.fromBytes(credential.keyHash))
      : DRep.fromScriptHash(ScriptHash.fromBytes(credential.scriptHash));
  return DRep.toBech32(drep);
}

/** The CIP-129 bech32 governance action id (`gov_action1…`). */
export async function govActionId(
  txIdHex: string,
  index: number,
): Promise<string> {
  const { Bech32, Schema } = await sdk();
  const txId = hexToBytes(txIdHex);
  const bytes = new Uint8Array(txId.length + 1);
  bytes.set(txId, 0);
  bytes[txId.length] = index;
  return Schema.decodeSync(Bech32.FromBytes("gov_action"))(bytes);
}
