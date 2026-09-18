/**
 * evolution-sdk adapter — the `@evolution-sdk/evolution`-backed implementation
 * of cip-179's {@link MetadatumCodec} and {@link TxProofCodec} ports.
 *
 * This is the **only** module in cip-179 that imports evolution-sdk. Consumers
 * on the evolution stack import `{ evolutionCodec }` and inject it into
 * `sealAnswers` / `revealWithBeacon` / `revealResponses` / `decodeTxProof`;
 * downstream implementers on another Cardano library provide their own object
 * satisfying the same ports and never pull evolution in. evolution is an
 * optional peer, needed only by this subpath.
 *
 * @module
 */

import {
  Bech32,
  CBOR,
  DRep,
  KeyHash,
  NativeScripts,
  RewardAccount,
  ScriptHash,
  Schema,
  Transaction,
  TransactionMetadatum,
} from "@evolution-sdk/evolution";

import { bytesToHex, hexToBytes } from "../domain/index.js";
import type { Credential, Metadatum } from "../index.js";
import type { MetadatumCodec } from "../tlock/codec.js";
import type {
  DecodedNativeScript,
  DecodedTx,
  DecodedVote,
  NativeScriptNode,
  TxProofCodec,
  VoterNode,
} from "../txproof/codec.js";

// ── MetadatumCodec ──────────────────────────────────────────────────────────

/** Encode a metadatum tree to canonical CBOR bytes. */
export function metadatumToCbor(m: Metadatum): Uint8Array {
  return TransactionMetadatum.toCBORBytes(
    toTxMetadatum(m),
    CBOR.CANONICAL_OPTIONS,
  );
}

/**
 * Decode the **first** CBOR item from `bytes` into a metadatum tree, ignoring
 * any trailing bytes (sealed plaintext is CBOR followed by zero padding; CBOR is
 * self-delimiting, so decoding one item drops the pad cleanly).
 */
export function cborToMetadatum(bytes: Uint8Array): Metadatum {
  const { item } = CBOR.decodeItemWithOffset(bytes, 0, CBOR.CANONICAL_OPTIONS);
  return item as unknown as Metadatum;
}

/**
 * Cast a cip-179 {@link Metadatum} to evolution's `TransactionMetadatum` — the
 * same structural tree (bigint | string | Uint8Array | Map | array), differing
 * only in `readonly`, so this is a type-level cast, not a runtime conversion.
 * The single audited evolution ↔ cip-179 bridge, exported for the write path
 * (attaching metadata to an evolution-built transaction).
 */
export function toTxMetadatum(
  m: Metadatum,
): TransactionMetadatum.TransactionMetadatum {
  return m as unknown as TransactionMetadatum.TransactionMetadatum;
}

// ── TxProofCodec: bech32 ids ────────────────────────────────────────────────

/**
 * The bech32 reward (stake) address of a stake credential. CIP-19 header: high
 * nibble 0xE for a key hash, 0xF for a script hash; low nibble is the network id
 * (0 testnets, 1 mainnet).
 */
export function stakeAddress(credential: Credential, network: string): string {
  const isScript = credential.type === "script";
  const hash = isScript ? credential.scriptHash : credential.keyHash;
  const bytes = new Uint8Array(1 + hash.length);
  bytes[0] = (isScript ? 0xf0 : 0xe0) | (network === "mainnet" ? 1 : 0);
  bytes.set(hash, 1);
  return RewardAccount.toBech32(RewardAccount.fromBytes(bytes));
}

/** The CIP-129 bech32 DRep id (`drep1…`) of a DRep credential. */
export function drepId(credential: Credential): string {
  const drep =
    credential.type === "key"
      ? DRep.fromKeyHash(KeyHash.fromBytes(credential.keyHash))
      : DRep.fromScriptHash(ScriptHash.fromBytes(credential.scriptHash));
  return DRep.toBech32(drep);
}

/** Compiled once — a fresh schema per call would defeat parser memoization. */
const encodeGovAction = Schema.decodeSync(Bech32.FromBytes("gov_action"));

/**
 * The CIP-129 bech32 governance action id (`gov_action1…`).
 *
 * CIP-129 appends "the index bytes" to the 32-byte tx id and its examples only
 * ever show indices below 256, so the width above that is unpinned; Conway's
 * `gov_action_index` is `uint .size 2`. Encode big-endian in the narrowest width
 * that holds the value — one byte reproduces every published vector, two cover
 * the rest of the ledger's range. Writing a single byte unconditionally would
 * wrap index 256 onto index 0, and mechanism B compares these ids on both sides,
 * so the collision would read as a satisfied binding.
 */
export function govActionId(txIdHex: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
    throw new RangeError(`gov action index out of range: ${index}`);
  }
  const txId = hexToBytes(txIdHex);
  const width = index > 0xff ? 2 : 1;
  const bytes = new Uint8Array(txId.length + width);
  bytes.set(txId, 0);
  for (let i = 0; i < width; i++) {
    bytes[txId.length + i] = (index >>> ((width - 1 - i) * 8)) & 0xff;
  }
  return encodeGovAction(bytes);
}

// ── TxProofCodec: decode ────────────────────────────────────────────────────

/**
 * Minimal structural view of evolution's decoded `voting_procedures` — the
 * runtime shape (verified against real preview vote transactions). `procedures`
 * is a `Map<voter, Map<govActionId, procedure>>` at runtime; typed as iterables
 * of pairs so both Maps and plain pair-arrays satisfy it.
 */
