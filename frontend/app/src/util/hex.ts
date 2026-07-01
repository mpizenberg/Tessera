/**
 * Hex <-> bytes helpers. Moved to `@tessera/core` (shared with the serving tier
 * and verifier); this re-export keeps the `~/util/hex` import path stable.
 */
export { bytesToHex, hexToBytes } from "@tessera/core";
