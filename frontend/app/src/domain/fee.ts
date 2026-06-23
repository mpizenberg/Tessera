/**
 * A rough Cardano transaction min-fee estimate, for the Pro on-chain preview.
 *
 * The protocol min fee is linear in the serialized transaction size:
 *
 *     fee = txFeePerByte · size + txFeeFixed
 *
 * The two coefficients are protocol parameters, but they've been stable for
 * years and are identical on mainnet and preview, so we inline them rather than
 * round-trip to Koios for a live figure. The serialized size is approximated as
 * the label-17 metadata payload plus a fixed allowance for the rest of a minimal
 * signed transaction (one input, a change output, the tx body, the auxiliary-data
 * wrapper, and a vkey witness). A real transaction's size varies with coin
 * selection and the number of credential-proof witnesses, so this is an
 * estimate to size up a payload — not a quote.
 */

/** Lovelace charged per serialized byte (`txFeePerByte`). */
export const TX_FEE_PER_BYTE = 44n;

/** Flat lovelace added to every transaction (`txFeeFixed`). */
export const TX_FEE_FIXED = 155381n;

/**
 * Byte allowance for everything in a minimal signed tx except the label-17
 * metadata payload: one input, a change output, the body, the auxiliary-data
 * map wrapper, and a single vkey witness. Approximate by design.
 */
export const BASE_TX_BYTES = 320;

/** Maximum serialized transaction size the ledger accepts (`maxTxSize`). */
export const MAX_TX_BYTES = 16384;

/** Estimated min fee (lovelace) for a tx carrying `metadataBytes` of payload. */
export function estimateMinFee(metadataBytes: number): bigint {
  const size = BigInt(metadataBytes + BASE_TX_BYTES);
  return TX_FEE_PER_BYTE * size + TX_FEE_FIXED;
}

/** Format lovelace as ADA with 6 decimal places (e.g. `0.172321`). */
export function lovelaceToAda(lovelace: bigint): string {
  const neg = lovelace < 0n;
  const abs = neg ? -lovelace : lovelace;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
