/**
 * CIP-30 wallet implementation of the wallet seam, using evolution-sdk only to
 * parse addresses into credentials. Asks for two extensions where the wallet
 * has them: CIP-95 for its public DRep key, CIP-103 for signing a whole chain
 * of transactions in one prompt.
 */

import { Address, Credential } from "@evolution-sdk/evolution";
import { blake2b } from "@noble/hashes/blake2.js";

import { bytesToHex, hexToBytes } from "cip-179/domain";
import type {
  Cip30Api,
  Cip30WalletEntry,
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

/**
 * Did the wallet report the user saying no — CIP-30 `APIError.Refused` (−3) at
 * connect, or `TxSignError.UserDeclined` (2) at signing? Neither code means
 * anything else in the other's enum, so one predicate covers both prompts.
 * Wallets throw loose objects rather than `Error`s, so the shape is checked
 * defensively.
 */
export function isRefusal(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code } = e as { code?: unknown };
  return code === -3 || code === 2;
}

const declined = (): Error =>
  new Error("Connection declined in the wallet — nothing was connected.");

/**
 * Whether the dApp is already authorized for this wallet (CIP-30 `isEnabled`).
 * When true, {@link connectWallet} can re-enable it without a user prompt — the
 * basis for silent auto-reconnect on reload. Safe (returns false) if the wallet
 * is absent or throws.
 */
export async function isWalletEnabled(key: string): Promise<boolean> {
  const entry = window.cardano?.[key];
  if (!entry) return false;
  try {
    return await entry.isEnabled();
  } catch {
    return false;
  }
}

/**
 * Enable a wallet, asking for as many extensions as it will grant: CIP-95 for
 * the DRep key, CIP-103 to sign a chain in one prompt. A wallet may reject the
 * whole call over a single extension it doesn't implement, so each rung of the
 * ladder drops what the one above couldn't get.
 *
 * A refusal is the user's answer to the connect prompt, not a verdict on an
 * extension — asking again would prompt twice for the same thing. Unless the
 * dApp is already authorized: then what was refused is the extension alone, and
 * a plainer enable still runs without prompting, so a silent reconnect must not
 * turn that into a disconnect.
 */
async function enableWallet(
  key: string,
  entry: Cip30WalletEntry,
): Promise<Cip30Api> {
  const ladder = [[{ cip: 95 }, { cip: 103 }], [{ cip: 95 }], []];
  let last: unknown;
  for (const extensions of ladder) {
    try {
      return await entry.enable(
        extensions.length > 0 ? { extensions } : undefined,
      );
    } catch (e) {
      last = e;
      if (isRefusal(e) && !(await isWalletEnabled(key))) throw declined();
    }
  }
  throw isRefusal(last) ? declined() : last;
}

/** Enable a wallet and read its identity (no signing performed). */
export async function connectWallet(key: string): Promise<ConnectedWallet> {
  const entry = window.cardano?.[key];
  if (!entry) throw new Error(`Wallet "${key}" is not installed`);

  const api = await enableWallet(key, entry);
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
