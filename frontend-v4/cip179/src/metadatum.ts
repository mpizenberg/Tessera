/**
 * Generic Cardano transaction metadatum model.
 *
 * This mirrors the universal on-the-wire shape of `transaction_metadatum`
 * (CIP-10 / ledger CDDL) without depending on any particular Cardano library:
 *
 * - int   -> bigint
 * - text  -> string
 * - bytes -> Uint8Array
 * - array -> ReadonlyArray<Metadatum>
 * - map   -> ReadonlyMap<Metadatum, Metadatum>
 *
 * The CIP-179 codec lowers/raises its domain types to/from this tree. Any
 * library (evolution-sdk, Lucid, Mesh, CSL, ...) that accepts this model can
 * serialize the result to CBOR; the codec itself performs no I/O and no
 * CBOR (de)serialization.
 *
 * @module
 */

/**
 * A transaction metadatum value.
 */
export type Metadatum =
  | bigint
  | string
  | Uint8Array
  | ReadonlyArray<Metadatum>
  | ReadonlyMap<Metadatum, Metadatum>;

/** A metadatum map, keyed by metadatum (CIP-179 always uses integer keys). */
export type MetadatumMap = ReadonlyMap<Metadatum, Metadatum>;

/** A metadatum array. */
export type MetadatumList = ReadonlyArray<Metadatum>;

// ----------------------------------------------------------------------------
// Type guards
// ----------------------------------------------------------------------------

export const isInt = (m: Metadatum): m is bigint => typeof m === "bigint";

export const isText = (m: Metadatum): m is string => typeof m === "string";

export const isBytes = (m: Metadatum): m is Uint8Array =>
  m instanceof Uint8Array;

export const isList = (m: Metadatum): m is MetadatumList => Array.isArray(m);

export const isMap = (m: Metadatum): m is MetadatumMap => m instanceof Map;

// ----------------------------------------------------------------------------
// Constructors (deterministic maps)
// ----------------------------------------------------------------------------

/**
 * Build an integer-keyed metadatum map from `[key, value]` entries, dropping
 * entries whose value is `undefined` (used for optional fields).
 *
 * Keys are emitted in ascending numeric order so encoders that preserve
 * insertion order produce RFC 8949 §4.2 canonical maps, as CIP-179 requires.
 */
export const intMap = (
  entries: ReadonlyArray<readonly [number, Metadatum | undefined]>,
): MetadatumMap => {
  const present = entries.filter(
    (e): e is readonly [number, Metadatum] => e[1] !== undefined,
  );
  present.sort((a, b) => a[0] - b[0]);
  return new Map(present.map(([k, v]) => [BigInt(k), v]));
};

// ----------------------------------------------------------------------------
// Chunked text (CIP-20 style)
// ----------------------------------------------------------------------------

/** Cardano metadata text/bytes limit, in bytes. */
export const MAX_CHUNK_BYTES = 64;

const utf8Encoder = new TextEncoder();

/**
 * Split a string into UTF-8 chunks of at most 64 bytes, never splitting a
 * Unicode code point. Concatenating the chunks reconstructs the input.
 */
export const chunkText = (text: string): string[] => {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  // Iterating a string yields whole code points (surrogate pairs stay intact).
  for (const codePoint of text) {
    const size = utf8Encoder.encode(codePoint).length;
    if (currentBytes + size > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += size;
  }
  chunks.push(current);
  return chunks;
};

/**
 * Encode a string as `chunked_text`: a single bounded string when it fits in
 * 64 bytes, otherwise an array of bounded chunks.
 */
export const encodeChunkedText = (text: string): Metadatum => {
  if (utf8Encoder.encode(text).length <= MAX_CHUNK_BYTES) return text;
  return chunkText(text);
};

/** Decode `chunked_text` (single string or array of strings) into a string. */
export const decodeChunkedText = (m: Metadatum): string => {
  if (isText(m)) return m;
  if (isList(m)) {
    return m
      .map((chunk) => {
        if (!isText(chunk)) {
          throw new TypeError(
            "chunked_text array must contain only text chunks",
          );
        }
        return chunk;
      })
      .join("");
  }
  throw new TypeError("expected chunked_text (text or array of text)");
};

// ----------------------------------------------------------------------------
// Chunked bytes
// ----------------------------------------------------------------------------

/** Split a byte string into chunks of at most 64 bytes. */
export const chunkBytes = (bytes: Uint8Array): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += MAX_CHUNK_BYTES) {
    chunks.push(bytes.slice(i, i + MAX_CHUNK_BYTES));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
};

/**
 * Encode bytes as `chunked_bytes`: a single byte string when it fits in 64
 * bytes, otherwise an array of bounded byte strings.
 */
export const encodeChunkedBytes = (bytes: Uint8Array): Metadatum => {
  if (bytes.length <= MAX_CHUNK_BYTES) return bytes;
  return chunkBytes(bytes);
};

/** Decode `chunked_bytes` (single byte string or array) into one Uint8Array. */
export const decodeChunkedBytes = (m: Metadatum): Uint8Array => {
  if (isBytes(m)) return m;
  if (isList(m)) {
    const parts = m.map((chunk) => {
      if (!isBytes(chunk)) {
        throw new TypeError(
          "chunked_bytes array must contain only byte strings",
        );
      }
      return chunk;
    });
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  throw new TypeError("expected chunked_bytes (bytes or array of bytes)");
};

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

const { isSafeInteger } = Number;

/** Coerce a metadatum integer to a JS number, asserting it is a safe integer. */
export const toSafeNumber = (m: Metadatum, what: string): number => {
  if (!isInt(m)) throw new TypeError(`expected integer for ${what}`);
  if (
    m > BigInt(Number.MAX_SAFE_INTEGER) ||
    m < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`${what} out of safe integer range: ${m}`);
  }
  return Number(m);
};

/** Coerce a metadatum integer to a bigint. */
export const toBigInt = (m: Metadatum, what: string): bigint => {
  if (!isInt(m)) throw new TypeError(`expected integer for ${what}`);
  return m;
};

export const expectList = (m: Metadatum, what: string): MetadatumList => {
  if (!isList(m)) throw new TypeError(`expected array for ${what}`);
  return m;
};

export const expectMap = (m: Metadatum, what: string): MetadatumMap => {
  if (!isMap(m)) throw new TypeError(`expected map for ${what}`);
  return m;
};

export const expectBytes = (m: Metadatum, what: string): Uint8Array => {
  if (!isBytes(m)) throw new TypeError(`expected byte string for ${what}`);
  return m;
};

/** Read an integer key from a metadatum map. */
export const getKey = (map: MetadatumMap, key: number): Metadatum | undefined =>
  map.get(BigInt(key));

export { isSafeInteger };
