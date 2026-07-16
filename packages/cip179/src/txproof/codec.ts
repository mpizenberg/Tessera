/**
 * The `TxProofCodec` port — the Cardano-serialization primitives cip-179's
 * txproof reads depend on but do **not** implement themselves.
 *
 * cip-179 owns the CIP-179 *interpretation* of a transaction (mechanism A/B, the
 * Conway voter-tag semantics, native-script hashing); an adapter owns the
 * library-specific *decoding* and the address / id encoding. `cip-179/evolution`
 * ships an `@evolution-sdk/evolution`-backed implementation; a downstream
 * implementer on any other Cardano stack provides their own object satisfying
 * this interface and never pulls evolution in.
 *
 * @module
 */

import type { Credential } from "../index.js";

/**
 * A native-script tree node, mirroring the Cardano `native_script` CDDL. A top
 * node may be wrapped as `{ _tag: "NativeScript", script }` (some decoders emit
 * the wrapper, some the bare variant) — the interpretation tolerates either.
 */
export type NativeScriptNode =
  | { readonly _tag: "NativeScript"; readonly script: NativeScriptNode }
  | { readonly _tag: "ScriptPubKey"; readonly keyHash: Uint8Array }
  | {
      readonly _tag: "ScriptAll";
      readonly scripts: readonly NativeScriptNode[];
    }
  | {
      readonly _tag: "ScriptAny";
      readonly scripts: readonly NativeScriptNode[];
    }
  | {
      readonly _tag: "ScriptNOfK";
      readonly required: bigint;
      readonly scripts: readonly NativeScriptNode[];
    }
  | {
      readonly _tag: "InvalidBefore" | "InvalidHereafter";
      readonly slot: bigint;
    };

/** A witness-set native script: its own CBOR (to hash) plus its parsed tree. */
export interface DecodedNativeScript {
  /** The script's canonical CBOR — cip-179 hashes `0x00 ‖ this` (blake2b-224). */
  readonly scriptCbor: Uint8Array;
  readonly script: NativeScriptNode;
}

/**
 * A Conway voter, mirroring the ledger `voter` CDDL (constitutional-committee /
 * DRep / stake-pool). cip-179 maps this to a voter tag + credential hash.
 */
export type VoterNode =
  | {
      readonly _tag: "ConstitutionalCommitteeVoter";
      readonly credential:
        | { readonly _tag: "KeyHash"; readonly hash: Uint8Array }
        | { readonly _tag: "ScriptHash"; readonly hash: Uint8Array };
    }
  | {
      readonly _tag: "DRepVoter";
      readonly drep:
        | {
            readonly _tag: "KeyHashDRep";
            readonly keyHash: { readonly hash: Uint8Array };
          }
        | {
            readonly _tag: "ScriptHashDRep";
            readonly scriptHash: { readonly hash: Uint8Array };
          }
        | { readonly _tag: "AlwaysAbstainDRep" }
        | { readonly _tag: "AlwaysNoConfidenceDRep" };
    }
  | {
      readonly _tag: "StakePoolVoter";
      readonly poolKeyHash: { readonly hash: Uint8Array };
    };

/** A raw governance action id — the ledger `gov_action_id` pair, pre-encoding. */
export interface GovActionRef {
  /** Hex transaction id of the governance action's proposing tx. */
  readonly txIdHex: string;
  readonly index: number;
}

/** One decoded `voting_procedures` entry: the voter + the ids it voted on. */
export interface DecodedVote {
  readonly voter: VoterNode;
  /**
   * The actions this voter voted on, as raw (txId, index) pairs. cip-179
   * encodes them to CIP-129 ids via {@link TxProofCodec.govActionId}, so the
   * comparison format is defined by the codec in exactly one place.
   */
  readonly actions: readonly GovActionRef[];
}

/**
 * A transaction's proof-relevant fields, decoded to a library-neutral shape.
 * {@link import("./txProof").decodeTxProof} interprets this into a `TxProof`;
 * an adapter's only job is to produce it faithfully from the transaction CBOR.
 */
export interface DecodedTx {
  /** tx body `required_signers` (field 14), as key-hash hex. */
  readonly requiredSigners: readonly string[];
  /** Witness-set native scripts. */
  readonly nativeScripts: readonly DecodedNativeScript[];
  /** tx body `voting_procedures` (field 19), one entry per voter. */
  readonly votes: readonly DecodedVote[];
}

/**
 * Cardano-serialization primitives cip-179's txproof reads depend on. Inject an
 * implementation (see `cip-179/evolution`) into
 * {@link import("./txProof").decodeTxProof} and the Koios tally reads.
 */
export interface TxProofCodec {
  /** CIP-19 bech32 reward (stake) address of a stake credential on `network`. */
  stakeAddress(credential: Credential, network: string): string;
  /** CIP-129 bech32 DRep id (`drep1…`) of a DRep credential. */
  drepId(credential: Credential): string;
  /** CIP-129 bech32 governance action id (`gov_action1…`). */
  govActionId(txIdHex: string, index: number): string;
  /** Decode a tx's proof-relevant fields, or `null` if it can't be decoded. */
  decodeTx(txCborHex: string): DecodedTx | null;
  /**
   * Decode a bare native script from its own CBOR (hex), or `null` if it isn't a
   * decodable native script. Used to resolve a mechanism-A native script *by
   * hash* through a chain index (e.g. Koios `/script_info`) when it isn't
   * attached to the carrying tx's witness set — CIP-179 mechanism A permits the
   * script to be resolved from the chain, not only the tx (a metadata-only tx
   * need not carry it). Returns the same {@link DecodedNativeScript} the tx
   * decoder emits, so the interpretation hashes it identically.
   */
  decodeNativeScript(scriptCborHex: string): DecodedNativeScript | null;
}
