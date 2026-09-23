import { describe, expect, it } from "vitest";

import {
  aggregatorOf,
  configProblems,
  nextStep,
  overlay,
  type NodeState,
} from "./build";

// The preview audit of end epoch 1428: the store stood at 1429's first block.
const TIP = 123465614;

const CONFIG = `[storage]
version = "v4"
path = "data"

[serve.minibf]
listen_address = "[::]:3000"

[mithril]
aggregator = "https://aggregator.pre-release-preview.api.mithril.network/aggregator"

[chain]
type = "cardano"
magic = 2
`;

const node = (
  tip: number | null,
  written: string | null = overlay(1429),
): NodeState => ({
  network: "preview",
  endEpoch: 1428,
  config: CONFIG,
  overlay: written,
  store: { state: { tip_slot: tip } },
});

describe("nextStep", () => {
  it("asks for `dolos init` before anything else", () => {
    const step = nextStep({
      network: "preview",
      endEpoch: 1428,
      config: null,
      overlay: null,
      store: null,
    });
    expect(step.kind).toBe("init");
    if (step.kind === "init")
      expect(step.args.slice(0, 3)).toEqual([
        "init",
        "--known-network",
        "preview",
      ]);
  });

  it("writes the overlay for the end epoch before bootstrapping", () => {
    expect(nextStep(node(null, null))).toEqual({
      kind: "overlay",
      content: overlay(1429),
    });
  });

  it("bootstraps an empty store to the first block of the next epoch", () => {
    expect(nextStep(node(null))).toEqual({
      kind: "run",
      args: [
        "-c",
        "audit.toml",
        "bootstrap",
        "mithril",
        "--download-end",
        "28581",
      ],
      needsFile: 28581,
    });
  });

  it("is done once the store stands in the next epoch", () => {
    expect(nextStep(node(TIP))).toEqual({ kind: "done" });
  });

  it("refuses a store standing anywhere else, or built for another epoch", () => {
    expect(nextStep(node(TIP - 86400)).kind).toBe("refuse");
    expect(nextStep(node(TIP + 86400)).kind).toBe("refuse");
    expect(nextStep(node(TIP, overlay(1430))).kind).toBe("refuse");
  });
});

describe("configProblems", () => {
  it("accepts a config keeping all history", () => {
    expect(configProblems(CONFIG)).toEqual([]);
  });

  it("refuses one pruning it", () => {
    expect(
      configProblems(`${CONFIG}\n[sync]\nmax_history = 10\n`),
    ).toHaveLength(1);
  });
});

it("reads the aggregator and writes the overlay", () => {
  expect(aggregatorOf(CONFIG)).toBe(
    "https://aggregator.pre-release-preview.api.mithril.network/aggregator",
  );
  expect(overlay(1429)).toContain("stop_epoch = 1429");
});
