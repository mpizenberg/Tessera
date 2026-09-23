/**
 * Column A of a survey's rebuild from an Amaru node's stores, as
 * `amaru-store-reader` printed them: the label-17 records of its window and
 * their transactions' block positions and proof evidence from the block walk,
 * the governance actions that could link it from the epoch snapshot at its
 * `end_epoch`. The walk must start at or before the survey's defining
 * transaction and reach the last slot of `end_epoch`; the reader keeps in it
 * only the transactions that can name the survey.
 */

import {
  decodePayloadItems,
  type DecodedPayloadItems,
  type Metadatum,
} from "cip-179";
import {
  epochOfSlot,
  refKey,
  hexToBytes,
  type CancellationRecord,
  type GovLinkScan,
  type ResponseRecord,
  type SurveyBundle,
  type SurveyRecord,
  type TxProof,
} from "cip-179/domain";
import {
  cborToMetadatum,
  evolutionCodec,
  govActionId,
} from "cip-179/evolution";
import { decodeTxProof } from "cip-179/txproof";
import { SECONDS_PER_EPOCH, type Network } from "cardano-tessera-client";
import {
  classifyPayload,
  govLinkScan,
  govProposal,
  resolveGovAnchors,
  type GovProposal,
  type ResolvedNativeScript,
} from "cardano-tessera-koios";

import type { AmaruStores, WalkedTx } from "./stores";

/** Resolves native scripts by hash, as `KoiosDataSource.nativeScripts` does. */
type NativeScriptLookup = (
  hashes: readonly string[],
) => Promise<Map<string, ResolvedNativeScript | null>>;

/**
 * No lookup: a script a transaction does not witness is found nowhere, so the
 * records needing it are unproven.
 */
const noLookup: NativeScriptLookup = async (hashes) => {
  console.warn(
    `native scripts ${hashes.join(", ")} are not witnessed where needed, and no script lookup was given: records needing them are unproven`,
  );
  return new Map();
};

export class AmaruChain {
  /**
   * `lookupScripts` finds the native scripts Amaru's stores cannot: the
   * ledger lets a transaction witness only the scripts it needs, and a
   * metadata-only record needs none, so a script credential's script is
   * rarely in its record's transaction.
   */
  constructor(
    private readonly stores: AmaruStores,
    private readonly network: Network,
    private readonly lookupScripts: NativeScriptLookup = noLookup,
  ) {}

  /**
   * The survey's records, as {@link surveyWindow} reads them, with the tip
   * the walk started from, or a throw when the walk stops inside `end_epoch`.
   * Never `incomplete`: the walk is a file, read whole.
   */
  async bundle(
    key: string,
  ): Promise<{ bundle: SurveyBundle; incomplete: boolean }> {
    const walk = this.stores.blocks();
    const window = surveyWindow(this.stores, key);
    const endEpoch = window.survey.definition.endEpoch;
    const tip = {
      epoch: walk.tip.epoch,
      slot: walk.tip.slot,
      time: walk.tip.time,
      epochSlot: walk.tip.epoch_slot,
      govActionLifetime: this.stores.snapshot(endEpoch).gov_action_lifetime,
    };
    // The walk covers the window when the slot after its last is in a later
    // epoch than the survey's last.
    if (
      epochOfSlot(walk.to + 1, tip, SECONDS_PER_EPOCH[this.network]) <= endEpoch
    )
      throw new Error(
        `survey ${key}: the walk stops at slot ${walk.to}, inside epoch ${endEpoch}`,
      );
    return { bundle: { ...window, tip }, incomplete: false };
  }

  private walked(txHashes: readonly string[]): Map<string, WalkedTx> {
    const byHash = new Map(
      this.stores.blocks().transactions.map((t) => [t.hash, t]),
    );
    return new Map(
      txHashes.flatMap((h) => {
        const t = byHash.get(h);
        return t ? [[h, t]] : [];
      }),
    );
  }

