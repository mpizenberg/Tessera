import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "cardano-tessera-core";

import { koiosChain } from "./sources";

const CONFIG: AppConfig = {
  network: "preview",
  koiosUrl: "http://koios.test/api/v1",
  koiosToken: undefined,
  sinceUnix: 0,
  secondsPerEpoch: 86_400,
};

const SURVEY_TX = "cd".repeat(32);
const RESP_TX = "ab".repeat(32);
const LATE_TX = "ef".repeat(32);
const END_EPOCH = 1_345;

const definition = {
  "17": [
    0,
    [
      {
        "0": 5,
        "1": [0, `0x${"0f".repeat(28)}`],
        "2": "t",
        "3": "",
        "4": [3],
        "5": END_EPOCH,
        "6": [0],
        "7": [[1, "q", ["yes", "no"]]],
      },
    ],
  ],
};
const answer = {
  "17": [
    1,
    [
      {
        "0": 5,
        "1": [`0x${SURVEY_TX}`, 0],
        "2": 3,
        "3": [0, `0x${"11".repeat(28)}`],
        "4": [[1, 0, 0]],
      },
    ],
  ],
};

/**
 * The label-17 index holds the definition at slot 5000, a response inside
 * the window and one past it; the tip is 100 slots into epoch 1346, so
 * `end_epoch` 1345 ends at slot 9899.
 */
const LISTED = [
  { tx_hash: SURVEY_TX, absolute_slot: 5_000, epoch_no: 1_340 },
  { tx_hash: RESP_TX, absolute_slot: 5_100, epoch_no: 1_340 },
  { tx_hash: LATE_TX, absolute_slot: 9_950, epoch_no: 1_346 },
];
const METADATA: Record<string, unknown> = {
  [SURVEY_TX]: definition,
  [RESP_TX]: answer,
  [LATE_TX]: answer,
};

function stubKoios() {
  const scans: string[][] = [];
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith("/tx_info"))
      return json([
        { tx_hash: SURVEY_TX, absolute_slot: 5_000, tx_block_index: 0 },
      ]);
    if (url.pathname.endsWith("/tip"))
      return json([
        {
          epoch_no: 1_346,
          abs_slot: 10_000,
          epoch_slot: 100,
          block_time: 1_750_000_000,
        },
      ]);
    if (url.pathname.endsWith("/epoch_params"))
      return json([{ gov_action_lifetime: 6 }]);
    if (url.pathname.endsWith("/tx_by_metalabel")) {
      const bounds = url.searchParams.getAll("absolute_slot");
      scans.push(bounds);
      const [gte, lte] = bounds.map((b) => Number(b.split(".")[1]));
      return json(
        LISTED.filter(
          (r) => r.absolute_slot >= gte! && r.absolute_slot <= lte!,
        ),
      );
    }
    if (url.pathname.endsWith("/tx_metadata")) {
      const { _tx_hashes } = JSON.parse(String(init?.body)) as {
        _tx_hashes: string[];
      };
      return json(
        _tx_hashes.map((h) => ({ tx_hash: h, metadata: METADATA[h] })),
      );
    }
    return json([]);
  });
  vi.stubGlobal("fetch", mock);
  return scans;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("koiosChain", () => {
  it("scans the survey's window only: from its defining transaction through end_epoch", async () => {
    const scans = stubKoios();
    const { bundle, incomplete } = await koiosChain(CONFIG).bundle(
      `${SURVEY_TX}:0`,
    );
    expect(scans).toEqual([
      ["gte.5000", "lte.5000"],
      ["gte.5000", "lte.9899"],
    ]);
    expect(bundle.survey.definition.endEpoch).toBe(END_EPOCH);
    expect(bundle.responses.map((r) => r.txHash)).toEqual([RESP_TX]);
    expect(incomplete).toBe(false);
  });
});
