/**
 * Wallet seam — the app talks to CIP-30 wallets only through these types, so
 * evolution-sdk (the concrete implementation in `cip30.ts`) stays isolated,
 * mirroring the `DataSource` seam on the read side.
 */

/** A key- or script-hash credential, as hex — the app's wallet-seam credential. */
export interface WalletCredential {
  readonly kind: "key" | "script";
  readonly hashHex: string;
}

/** A wallet advertised on `window.cardano`. */
export interface InstalledWallet {
  readonly key: string;
  readonly name: string;
  readonly icon: string;
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
  /** Raw CIP-30 API, used for transaction signing. */
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
  /**
   * CIP-103 bulk signing, when the wallet granted the extension. One prompt for
   * a list of transactions, which the wallet walks in order — so a transaction
   * spending what an earlier one in the list produces resolves, before any of
   * them has been submitted. Witness sets come back positionally; a refusal
   * anywhere returns none of them.
   */
  cip103?: {
    signTxs(
      txs: readonly { cbor: string; partialSign: boolean }[],
    ): Promise<string[]>;
    /**
     * Broadcast in the order given, every one attempted even after one fails.
     * Resolves to their ids; on any failure it *throws* the same array with a
     * `TxSendError` where an id would have been.
     */
    submitTxs?(txs: readonly string[]): Promise<string[]>;
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
