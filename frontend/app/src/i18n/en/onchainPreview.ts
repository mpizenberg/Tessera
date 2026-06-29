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
    "These are the answers as they'll be timelock-encrypted when you submit — nothing is encrypted yet. The on-chain payload will be the resulting ciphertext, zero-padded{padding} so its size never reveals how much you answered. The fee is computed at submit time.",
  /** Spliced into {padding} of noteSealed only when the padding size is known. */
  noteSealedPadding: " to {size} B",
};

export type Messages = typeof onchainPreview;
export default onchainPreview;