interface RawVotingProcedures {
  readonly procedures: Iterable<
    readonly [VoterNode, Iterable<readonly [RawGovActionId, unknown]>]
  >;
}

interface RawGovActionId {
  readonly transactionId: { readonly hash: Uint8Array | string };
  readonly govActionIndex: bigint | number;
}

/** Flatten evolution's voting_procedures into neutral {@link DecodedVote}s. */
function decodeVotes(
  votingProcedures: RawVotingProcedures | undefined | null,
): DecodedVote[] {
  if (!votingProcedures?.procedures) return [];
  const votes: DecodedVote[] = [];
  for (const [voter, entries] of votingProcedures.procedures) {
    const actions = [...entries].map(([ga]) => {
      const hash = ga.transactionId.hash;
      return {
        txIdHex: typeof hash === "string" ? hash : bytesToHex(hash),
        index: Number(ga.govActionIndex),
      };
    });
    votes.push({ voter, actions });
  }
  return votes;
}

/** The head of the CBOR item at `at`: major type, argument (null when indefinite), size. */
function cborHead(
  bytes: Uint8Array,
  at: number,
): { major: number; arg: number | null; size: number } {
  const major = bytes[at]! >> 5;
  const info = bytes[at]! & 0x1f;
  if (info < 24) return { major, arg: info, size: 1 };
  if (info === 31) return { major, arg: null, size: 1 };
  if (info > 27) throw new Error(`reserved CBOR additional info ${info}`);
  const width = 1 << (info - 24);
  let arg = 0;
  for (let i = 1; i <= width; i++) arg = arg * 256 + bytes[at + i]!;
  return { major, arg, size: 1 + width };
}

/** The `[start, end)` spans of the array's or map's items at `at`; a map's alternate key, value. */
function cborItems(bytes: Uint8Array, at: number): [number, number][] {
  const head = cborHead(bytes, at);
  const count =
    head.arg === null ? Infinity : head.major === 5 ? 2 * head.arg : head.arg;
  const spans: [number, number][] = [];
  let offset = at + head.size;
  while (
    spans.length < count &&
    !(head.arg === null && bytes[offset] === 0xff)
  ) {
    const end = CBOR.decodeItemWithOffset(bytes, offset).newOffset;
    spans.push([offset, end]);
    offset = end;
  }
  return spans;
}

/**
 * The witness set's native scripts (key 1) as the transaction carries them: the
 * ledger hashes these bytes, and a re-encoding of a script sent in another
 * valid encoding (an indefinite array, a long integer head) would not.
 */
function witnessNativeScripts(tx: Uint8Array): Uint8Array[] {
  const witnessSet = cborItems(tx, 0)[1]![0];
  const entries = cborItems(tx, witnessSet);
  for (let i = 0; i < entries.length; i += 2) {
    const key = cborHead(tx, entries[i]![0]);
    if (key.major !== 0 || key.arg !== 1) continue;
    let at = entries[i + 1]![0];
    const tag = cborHead(tx, at);
    if (tag.major === 6) at += tag.size; // the set tag, #6.258
    return cborItems(tx, at).map(([start, end]) => tx.subarray(start, end));
  }
  return [];
}

/**
 * Decode a transaction's proof-relevant fields to the neutral {@link DecodedTx},
 * or `null` if it can't be decoded (→ the credential is treated as unproven).
 * `Transaction.fromCBORBytes` decodes every post-Alonzo transaction (all CIP-179
 * txs are recent).
 */
export function decodeTx(txCborHex: string): DecodedTx | null {
  try {
    const bytes = hexToBytes(txCborHex);
    const tx = Transaction.fromCBORBytes(bytes);

    const requiredSigners = (tx.body.requiredSigners ?? []).map((k) =>
      KeyHash.toHex(k),
    );

    const nativeScripts: DecodedNativeScript[] = witnessNativeScripts(
      bytes,
    ).map((scriptCbor) => ({
      scriptCbor,
      script: NativeScripts.fromCBORBytes(
        scriptCbor,
      ) as unknown as NativeScriptNode,
    }));

    const votes = decodeVotes(
      tx.body.votingProcedures as unknown as RawVotingProcedures | undefined,
    );

    return { requiredSigners, nativeScripts, votes };
  } catch (err) {
    console.warn(`could not decode tx: ${String(err)}`);
    return null;
  }
}

/**
 * Decode a bare native script from its CBOR (hex) — a Koios `/script_info`
 * `bytes` value — to the neutral {@link DecodedNativeScript}, or `null` if it
 * isn't a decodable native script (a Plutus script's bytes throw here, so the
 * caller resolves nothing and the credential stays unproven). The bytes are
 * kept as given, since the decoder refuses trailing bytes.
 */
export function decodeNativeScript(
  scriptCborHex: string,
): DecodedNativeScript | null {
  try {
    const scriptCbor = hexToBytes(scriptCborHex);
    return {
      scriptCbor,
      script: NativeScripts.fromCBORBytes(
        scriptCbor,
      ) as unknown as NativeScriptNode,
    };
  } catch (err) {
    console.warn(`could not decode native script: ${String(err)}`);
    return null;
  }
}

/** The evolution-sdk-backed codec — satisfies both cip-179 ports. */
export const evolutionCodec: MetadatumCodec & TxProofCodec = {
  metadatumToCbor,
  cborToMetadatum,
  stakeAddress,
  drepId,
  govActionId,
  decodeTx,
  decodeNativeScript,
};
