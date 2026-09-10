/**
 * A generic CBOR reader sized for a ledger state file: integers as number
 * when safe and bigint beyond, byte strings as Uint8Array, arrays as arrays,
 * maps as Map in encoded order, tag 258 (set) unwrapped to its array, tags 2
 * and 3 as bigint, any other tag as `{ tag, value }`.
 */
export type Cbor =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | Cbor[]
  | Map<Cbor, Cbor>
  | { readonly tag: number; readonly value: Cbor };

export function decodeCbor(bytes: Uint8Array): Cbor {
  const reader = new Reader(bytes);
  const value = reader.item();
  if (reader.pos !== bytes.length) {
    throw new Error(`cbor: ${bytes.length - reader.pos} trailing bytes`);
  }
  return value;
}

const BREAK = Symbol("break");
const utf8 = new TextDecoder();

class Reader {
  pos = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  item(): Cbor {
    const value = this.itemOrBreak();
    if (value === BREAK) throw new Error(`cbor: stray break at ${this.pos}`);
    return value;
  }

  private itemOrBreak(): Cbor | typeof BREAK {
    const initial = this.bytes[this.pos++];
    if (initial === undefined) throw new Error("cbor: truncated");
    const major = initial >> 5;
    const info = initial & 31;
    if (major === 7) return this.simple(info);
    const length = this.argument(info);
    switch (major) {
      case 0:
        return length!;
      case 1:
        return typeof length === "bigint" ? -1n - length : -1 - length!;
      case 2:
        return this.chunks(length, 2);
      case 3:
        return utf8.decode(this.chunks(length, 3));
      case 4: {
        const out: Cbor[] = [];
        this.each(length, () => out.push(this.item()));
        return out;
      }
      case 5: {
        const out = new Map<Cbor, Cbor>();
        this.each(length, () => out.set(this.item(), this.item()));
        return out;
      }
      default:
        return this.tagged(Number(length));
    }
  }

  /** The head's argument; undefined for an indefinite length. */
  private argument(info: number): number | bigint | undefined {
    if (info < 24) return info;
    if (info === 31) return undefined;
    const width = 1 << (info - 24);
    const at = this.pos;
    this.pos += width;
    if (this.pos > this.bytes.length) throw new Error("cbor: truncated");
    switch (width) {
      case 1:
        return this.view.getUint8(at);
      case 2:
        return this.view.getUint16(at);
      case 4:
        return this.view.getUint32(at);
      case 8: {
        const big = this.view.getBigUint64(at);
        return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
      }
      default:
        throw new Error(`cbor: reserved additional information ${info}`);
    }
  }

  private each(length: number | bigint | undefined, read: () => void): void {
    if (length === undefined) {
      while (this.bytes[this.pos] !== 0xff) read();
      this.pos++;
      return;
    }
    for (let i = 0; i < length; i++) read();
  }

  private chunks(
    length: number | bigint | undefined,
    major: number,
  ): Uint8Array {
    if (length !== undefined) return this.take(Number(length));
    const parts: Uint8Array[] = [];
    while (this.bytes[this.pos] !== 0xff) {
      const initial = this.bytes[this.pos++]!;
      if (initial >> 5 !== major) throw new Error("cbor: mixed chunk types");
      parts.push(this.take(Number(this.argument(initial & 31))));
    }
    this.pos++;
    return Buffer.concat(parts);
  }

  private take(length: number): Uint8Array {
    const end = this.pos + length;
    if (end > this.bytes.length) throw new Error("cbor: truncated");
    const out = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  private tagged(tag: number): Cbor {
    const value = this.item();
    if (tag === 2 || tag === 3) {
      const magnitude = BigInt(
        "0x" + (Buffer.from(value as Uint8Array).toString("hex") || "0"),
      );
      return tag === 2 ? magnitude : -1n - magnitude;
    }
    if (tag === 258) return value;
    return { tag, value };
  }

  private simple(info: number): Cbor | typeof BREAK {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25:
        return this.float(2);
      case 26:
        return this.float(4);
      case 27:
        return this.float(8);
      case 31:
        return BREAK;
      default:
        throw new Error(`cbor: unsupported simple value ${info}`);
    }
  }

  private float(width: number): number {
    const at = this.pos;
    this.pos += width;
    if (width === 8) return this.view.getFloat64(at);
    if (width === 4) return this.view.getFloat32(at);
    return this.view.getFloat16(at);
  }
}