  async txBlockIndices(
    txHashes: readonly string[],
  ): Promise<Map<string, number>> {
    return new Map([...this.walked(txHashes)].map(([h, t]) => [h, t.index]));
  }

  /** Proof evidence per transaction, as `KoiosDataSource.txProofs` gives it. */
  async txProofs(
    txHashes: readonly string[],
  ): Promise<Map<string, TxProof | null>> {
    const walked = this.walked(txHashes);
    const proofs = new Map<string, TxProof | null>(
      txHashes.map((h) => {
        const t = walked.get(h);
        return [h, t ? decodeTxProof(evolutionCodec, t.cbor) : null];
      }),
    );
    return proofs;
  }

  nativeScripts(
    hashes: readonly string[],
  ): Promise<Map<string, ResolvedNativeScript | null>> {
    return this.lookupScripts(hashes);
  }

  /**
   * The links among the actions expiring with one of `endEpochs`, every
   * anchor fetched and checked against its on-chain hash here. The snapshot
   * at an epoch's end still holds the actions that expired the epoch before,
   * so the filter is on `valid_until`.
   */
  async fetchGovernanceLinks(
    endEpochs: readonly number[],
  ): Promise<GovLinkScan> {
    const proposals: GovProposal[] = [];
    for (const endEpoch of endEpochs) {
      const snapshot = this.stores.snapshot(endEpoch);
      for (const [id, row] of Object.entries(snapshot.proposals)) {
        if (row.valid_until !== endEpoch) continue;
        const [txHash, index] = id.split("#");
        const proposal = govProposal({
          proposal_id: govActionId(txHash!, Number(index)),
          expiration: row.valid_until + 1,
          meta_url: row.anchor.url,
          meta_hash: row.anchor.hash,
        });
        if (proposal) proposals.push(proposal);
        else
          console.warn(
            `proposal ${id} commits to no usable anchor — it can carry no verifiable link`,
          );
      }
    }
    if (proposals.length === 0) return { links: [], unresolved: [] };
    return govLinkScan(proposals, await resolveGovAnchors(proposals));
  }
}

/**
 * The survey's records from its defining transaction's slot through the last
 * block of its `end_epoch`, from the walk alone: no snapshot is read, so the
 * credentials to ask the snapshots about can be taken from it.
 */
export function surveyWindow(
  stores: AmaruStores,
  key: string,
): Omit<SurveyBundle, "tip"> {
  const records = decodeRecords(stores.blocks().transactions);
  const survey = records.surveys.find((s) => refKey(s.ref) === key);
  if (!survey)
    throw new Error(
      `survey ${key}: no transaction in ${stores.dir}/blocks.json defines it`,
    );
  const endEpoch = survey.definition.endEpoch;
  const inWindow = (r: { slot: number; epochNo: number }) =>
    r.slot >= survey.slot && r.epochNo <= endEpoch;
  return {
    survey,
    responses: records.responses.filter(
      (r) => inWindow(r) && refKey(r.response.surveyRef) === key,
    ),
    cancellations: records.cancellations.filter(
      (c) => inWindow(c) && refKey(c.target) === key,
    ),
  };
}

function decodeRecords(transactions: readonly WalkedTx[]) {
  const out = {
    surveys: [] as SurveyRecord[],
    responses: [] as ResponseRecord[],
    cancellations: [] as CancellationRecord[],
  };
  for (const tx of transactions) {
    let decoded: DecodedPayloadItems;
    try {
      decoded = decodePayloadItems(
        cborToMetadatum(hexToBytes(tx.metadata)) as Metadatum,
      );
    } catch (err) {
      console.warn(`skipping label-17 tx ${tx.hash}: ${String(err)}`);
      continue;
    }
    for (const s of decoded.skipped)
      console.warn(
        `skipping label-17 item ${tx.hash}[${s.index}]: ${String(s.error)}`,
      );
    classifyPayload(
      decoded.payload,
      tx.hash,
      { slot: tx.slot, epochNo: tx.epoch },
      out,
    );
  }
  return out;
}
