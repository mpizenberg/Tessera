/**
 * Where the rebuild's chain inputs come from: Koios, or a Dolos node, behind
 * one {@link SurveyChain}. The weights come through `TallyInputSource`.
 */

import {
  refKey,
  scriptCredentialHash,
  type GovLinkScan,
  type SurveyBundle,
  type TxProof,
} from "cip-179/domain";
import type { AppConfig } from "cardano-tessera-core";
import { KoiosDataSource } from "cardano-tessera-koios";

import { linkedActionIdsFor, type VerifyInputs } from "./verify";

/** Column A of the rebuild: the survey's records and the evidence behind them. */
export interface SurveyChain {
  /** Rejects when the source knows no such survey. */
  bundle(key: string): Promise<{ bundle: SurveyBundle; incomplete: boolean }>;
  txBlockIndices(txHashes: readonly string[]): Promise<Map<string, number>>;
  txProofs(
    txHashes: readonly string[],
    neededScripts: ReadonlyMap<string, readonly string[]>,
  ): Promise<Map<string, TxProof | null>>;
  fetchGovernanceLinks(endEpochs: readonly number[]): Promise<GovLinkScan>;
}

/** Koios as a {@link SurveyChain}: the label-17 scan since `config.sinceUnix`. */
export function koiosChain(config: AppConfig): SurveyChain {
  const source = new KoiosDataSource(config);
  return {
    async bundle(key) {
      const records = await source.fetchAll();
      const survey = records.surveys.find((s) => refKey(s.ref) === key);
      if (!survey) {
        throw new Error(
          `survey ${key} not found in an independent Koios scan since ` +
            `${new Date(config.sinceUnix * 1000).toISOString()}. If it is older ` +
            `than that floor, re-run with an earlier --since.`,
        );
      }
      return {
        bundle: {
          survey,
          responses: records.responses.filter(
            (r) => refKey(r.response.surveyRef) === key,
          ),
          cancellations: records.cancellations.filter(
            (c) => refKey(c.target) === key,
          ),
          tip: await source.chainTip(),
        },
        incomplete: records.incomplete ?? false,
      };
    },
    txBlockIndices: (txHashes) => source.txBlockIndices(txHashes),
    txProofs: (txHashes, needed) => source.txProofs(txHashes, needed),
    fetchGovernanceLinks: (endEpochs) => source.fetchGovernanceLinks(endEpochs),
  };
}

/**
 * The evidence behind `bundle`'s records, from `chain`: each transaction's
 * block position and credential proofs, and the governance links.
 */
export async function chainEvidence(
  chain: SurveyChain,
  bundle: SurveyBundle,
): Promise<
  Pick<
    VerifyInputs,
    | "blockIndices"
    | "proofs"
    | "linkedActionIds"
    | "unresolvedActionIds"
    | "govLinksReliable"
  >
> {
  const txHashes = [
    ...new Set([
      // The defining tx: CIP-179 requires it to prove the survey's owner, so its
      // evidence gates talliability exactly like a cancellation's does.
      bundle.survey.txHash,
      ...bundle.responses.map((r) => r.txHash),
      ...bundle.cancellations.map((c) => c.txHash),
    ]),
  ];
  // Native-script credentials whose script may not be attached to the carrying
  // tx: resolve them by hash so mechanism A is evaluated the same way the emitter
  // does (finding 7). Cancellations all target this survey → its owner.
  const neededScripts = new Map<string, string[]>();
  const addNeeded = (txHash: string, scriptHash: string | null) => {
    if (!scriptHash) return;
    const list = neededScripts.get(txHash);
    if (list) list.push(scriptHash);
    else neededScripts.set(txHash, [scriptHash]);
  };
  const ownerScriptHash = scriptCredentialHash(bundle.survey.definition.owner);
  addNeeded(bundle.survey.txHash, ownerScriptHash);
  for (const c of bundle.cancellations) addNeeded(c.txHash, ownerScriptHash);
  for (const r of bundle.responses)
    addNeeded(r.txHash, scriptCredentialHash(r.response.credential));

  // Only actions expiring with this survey can link it, or — unresolved — cloud
  // its mechanism-B verdicts, so the scan reads that one epoch and no more. Each
  // action's anchor is dereferenced here and checked against its on-chain hash:
  // the whole point of this tool is that no input is taken on trust, and an
  // indexer's own resolution of an anchor can never be re-verified after the
  // fact. No time budget — a verification may take as long as the anchors do.
  const endEpoch = bundle.survey.definition.endEpoch;
  let govLinksReliable = true;
  const [blockIndices, proofs, govScan] = await Promise.all([
    chain.txBlockIndices(txHashes),
    chain.txProofs(txHashes, neededScripts),
    chain.fetchGovernanceLinks([endEpoch]).catch((err) => {
      // A fetch failure is UNKNOWN, not "no links" — flag it so a mechanism-B
      // proof it might decide comes back INDETERMINATE, never a silent exclude.
      console.warn(
        `gov links unavailable (${String(err)}) — treating as unresolved`,
      );
      govLinksReliable = false;
      return { links: [], unresolved: [] };
    }),
  ]);
  return {
    blockIndices,
    proofs,
    linkedActionIds: linkedActionIdsFor(bundle, govScan.links),
    unresolvedActionIds: govScan.unresolved.map((u) => u.actionId),
    govLinksReliable,
  };
}
