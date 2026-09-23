/**
 * The Dolos node a survey's audit reads, built from Mithril one step at a
 * time. Each step is chosen from where the store stands, so a rerun takes up
 * after the last step that finished. The node replays to the first block of
 * `end_epoch + 1`, where `stop_epoch` halts it: the boundary out of
 * `end_epoch` has run, so its store holds the ledger at the end of that
 * epoch. What an audit adds to the node's own `dolos.toml` sits in an
 * overlay passed with `-c`, which Dolos merges over it.
 */

import type { Network } from "cardano-tessera-client";

import { firstSlot, stoppingPoint } from "./stoppingPoints";

/** The part of `dolos data summary` read here. */
export interface StoreSummary {
  readonly state: { readonly tip_slot: number | null };
}

export interface NodeState {
  readonly network: Network;
  readonly endEpoch: number;
  /** Null before `dolos init` has written the node's `dolos.toml`. */
  readonly config: string | null;
  /** The overlay as written, null before it is. */
  readonly overlay: string | null;
  /** Null while there is no config to read the store with. */
  readonly store: StoreSummary | null;
}

export type Step =
  | { readonly kind: "init"; readonly args: readonly string[] }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "overlay"; readonly content: string }
  | {
      readonly kind: "run";
      readonly args: readonly string[];
      /** The immutable file Mithril must have certified first. */
      readonly needsFile: number;
    }
  | { readonly kind: "done" };

export const OVERLAY = "audit.toml";

/** Where the served node answers, as the overlay sets them. */
export const PORTS = { minibf: 3000, minikupo: 1442 };

/** Why the node's `dolos.toml` cannot serve an audit, if it cannot. */
export function configProblems(toml: string): string[] {
  return /^max_history\s*=/m.test(toml)
    ? ["it prunes history, and the audit reads transactions from any epoch"]
    : [];
}

/** The Mithril aggregator a `dolos.toml` bootstraps from. */
export function aggregatorOf(toml: string): string | undefined {
  return /^aggregator\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
}

/**
 * The stop epoch, and the two APIs the verifier reads the chain from:
 * mini-Blockfrost, and minikupo, the one serving a native script's bytes by
 * hash.
 */
export function overlay(stopEpoch: number): string {
  return [
    "[chain]",
    `stop_epoch = ${stopEpoch}`,
    "",
    "[serve.minibf]",
    `listen_address = "[::]:${PORTS.minibf}"`,
    "",
    "[serve.minikupo]",
    `listen_address = "[::]:${PORTS.minikupo}"`,
    "",
  ].join("\n");
}

export function nextStep(s: NodeState): Step {
  const { network, endEpoch: e } = s;
  if (s.config === null) {
    return {
      kind: "init",
      args: [
        "init",
        "--known-network",
        network,
        "--serve-minibf",
        "true",
        "--serve-grpc",
        "false",
        "--serve-minikupo",
        "false",
        "--serve-trp",
        "false",
        "--enable-relay",
        "false",
      ],
    };
  }
  const problems = configProblems(s.config);
  if (problems.length > 0) {
    return {
      kind: "refuse",
      reason: `the node's dolos.toml cannot serve an audit: ${problems.join("; ")}. Edit it, or run \`dolos init\` there again.`,
    };
  }

  const point = stoppingPoint(network, e);
  const wanted = overlay(point.stopEpoch);
  const tip = s.store?.state.tip_slot ?? null;
  if (s.overlay !== wanted) {
    return tip === null
      ? { kind: "overlay", content: wanted }
      : {
          kind: "refuse",
          reason: `the node's ${OVERLAY} is not the one for end epoch ${e}; remove its data directory and ${OVERLAY}, and run this again`,
        };
  }
  if (tip === null) {
    return {
      kind: "run",
      args: [
        "-c",
        OVERLAY,
        "bootstrap",
        "mithril",
        "--download-end",
        `${point.downloadEnd}`,
      ],
      needsFile: point.downloadEnd,
    };
  }
  if (tip < firstSlot(network, e + 1) || tip >= firstSlot(network, e + 2)) {
    return {
      kind: "refuse",
      reason: `the node stands at slot ${tip}, not in epoch ${e + 1}; remove its data directory and run this again`,
    };
  }
  return { kind: "done" };
}
