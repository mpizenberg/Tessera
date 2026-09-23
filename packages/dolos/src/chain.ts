/**
 * Column A of a survey's rebuild from a Dolos node: the label-17 records of
 * its window, their transactions' block positions and proof evidence, and the
 * governance actions that could link it. The node must have reached
 * `end_epoch + 1`, so the window's last block is known.
 */

import {
  METADATA_LABEL,
  decodePayloadItems,
  type DecodedPayloadItems,
  type Metadatum,
} from "cip-179";
import {
  refKey,
  hexToBytes,
  type CancellationRecord,
  type GovLinkScan,
  type ResponseRecord,
  type SurveyBundle,
  type SurveyRecord,
  type TxProof,
} from "cip-179/domain";
import { cborToMetadatum, evolutionCodec } from "cip-179/evolution";
import { decodeResolvedNativeScript, decodeTxProof } from "cip-179/txproof";
import {
  classifyPayload,
  govLinkScan,
  govProposal,
  resolveGovAnchors,
  type GovProposal,
  type ResolvedNativeScript,
} from "cardano-tessera-koios";

import { lastBlockOf, type BlockRow, type Minibf } from "./minibfClient";

/**
 * minibf refuses a list request whose `page × count` exceeds its
 * `max_scan_items` (3000 by default), so a longer window restarts from the
 * last listed transaction's block rather than paging on.
 */
const MAX_SCAN_ITEMS = 3000;
const PAGE = 100;

interface TxRow {
  hash: string;
  block: string;
  block_height: number;
  slot: number;
  /** Position in the block. */
  index: number;
}

export class DolosChain {
  /**
   * `minikupo` is the node's Kupo-compatible API (`[serve.minikupo]`), the
   * one route serving a native script's bytes by hash. Without it, a script
   * credential its transaction does not carry leaves that proof unknown.
   */
  constructor(
    private readonly node: Minibf,
    private readonly minikupo?: string,
  ) {}

  /**
   * The survey's records from its definition's block to the last block of its
   * `end_epoch`. Never `incomplete`: the scan reads every page or throws.
   */
  async bundle(
    key: string,
  ): Promise<{ bundle: SurveyBundle; incomplete: boolean }> {
    const [txHash] = key.split(":");
    const def = await this.node.find<TxRow>(`/txs/${txHash}`);
    if (!def)
      throw new Error(
        `survey ${key}: no transaction ${txHash} on the Dolos node at ${this.node.url}`,
      );
    const [survey] = (
      await this.records(key, def.block_height, def.block_height)
    ).surveys;
    if (!survey)
      throw new Error(
        `survey ${key}: transaction ${txHash} defines no such survey`,
      );
    const last = await lastBlockOf(this.node, survey.definition.endEpoch);
    const { responses, cancellations } = await this.records(
      key,
      def.block_height,
      last.height,
    );
    return {
      bundle: { survey, responses, cancellations },
      incomplete: false,
    };
  }

  /**
   * The records naming survey `key` in the blocks from height `from` to `to`,
   * inclusive. minibf filters by label only, so every label-17 transaction's
   * datum is read, and its position asked only when an item names the survey.
   */
  private async records(key: string, from: number, to: number) {
    const metadata = new Map<string, string>();
    for (let start = from; ; ) {
      let page = 1;
      for (; page * PAGE <= MAX_SCAN_ITEMS; page++) {
        const rows =
          (await this.node.find<{ tx_hash: string; metadata: string }[]>(
            `/metadata/txs/labels/${METADATA_LABEL}/cbor?from=${start}&to=${to}&count=${PAGE}&page=${page}`,
          )) ?? [];
        for (const r of rows) metadata.set(r.tx_hash, r.metadata);
        if (rows.length < PAGE) break;
      }
      if (page * PAGE <= MAX_SCAN_ITEMS) break;
      const next = (
        await this.node.get<TxRow>(`/txs/${[...metadata.keys()].at(-1)}`)
      ).block_height;
      if (next === start)
        throw new Error(
          `block ${start} alone holds ${MAX_SCAN_ITEMS} label-17 transactions`,
        );
      start = next;
    }

    const out = {
      surveys: [] as SurveyRecord[],
      responses: [] as ResponseRecord[],
      cancellations: [] as CancellationRecord[],
    };
    const epochOf = new Map<string, number>();
    for (const [txHash, cbor] of metadata) {
      // The route's `metadata` is the transaction's `{17: datum}`.
      const labels = cborToMetadatum(hexToBytes(cbor)) as ReadonlyMap<
        Metadatum,
        Metadatum
      >;
      let decoded: DecodedPayloadItems;
      try {
        decoded = decodePayloadItems(labels.get(BigInt(METADATA_LABEL))!);
      } catch (err) {
        console.warn(`skipping label-17 tx ${txHash}: ${String(err)}`);
        continue;
      }
      for (const s of decoded.skipped)
        console.warn(
          `skipping label-17 item ${txHash}[${s.index}]: ${String(s.error)}`,
        );
      const payload = naming(key, txHash, decoded.payload);
      if (!payload) continue;
      const tx = await this.node.get<TxRow>(`/txs/${txHash}`);
      if (!epochOf.has(tx.block))
        epochOf.set(
          tx.block,
          (await this.node.get<BlockRow>(`/blocks/${tx.block}`)).epoch,
        );
      classifyPayload(
        payload,
        txHash,
        { slot: tx.slot, epochNo: epochOf.get(tx.block)! },
        out,
      );
    }
    return out;
  }

