import { describe, expect, it } from "vitest";

import {
  afterOverlay,
  aggregatorOf,
  configProblems,
  nextStep,
  type NodesState,
  type StoreSummary,
} from "./nodes";

// The preview audit of a survey ending in 1395: the end node's store stood at
// the last block of 1395, and the after node's a block into 1397.
const END_TIP = 120614390;
const AFTER_TIP = 120700882;

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

const at = (state: number | null, wal = state): StoreSummary => ({
  wal: { tip_slot: wal },
  state: { tip_slot: state },
});

const nodes = (
  end: StoreSummary,
  after: StoreSummary | null = null,
): NodesState => ({
  network: "preview",
  endEpoch: 1395,
  end: { config: CONFIG, store: end },
  after,
});

describe("nextStep", () => {
  it("asks for `dolos init` before anything else", () => {
    const step = nextStep({
      network: "preview",
      endEpoch: 1395,
      end: null,
      after: null,
    });
    expect(step.kind).toBe("init");
    if (step.kind === "init")
      expect(step.args.slice(0, 3)).toEqual([
        "init",
        "--known-network",
        "preview",
      ]);
  });

  it("refuses a config that would clash with the after node", () => {
    const step = nextStep({
      ...nodes(at(null)),
      end: {
        config: `${CONFIG}\n[serve.grpc]\nlisten_address = "[::]:50051"\n`,
        store: at(null),
      },
    });
    expect(step.kind).toBe("refuse");
  });

  it("bootstraps an empty end node to the end of the epoch", () => {
    expect(nextStep(nodes(at(null)))).toEqual({
      kind: "run",
      node: "end",
      args: ["bootstrap", "mithril", "--download-end", "27920"],
      needsFile: 27920,
    });
  });

  it("copies an end node standing in the epoch's last file", () => {
    expect(nextStep(nodes(at(END_TIP)))).toEqual({ kind: "copy" });
  });

  it("refuses an end node past the epoch, or short of its last file", () => {
    expect(nextStep(nodes(at(AFTER_TIP))).kind).toBe("refuse");
    expect(nextStep(nodes(at(27900 * 4320 + 5))).kind).toBe("refuse");
  });

  it("continues the copy from the end node's file into E + 2", () => {
    expect(nextStep(nodes(at(END_TIP), at(END_TIP)))).toEqual({
      kind: "run",
      node: "after",
      args: [
        "-c",
        "after.toml",
        "bootstrap",
        "--continue",
        "mithril",
        "--download-start",
        "27919",
        "--download-end",
        "27941",
      ],
      needsFile: 27941,
    });
  });

  it("reseeds the write-ahead log the forced stop left behind", () => {
    expect(nextStep(nodes(at(END_TIP), at(AFTER_TIP, END_TIP)))).toEqual({
      kind: "run",
      node: "after",
      args: ["-c", "after.toml", "doctor", "reset-wal"],
    });
  });

  it("is done once the after node stands in E + 2 with its log reseeded", () => {
    expect(nextStep(nodes(at(END_TIP), at(AFTER_TIP)))).toEqual({
      kind: "done",
    });
  });

  it("refuses an after node stopped anywhere but E + 2", () => {
    expect(nextStep(nodes(at(END_TIP), at(END_TIP + 86400))).kind).toBe(
      "refuse",
    );
    expect(nextStep(nodes(at(END_TIP), at(AFTER_TIP + 86400))).kind).toBe(
      "refuse",
    );
    expect(nextStep(nodes(at(END_TIP), at(null))).kind).toBe("refuse");
  });
});

describe("configProblems", () => {
  it("accepts a config serving mini-Blockfrost alone and keeping all history", () => {
    expect(configProblems(CONFIG)).toEqual([]);
  });

  it("names each problem", () => {
    const config =
      CONFIG.replace("[serve.minibf]", "[serve.minikupo]") +
      "\n[sync]\nmax_history = 10\n";
    expect(configProblems(config)).toHaveLength(3);
  });
});

it("reads the aggregator and writes the after node's overlay", () => {
  expect(aggregatorOf(CONFIG)).toBe(
    "https://aggregator.pre-release-preview.api.mithril.network/aggregator",
  );
  expect(afterOverlay(1397)).toContain("stop_epoch = 1397");
});
