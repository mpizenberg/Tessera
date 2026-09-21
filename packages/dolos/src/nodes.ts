/**
 * The two Dolos nodes a survey's audit reads, built from Mithril one step at
 * a time. Each step is chosen from where both stores stand, so a rerun takes
 * up after the last step that finished:
 *  - `end`, bootstrapped to the last block of `end_epoch = E`;
 *  - `after`, a copy of `end` continued a block into `E + 2`, where
 *    `stop_epoch` halts it, then its write-ahead log reseeded, which this
 *    Dolos release skips on that forced stop.
 * What the after node changes sits in an overlay passed with `-c`, which
 * Dolos merges over the `dolos.toml` copied from the end node.
 */

import type { Network } from "cardano-tessera-client";

import { fileOf, firstSlot, stoppingPoints } from "./stoppingPoints";

/** The part of `dolos data summary` read here. */
export interface StoreSummary {
  readonly wal: { readonly tip_slot: number | null };
  readonly state: { readonly tip_slot: number | null };
}

export interface NodesState {
  readonly network: Network;
  readonly endEpoch: number;
  /** Null before `dolos init` has written the end node's `dolos.toml`. */
  readonly end: {
    readonly config: string;
    readonly store: StoreSummary;
  } | null;
  /** Null before the end node is copied. */
  readonly after: StoreSummary | null;
}

export type Step =
  | { readonly kind: "init"; readonly args: readonly string[] }
  | { readonly kind: "refuse"; readonly reason: string }
  | {
      readonly kind: "run";
      readonly node: "end" | "after";
      readonly args: readonly string[];
      /** The immutable file Mithril must have certified first. */
      readonly needsFile?: number;
    }
  | { readonly kind: "copy" }
  | { readonly kind: "done" };

export const AFTER_OVERLAY = "after.toml";

export const PORTS = { endMinibf: 3000, afterMinibf: 3001, minikupo: 1442 };

/**
 * Tables whose port the after node, a copy of the end node, would bind a
 * second time. `dolos init` writes the end node's mini-Blockfrost on
 * {@link PORTS}' `endMinibf`, and the overlay moves the after node's.
 */
const CLASHING = ["serve.grpc", "serve.minikupo", "serve.trp", "relay"];

/** Why the end node's `dolos.toml` cannot serve an audit, if it cannot. */
export function configProblems(toml: string): string[] {
  const tables = new Set(
    [...toml.matchAll(/^\[([\w.]+)\]/gm)].map((m) => m[1]),
  );
  const problems: string[] = [];
  if (!tables.has("serve.minibf")) {
    problems.push("it does not serve mini-Blockfrost");
  }
  for (const table of CLASHING) {
    if (tables.has(table)) {
      problems.push(
        `it enables [${table}], which the after node would bind on the same port`,
      );
    }
  }
  if (/^max_history\s*=/m.test(toml)) {
    problems.push(
      "it prunes history, and the audit reads transactions from any epoch",
    );
  }
  return problems;
}

/** The Mithril aggregator a `dolos.toml` bootstraps from. */
export function aggregatorOf(toml: string): string | undefined {
  return /^aggregator\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
}

export function afterOverlay(stopEpoch: number): string {
  return [
    "[chain]",
    `stop_epoch = ${stopEpoch}`,
    "",
    "[serve.minibf]",
    `listen_address = "[::]:${PORTS.afterMinibf}"`,
    "",
    "[serve.minikupo]",
    `listen_address = "[::]:${PORTS.minikupo}"`,
    "",
  ].join("\n");
}

export function nextStep(s: NodesState): Step {
  const { network, endEpoch: e } = s;
  if (s.end === null) {
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
  const problems = configProblems(s.end.config);
  if (problems.length > 0) {
    return {
      kind: "refuse",
      reason: `the end node's dolos.toml cannot serve an audit: ${problems.join("; ")}. Edit it, or run \`dolos init\` there again.`,
    };
  }

  const points = stoppingPoints(network, e);
  const endTip = s.end.store.state.tip_slot;
  if (endTip === null) {
    return {
      kind: "run",
      node: "end",
      args: [
        "bootstrap",
        "mithril",
        "--download-end",
        `${points.endDownloadEnd}`,
      ],
      needsFile: points.endDownloadEnd,
    };
  }
  if (endTip >= firstSlot(network, e + 1)) {
    return {
      kind: "refuse",
      reason: `the end node stands at slot ${endTip}, past epoch ${e}; remove its data directory and run this again`,
    };
  }
  if (fileOf(network, endTip) !== points.afterDownloadStart) {
    return {
      kind: "refuse",
      reason:
        `the end node stands at slot ${endTip}, in immutable file ${fileOf(network, endTip)}, ` +
        `short of epoch ${e}'s last file ${points.afterDownloadStart}; remove its data directory and run this again`,
    };
  }

  if (s.after === null) return { kind: "copy" };
  const afterTip = s.after.state.tip_slot;
  if (afterTip === endTip) {
    return {
      kind: "run",
      node: "after",
      args: [
        "-c",
        AFTER_OVERLAY,
        "bootstrap",
        "--continue",
        "mithril",
        "--download-start",
        `${fileOf(network, endTip)}`,
        "--download-end",
        `${points.afterDownloadEnd}`,
      ],
      needsFile: points.afterDownloadEnd,
    };
  }
  if (
    afterTip === null ||
    afterTip < firstSlot(network, e + 2) ||
    afterTip >= firstSlot(network, e + 3)
  ) {
    return {
      kind: "refuse",
      reason: `the after node stands at slot ${afterTip}, not in epoch ${e + 2}; remove its directory and run this again`,
    };
  }
  if (s.after.wal.tip_slot !== afterTip) {
    return {
      kind: "run",
      node: "after",
      args: ["-c", AFTER_OVERLAY, "doctor", "reset-wal"],
    };
  }
  return { kind: "done" };
}
