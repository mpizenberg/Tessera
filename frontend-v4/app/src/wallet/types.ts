/**
 * Wallet seam — the app talks to CIP-30 wallets only through these types, so
 * evolution-sdk (the concrete implementation in `cip30.ts`) stays isolated,
 * mirroring the `DataSource` seam on the read side.
 */

/** A wallet advertised on `window.cardano`. */
export interface InstalledWallet {
  readonly key: string;
  readonly name: string;
  readonly icon: string;
}

/** A key- or script-hash credential, as hex. */
export interface WalletCredential {
  readonly kind: "key" | "script";
  readonly hashHex: string;
}

/** Everything we read from a connected wallet (no signing data). */
export interface WalletIdentity {
  readonly walletKey: string;
  readonly walletName: string;
  /** CIP-30 network id: 0 = testnet, 1 = mainnet. */
  readonly networkId: number;
  readonly changeAddressBech32: string;
  readonly payment: WalletCredential;
  /** Present for base addresses (absent for enterprise). */
  readonly stake: WalletCredential | undefined;
  /** Raw CIP-95 public DRep key (hex), if the wallet supports CIP-95. */
  readonly drepKeyHex: string | undefined;
  /**
   * DRep credential (key hash = blake2b-224 of {@link drepKeyHex}), present iff
   * the wallet exposed a CIP-95 DRep key. This is what a DRep response carries.
   */
  readonly drep: WalletCredential | undefined;
}

/** A connected wallet: its identity plus the raw CIP-30 handle for signing. */
export interface ConnectedWallet {
  readonly identity: WalletIdentity;
  /** Raw CIP-30 API, retained for transaction signing in later milestones. */
  readonly api: Cip30Api;
}

// --- Minimal CIP-30 / CIP-95 surface we rely on -----------------------------

export interface Cip30Api {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  getRewardAddresses(): Promise<string[]>;
  /** Wallet's own UTxOs as CBOR hex (each `[input, output]`); may be empty/absent. */
  getUtxos(): Promise<string[] | undefined>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
  cip95?: {
    getPubDRepKey?(): Promise<string>;
  };
}

export interface Cip30WalletEntry {
  readonly name: string;
  readonly icon: string;
  readonly apiVersion?: string;
  enable(opts?: { extensions?: Array<{ cip: number }> }): Promise<Cip30Api>;
  isEnabled(): Promise<boolean>;
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30WalletEntry | undefined>;
  }
}