  async txBlockIndices(
    txHashes: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const h of txHashes) {
      const tx = await this.node.find<TxRow>(`/txs/${h}`);
      if (tx) out.set(h, tx.index);
    }
    return out;
  }

  /** Proof evidence per transaction, as `KoiosDataSource.txProofs` gives it. */
  async txProofs(
    txHashes: readonly string[],
  ): Promise<Map<string, TxProof | null>> {
    const proofs = new Map<string, TxProof | null>();
    for (const h of txHashes) {
      const row = await this.node.find<{ cbor: string }>(`/txs/${h}/cbor`);
      proofs.set(h, row ? decodeTxProof(evolutionCodec, row.cbor) : null);
    }
    return proofs;
  }

  /**
   * The native scripts minikupo serves by hash, as
   * `KoiosDataSource.nativeScripts` gives them but with no epoch: minikupo
   * gives no script's first appearance, so whether a script was on chain by
   * the survey's end is not checked.
   */
  async nativeScripts(
    hashes: readonly string[],
  ): Promise<Map<string, ResolvedNativeScript | null>> {
    const out = new Map<string, ResolvedNativeScript | null>();
    for (const h of new Set(hashes)) {
      if (!this.minikupo) {
        console.warn(`no minikupo URL: native script ${h} stays unresolved`);
        out.set(h, null);
        continue;
      }
      try {
        const res = await fetch(`${this.minikupo}/scripts/${h}`);
        if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
        const row = res.ok
          ? ((await res.json()) as { language: string; script: string } | null)
          : null;
        if (row?.language !== "native") continue;
        const decoded = decodeResolvedNativeScript(evolutionCodec, row.script);
        if (decoded?.scriptHash === h)
          out.set(h, { script: decoded.script, epoch: null });
      } catch (err) {
        console.warn(`minikupo /scripts/${h} failed: ${String(err)}`);
        out.set(h, null);
      }
    }
    return out;
  }

  /**
   * The links among the actions expiring with one of `endEpochs`, every
   * anchor fetched and checked against its on-chain hash here. minibf's
   * `expiration`, like Koios's, is one past the last votable epoch. Its
   * listing, like Blockfrost's, carries neither the expiration nor the
   * proposing epoch, so every proposal's details are asked: 1536 requests on
   * preview.
   */
  async fetchGovernanceLinks(
    endEpochs: readonly number[],
  ): Promise<GovLinkScan> {
    const expirations = new Set(endEpochs.map((e) => e + 1));
    const listed = await this.node.all<{ tx_hash: string; cert_index: number }>(
      "/governance/proposals",
    );
    const proposals: GovProposal[] = [];
    for (const p of listed) {
      const d = await this.node.get<{ id: string; expiration: number }>(
        `/governance/proposals/${p.tx_hash}/${p.cert_index}`,
      );
      if (!expirations.has(d.expiration)) continue;
      // Answers the on-chain anchor even when the node's own fetch of it failed.
      const meta = await this.node.find<{ url: string; hash: string }>(
        `/governance/proposals/${d.id}/metadata`,
      );
      const proposal = govProposal({
        proposal_id: d.id,
        expiration: d.expiration,
        meta_url: meta?.url ?? null,
        meta_hash: meta?.hash ?? null,
      });
      if (proposal) proposals.push(proposal);
      else
        console.warn(
          `proposal ${d.id} commits to no usable anchor — it can carry no verifiable link`,
        );
    }
    if (proposals.length === 0) return { links: [], unresolved: [] };
    return govLinkScan(proposals, await resolveGovAnchors(proposals));
  }
}

type Payload = DecodedPayloadItems["payload"];

/** The items of `payload` naming survey `key`, or null when none does. */
function naming(key: string, txHash: string, payload: Payload): Payload | null {
  switch (payload.type) {
    case "definitions": {
      const txId = hexToBytes(txHash);
      const definitions = payload.definitions.filter(
        ({ index }) => refKey({ txId, index }) === key,
      );
      return definitions.length > 0 ? { ...payload, definitions } : null;
    }
    case "responses": {
      const responses = payload.responses.filter(
        ({ value }) => refKey(value.surveyRef) === key,
      );
      return responses.length > 0 ? { ...payload, responses } : null;
    }
    case "cancellations": {
      const cancellations = payload.cancellations.filter(
        ({ value }) => refKey(value) === key,
      );
      return cancellations.length > 0 ? { ...payload, cancellations } : null;
    }
  }
}
