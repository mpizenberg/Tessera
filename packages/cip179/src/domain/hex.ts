/** Hex <-> bytes helpers (lowercase, no "0x" prefix). */

const HEX_RE = /^[0-9a-fA-F]*$/;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  // `parseInt(_, 16)` yields NaN (coerced to 0) on non-hex chars, so a garbage
  // string would silently decode to wrong bytes — reject it up front instead.
  if (!HEX_RE.test(clean)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
