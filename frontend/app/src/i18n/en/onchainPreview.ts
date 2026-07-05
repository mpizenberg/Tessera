/** Canonical namespace example — see ./index.ts for the convention. */

const onchainPreview = {
  titlePublic: "On-chain preview",
  titleSealed: "Plaintext to seal",
  encBadge: "encrypted on submit",
  /** Byte size in the head row; {size} is already locale-formatted. */
  bytes: "{size} B",
  /** Fee chip; {ada} is a preformatted ADA amount. */
  feeApprox: "≈ {ada} ₳",
  encoding: "Encoding…",
  emptyForm: "Complete the form to preview the label-17 payload.",
  formatLabel: "Preview format",
  formatDiagnostic: "Diagnostic",
  formatHex: "Hex",
  copy: "Copy",
  copied: "Copied ✓",
  notePublic:
    "Estimated min fee for a simple transaction — the real fee depends on coin selection and witnesses. Payload is {size} of {max} max tx bytes.",
  noteSealed:
    "The preview below is your plaintext answers — nothing is encrypted yet. On submit they're timelock-encrypted to a fixed-size ciphertext, zero-padded{padding} so its size never reveals how much you answered. The size and fee above are that on-chain ciphertext payload: {size} of {max} max tx bytes.",
  /** Spliced into {padding} of noteSealed only when the padding size is known. */
  noteSealedPadding: " to {size} B",
};

export type Messages = typeof onchainPreview;
export default onchainPreview;
