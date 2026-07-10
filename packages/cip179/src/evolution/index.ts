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

/** The CIP-129 bech32 governance action id (`gov_action1…`). */
export function govActionId(txIdHex: string, index: number): string {
  const txId = hexToBytes(txIdHex);
  const bytes = new Uint8Array(txId.length + 1);
  bytes.set(txId, 0);
  bytes[txId.length] = index;
  return Schema.decodeSync(Bech32.FromBytes("gov_action"))(bytes);
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
    const actionIds = [...entries].map(([ga]) => {
      const hash = ga.transactionId.hash;
      const txIdHex = typeof hash === "string" ? hash : bytesToHex(hash);
      return govActionId(txIdHex, Number(ga.govActionIndex));
    });
    votes.push({ voter, actionIds });
  }
  return votes;
}

/**
 * Decode a transaction's proof-relevant fields to the neutral {@link DecodedTx},
 * or `null` if it can't be decoded (→ the credential is treated as unproven).
 * `Transaction.fromCBORHex` decodes every post-Alonzo transaction (all CIP-179
 * txs are recent).
 */
export function decodeTx(txCborHex: string): DecodedTx | null {
  try {
    const tx = Transaction.fromCBORHex(txCborHex);

    const requiredSigners = (tx.body.requiredSigners ?? []).map((k) =>
      KeyHash.toHex(k),
    );

    const raw = tx.witnessSet?.nativeScripts;
    const nativeScripts: DecodedNativeScript[] =
      Array.isArray(raw) && raw.length > 0
        ? raw.map((ns) => ({
            scriptCbor: NativeScripts.toCBORBytes(ns),
            script: ns as unknown as NativeScriptNode,
          }))
        : [];

    const votes = decodeVotes(
      tx.body.votingProcedures as unknown as RawVotingProcedures | undefined,
    );

    return { requiredSigners, nativeScripts, votes };
  } catch (err) {
    console.warn(`could not decode tx: ${String(err)}`);
    return null;
  }
}

/** The evolution-sdk-backed codec — satisfies both cip-179 ports. */
export const evolutionCodec: MetadatumCodec & TxProofCodec = {
  metadatumToCbor,
  cborToMetadatum,
  stakeAddress,
  drepId,
  decodeTx,
};
