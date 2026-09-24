/**
 * The Amaru stores a survey's audit reads, and the files the verifier takes
 * from them, built one step at a time. Each step is chosen from what is on
 * disk, so a rerun takes up after the last step that finished.
 *
 * The node starts from a set of PRAGMA's end-of-epoch ledger states no later
 * than the survey's creation epoch, so its chain store holds the survey's
 * whole window, then syncs Mithril-certified blocks into `end_epoch + 1`
 * until the ledger writes snapshot `end_epoch`: the ledger at that epoch's
 * end, written once the stable store crosses into the next epoch, `k` blocks
 * in. A sync stopped short leaves it unwritten, and a node that ran on into
 * `end_epoch + 3` has pruned it.
 */

import {
  firstSlot,
  epochOfShelleySlot,
  stabilityWindowSlots,
  type Network,
} from "cardano-tessera-client";

import type { AskedCredentials } from "./credentials";

export interface SurveyTarget {
  readonly network: Network;
  /** `<txHash>:<index>`. */
  readonly key: string;
  readonly txHash: string;
  /** The slot and epoch of the survey's defining transaction. */
  readonly slot: number;
  readonly epoch: number;
  readonly endEpoch: number;
}

export const chainDir = (network: Network) => `chain.${network}.db`;
export const ledgerDir = (network: Network) => `ledger.${network}.db`;
export const BLOCKS = "blocks.json";
export const CREDENTIALS = "credentials.json";
export const snapshotFile = (epoch: number) => `snapshot-${epoch}.json`;

export interface StoresState {
  /** The epochs the ledger store holds a snapshot of; null before a bootstrap. */
  readonly snapshots: readonly number[] | null;
  /** The slots `blocks.json` was walked between, null before the walk. */
  readonly walk: { readonly from: number; readonly to: number } | null;
  /** `credentials.json` as written, null before it is. */
  readonly credentials: string | null;
  /** The credentials `snapshot-<end_epoch>.json` answers, null before it is written. */
  readonly answered: AskedCredentials | null;
}

export type Step =
  | { readonly kind: "bootstrap" }
  | { readonly kind: "sync"; readonly args: readonly string[] }
  | {
      readonly kind: "read";
      readonly args: readonly string[];
      readonly stdin?: string;
      readonly stdout: string;
    }
  | { readonly kind: "credentials"; readonly asked: AskedCredentials }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "done" };

/** The network and the two stores, as both `amaru` commands take them. */
function stores(network: Network): string[] {
  return [
    "--network",
    network,
    "--chain-dir",
    chainDir(network),
    "--ledger-dir",
    ledgerDir(network),
  ];
}

export function bootstrapArgs(network: Network, epoch: number): string[] {
  return ["node", "bootstrap", ...stores(network), "--epoch", `${epoch}`];
}

/**
 * Where the sync stops: past the first `k` blocks of `end_epoch + 1`, which
 * the chain grows by within the stability window.
 */
export function syncUntil(network: Network, endEpoch: number): number {
  return firstSlot(network, endEpoch + 1) + stabilityWindowSlots(network);
}

/**
 * The epochs a node can start from with PRAGMA's published states: starting
 * in `X` takes the states at the end of `X - 3`, `X - 2` and `X - 1`. Each
 * state is named `<slot>.<hash>`, the slot of its epoch's last block.
 */
export function bootstrapEpochs(
  network: Network,
  states: readonly string[],
): number[] {
  const ends = new Set(
    states.map((name) =>
      epochOfShelleySlot(network, Number(name.split(".")[0])),
    ),
  );
  return [...ends]
    .filter((e) => ends.has(e - 1) && ends.has(e - 2))
    .map((e) => e + 1)
    .sort((a, b) => a - b);
}

/** The latest start no later than the survey's creation epoch. */
export function bootstrapEpoch(
  starts: readonly number[],
  survey: SurveyTarget,
): number | { readonly refuse: string } {
  const start = starts.filter((x) => x <= survey.epoch).at(-1);
  return (
    start ?? {
      refuse:
        `the survey was created in epoch ${survey.epoch}, and PRAGMA publishes ` +
        `no ${survey.network} ledger states to start from by then (starts: ` +
        `${starts.join(", ") || "none"})`,
    }
  );
}

const covers = (answered: AskedCredentials, asked: AskedCredentials) =>
  asked.accounts.every((k) => answered.accounts.includes(k)) &&
  asked.dreps.every((k) => answered.dreps.includes(k));

/**
 * The next step. `asked` is read from `blocks.json` once it exists, the
 * credentials the survey's responses name.
 */
export function nextStep(
  survey: SurveyTarget,
  s: StoresState,
  asked: () => AskedCredentials,
): Step {
  const { network, endEpoch: e } = survey;
  if (s.snapshots === null) return { kind: "bootstrap" };

  const restart = `remove ${chainDir(network)} and ${ledgerDir(network)} and run this again`;
  if (s.snapshots.length === 0) {
    return {
      kind: "refuse",
      reason: `the ledger store holds no snapshot, as after a bootstrap cut short; ${restart}`,
    };
  }
  if (!s.snapshots.includes(e)) {
    if (Math.max(...s.snapshots) > e) {
      return {
        kind: "refuse",
        reason: `the ledger store synced on into epoch ${e + 3} or later, which pruned snapshot ${e}; ${restart}`,
      };
    }
    return {
      kind: "sync",
      args: [
        "mithril",
        "sync",
        ...stores(network),
        "--ingest-until-slot",
        `${syncUntil(network, e)}`,
      ],
    };
  }

  const to = firstSlot(network, e + 1) - 1;
  if (s.walk === null || s.walk.from !== survey.slot || s.walk.to !== to) {
    return {
      kind: "read",
      args: [
        "blocks",
        network,
        chainDir(network),
        `${survey.slot}`,
        `${to}`,
        survey.txHash,
      ],
      stdout: BLOCKS,
    };
  }

  const credentials = asked();
  if (s.credentials !== JSON.stringify(credentials)) {
    return { kind: "credentials", asked: credentials };
  }
  if (s.answered === null || !covers(s.answered, credentials)) {
    return {
      kind: "read",
      args: ["snapshot", network, ledgerDir(network), `${e}`],
      stdin: CREDENTIALS,
      stdout: snapshotFile(e),
    };
  }
  return { kind: "done" };
}
