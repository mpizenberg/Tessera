/**
 * CIP-30 wallet implementation of the wallet seam, using evolution-sdk only to
 * parse addresses into credentials. Requests the CIP-95 extension so we can
 * read the wallet's public DRep key when available.
 */

import { Address, Credential } from "@evolution-sdk/evolution";
import { blake2b } from "@noble/hashes/blake2.js";

import { bytesToHex, hexToBytes } from "~/util/hex";
import type {
  Cip30Api,
  ConnectedWallet,
  InstalledWallet,
  WalletCredential,
  WalletIdentity,
} from "./types";

/** Wallets advertised on `window.cardano`, sorted by name. */
export function listInstalledWallets(): InstalledWallet[] {
  const root = window.cardano;
  if (!root) return [];
  const out: InstalledWallet[] = [];
  for (const key of Object.keys(root)) {
    const entry = root[key];
    if (entry && typeof entry.enable === "function" && entry.name) {
      out.push({ key, name: entry.name, icon: entry.icon });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function toWalletCredential(cred: {
  _tag: string;
  hash: Uint8Array;
}): WalletCredential {
  return {
    kind: cred._tag === "ScriptHash" ? "script" : "key",
    hashHex: Credential.toHex(cred as never),
  };
}

/**
 * Derive a DRep key-hash credential from a CIP-95 public DRep key.
 *
 * `getPubDRepKey` returns the raw Ed25519 public key (32 bytes) as hex; the DRep
 * credential is its blake2b-224 (28-byte) hash. Returns undefined if the key is
 * absent or not a well-formed 32-byte hex string.
 */
function drepCredentialFromKey(
  drepKeyHex: string | undefined,
): WalletCredential | undefined {
  if (!drepKeyHex) return undefined;
  try {
    const key = hexToBytes(drepKeyHex);
    if (key.length !== 32) return undefined;
    const hash = blake2b(key, { dkLen: 28 });
    return { kind: "key", hashHex: bytesToHex(hash) };
  } catch {
    return undefined;
  }
}

/** Enable a wallet and read its identity (no signing performed). */
export async function connectWallet(key: string): Promise<ConnectedWallet> {
  const entry = window.cardano?.[key];
  if (!entry) throw new Error(`Wallet "${key}" is not installed`);

  // Request CIP-95 (DRep key); fall back to a plain enable if unsupported.
  let api: Cip30Api;
  try {
    api = await entry.enable({ extensions: [{ cip: 95 }] });
  } catch {
    api = await entry.enable();
  }

  const networkId = await api.getNetworkId();
  const changeHex = await api.getChangeAddress();
  const address = Address.fromHex(changeHex);

  const payment = address.paymentCredential;
  if (!payment) {
    throw new Error("Wallet address has no payment credential");
  }

  let drepKeyHex: string | undefined;
  try {
    drepKeyHex = await api.cip95?.getPubDRepKey?.();
  } catch {
    drepKeyHex = undefined;
  }

  const identity: WalletIdentity = {
    walletKey: key,
    walletName: entry.name,
    networkId,
    changeAddressBech32: Address.toBech32(address),
    payment: toWalletCredential(payment),
    stake: address.stakingCredential
      ? toWalletCredential(address.stakingCredential)
      : undefined,
    drepKeyHex,
    drep: drepCredentialFromKey(drepKeyHex),
  };

  return { identity, api };
}
