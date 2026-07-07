/**
 * Analytic size of a sealed response's ciphertext — how many bytes
 * {@link import("./client").encryptToRound} produces for a given plaintext
 * length and drand round, *without* running the crypto.
 *
 * The on-chain preview needs this to show the sealed response's real tx byte
 * size (and fee) before the user submits: encrypting to measure would pull in
 * the tlock bundle and add a round-trip on every keystroke. The math mirrors
 * `@mattpiz/tlock-js`'s de-armored age v1 envelope exactly; `size.test.ts` pins
 * it against real `encryptToRound(...)` output for several (len, round) pairs,
 * so any envelope-math drift fails tests rather than shipping a wrong fee.
 *
 * `encryptToRound` returns the **de-armored** age bytes: the age writer's output
 * string reinterpreted as bytes (the header is ASCII, the payload is copied
 * byte-for-byte). Its length is therefore the length of that string:
 *
 *   age-encryption.org/v1\n
 *   -> tlock <round> <chainHash>\n
 *   <base64(IBE ciphertext), wrapped at 64 cols>\n
 *   --- <base64(header MAC)>\n
 *   <16-byte HKDF nonce><STREAM-sealed payload>
 *
 * The IBE ciphertext (quicknet's RFC-9380 G1 scheme) is `U ‖ V ‖ W` with
 * `U` an **uncompressed** G1 point (96 bytes) and `V`, `W` each the 16-byte file
 * key length — 128 bytes. The payload seals the 128 KiB-chunked plaintext with
 * a 16-byte Poly1305 tag per chunk.
 */

/** Uncompressed BLS12-381 G1 point, as tlock-js serializes `U`. */
const G1_UNCOMPRESSED_BYTES = 96;
/** age file key length — also the width of the IBE `V` and `W` blocks. */
const FILE_KEY_BYTES = 16;
/** The IBE ciphertext `U ‖ V ‖ W` placed in the tlock stanza body. */
const IBE_CIPHERTEXT_BYTES = G1_UNCOMPRESSED_BYTES + 2 * FILE_KEY_BYTES; // 128

/** age STREAM chunk size and per-chunk Poly1305 tag. */
const STREAM_CHUNK_BYTES = 64 * 1024;
const STREAM_TAG_BYTES = 16;
/** HKDF nonce prepended to the sealed payload. */
const BODY_NONCE_BYTES = 16;

/** Fixed chain hash carried in the tlock stanza args (quicknet, 64 hex chars). */
const CHAIN_HASH_HEX_LEN = 64;
/** Header MAC: base64-unpadded HMAC-SHA-256 (32 bytes → 43 chars). */
const HEADER_MAC_LEN = unpaddedBase64Len(32);

/** Length of unpadded-base64 encoding of `n` bytes. */
function unpaddedBase64Len(n: number): number {
  const rem = n % 3;
  return Math.floor(n / 3) * 4 + (rem === 0 ? 0 : rem + 1);
}

/**
 * The length of `body`, unpadded-base64-encoded then hard-wrapped at 64 columns
 * with `\n` — how the age writer emits a recipient stanza's body.
 */
function wrappedBase64Len(byteLen: number): number {
  const encoded = unpaddedBase64Len(byteLen);
  const lines = Math.max(1, Math.ceil(encoded / 64));
  return encoded + (lines - 1); // one '\n' between wrapped lines
}

/**
 * The number of bytes {@link import("./client").encryptToRound} returns for a
 * `plaintextLen`-byte plaintext sealed to `round`. Exact for quicknet; pinned by
 * `size.test.ts` against the real encryptor.
 */
export function sealedCiphertextSize(
  plaintextLen: number,
  round: number,
): number {
  // Header: "age-encryption.org/v1" + newline.
  const version = "age-encryption.org/v1".length + 1;
  // Stanza: "-> tlock <round> <chainHash>" + newline + wrapped base64 body.
  const stanzaArgs =
    "-> tlock ".length + String(round).length + 1 + CHAIN_HASH_HEX_LEN;
  const stanza =
    stanzaArgs +
    1 +
    wrappedBase64Len(IBE_CIPHERTEXT_BYTES) +
    1; /* trailing \n */
  // Header terminator "---", then " " + MAC + "\n" from the mac line.
  const headerTail = "---".length + 1 + HEADER_MAC_LEN + 1;

  // Payload: nonce + plaintext + one Poly1305 tag per 64 KiB chunk.
  const chunks = Math.max(1, Math.ceil(plaintextLen / STREAM_CHUNK_BYTES));
  const payload = BODY_NONCE_BYTES + plaintextLen + chunks * STREAM_TAG_BYTES;

  return version + stanza + headerTail + payload;
}
