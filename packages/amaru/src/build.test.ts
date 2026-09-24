import { describe, expect, it } from "vitest";

import {
  bootstrapEpoch,
  bootstrapEpochs,
  nextStep,
  syncUntil,
  type StoresState,
  type SurveyTarget,
} from "./build";

// PRAGMA's preview index on 2026-09-24: sets ending at 999, 1118 and 1392.
const PREVIEW_STATES = [
  "120182379.580dbeff24394b3cc7336169e56481ab6c2cf03b79e85a4506510d835bf0e381",
  "120268790.90dabd5c02c717af2dcfcc870d525d4c2ade411f33ce14f1a0d2c9d7bc90810d",
  "120355165.a16a13df4299676ec0ff6ef2f7b6158d5b2c06ca655fc96259ca45c08398b42c",
  "86227191.68fe6cab42e20efe5684afd4f610dc974584334bc3e307ca2985b8aa1a48046b",
  "86313577.3953d7a887cce02c87029381109a86a14a832153a4da0f494ac5480b60bfe618",
  "86399953.5d37babd87c35b9d5464b8e6c81f655a2fae44a422a1104ca67a7f72476286af",
  "96508788.55cfdd7a9e265ab926c6e6c8c8650ad7e36d9319985deb7c214cb6277ef9a5b0",
  "96595057.b11c3d8bd8eb6a8a02577da3626eb9cec0a7123aa82999841d6a7c64f896696e",
  "96681576.e1e6a75082da17892300050a8d37c7a7d77de6f2c6c281b2719855a3710fdcf5",
];

// The preview survey the route was measured on.
const SURVEY: SurveyTarget = {
  network: "preview",
  key: "1356f08e538c2ea75b6b28e5a32c89c9b5d954f6aa9d616db7708a1bbbf689eb:0",
  txHash: "1356f08e538c2ea75b6b28e5a32c89c9b5d954f6aa9d616db7708a1bbbf689eb",
  slot: 117_950_000,
  epoch: 1365,
  endEpoch: 1395,
};

const ASKED = { accounts: ["key:aa"], dreps: ["key:bb", "script:cc"] };

const FRESH: StoresState = {
  snapshots: null,
  walk: null,
  credentials: null,
  answered: null,
};
const SYNCED: StoresState = { ...FRESH, snapshots: [1393, 1394, 1395] };
const WALKED: StoresState = {
  ...SYNCED,
  walk: { from: SURVEY.slot, to: 1396 * 86400 - 1 },
};
const ASKED_WRITTEN: StoresState = {
  ...WALKED,
  credentials: JSON.stringify(ASKED),
};

const step = (s: StoresState) => nextStep(SURVEY, s, () => ASKED);

describe("bootstrapEpochs", () => {
  it("offers the epoch after each run of three states", () => {
    expect(bootstrapEpochs("preview", PREVIEW_STATES)).toEqual([
      1000, 1119, 1393,
    ]);
  });

  it("offers no start where a state is missing", () => {
    expect(bootstrapEpochs("preview", PREVIEW_STATES.slice(1, 6))).toEqual([
      1000,
    ]);
  });
});

describe("bootstrapEpoch", () => {
  const starts = [1000, 1119, 1393];

  it("takes the latest start no later than the survey's creation", () => {
    expect(bootstrapEpoch(starts, SURVEY)).toBe(1119);
    expect(bootstrapEpoch(starts, { ...SURVEY, epoch: 1393 })).toBe(1393);
  });

  it("refuses a survey older than every start", () => {
    expect(bootstrapEpoch(starts, { ...SURVEY, epoch: 999 })).toEqual({
      refuse: expect.stringMatching(/created in epoch 999.*1000, 1119, 1393/),
    });
  });
});

describe("nextStep", () => {
  it("bootstraps an empty directory", () => {
    expect(step(FRESH)).toEqual({ kind: "bootstrap" });
  });

  it("syncs past the first k blocks of end_epoch + 1", () => {
    expect(syncUntil("preview", 1395)).toBe(1396 * 86400 + 25920);
    expect(step({ ...FRESH, snapshots: [1116, 1117, 1118] })).toEqual({
      kind: "sync",
      args: [
        "mithril",
        "sync",
        "--network",
        "preview",
        "--chain-dir",
        "chain.preview.db",
        "--ledger-dir",
        "ledger.preview.db",
        "--ingest-until-slot",
        `${1396 * 86400 + 25920}`,
      ],
    });
  });

  it("refuses a store that pruned snapshot end_epoch", () => {
    expect(step({ ...FRESH, snapshots: [1396, 1397, 1398] })).toMatchObject({
      kind: "refuse",
      reason: expect.stringMatching(/pruned snapshot 1395/),
    });
  });

  it("refuses a bootstrap cut short", () => {
    expect(step({ ...FRESH, snapshots: [] })).toMatchObject({
      kind: "refuse",
    });
  });

  it("walks from the survey's slot through the last slot of end_epoch", () => {
    const walk = {
      kind: "read",
      args: [
        "blocks",
        "preview",
        "chain.preview.db",
        `${SURVEY.slot}`,
        `${1396 * 86400 - 1}`,
        SURVEY.txHash,
      ],
      stdout: "blocks.json",
    };
    expect(step(SYNCED)).toEqual(walk);
    expect(step({ ...SYNCED, walk: { from: 0, to: 1 } })).toEqual(walk);
  });

  it("writes the credentials the walk names, then asks the snapshot", () => {
    expect(step(WALKED)).toEqual({ kind: "credentials", asked: ASKED });
    expect(step(ASKED_WRITTEN)).toEqual({
      kind: "read",
      args: ["snapshot", "preview", "ledger.preview.db", "1395"],
      stdin: "credentials.json",
      stdout: "snapshot-1395.json",
    });
  });

  it("asks the snapshot again when it misses a credential", () => {
    expect(
      step({
        ...ASKED_WRITTEN,
        answered: { accounts: ["key:aa"], dreps: ["key:bb"] },
      }),
    ).toMatchObject({ kind: "read", stdout: "snapshot-1395.json" });
  });

  it("is done once the snapshot answers every credential", () => {
    expect(step({ ...ASKED_WRITTEN, answered: ASKED })).toEqual({
      kind: "done",
    });
  });
});
