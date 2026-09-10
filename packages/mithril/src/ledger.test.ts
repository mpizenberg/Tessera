import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { readLedgerState } from "./ledger";

/**
 * Pins the positional paths through the state file against numbers Koios
 * reports for preview, read on 2026-09-10: `/epoch_info` active stake for
 * epochs 1413, 1414 and 1415, `/drep_epoch_summary` for 1414, one account's
 * `/account_stake_history` row for 1413 and one DRep's
 * `/drep_voting_power_history` row for 1414. Runs only when the snapshot the
 * README recipe produces is present.
 */
const STATE = "snapshots/preview-e1414-i28296/ledger/122242438/state";

describe.skipIf(!existsSync(STATE))("the preview epoch-1414 state file", () => {
  it("reads the epoch, the slot and the totals Koios reports", async () => {
    const state = readLedgerState(await readFile(STATE));
    expect(state.epoch).toBe(1414);
    expect(state.slot).toBe(122242438);
    expect(state.go.total).toBe(1541215471624452n);
    expect(state.set.total).toBe(1541610641571045n);
    expect(state.mark.total).toBe(1542332046171871n);
    expect(state.drepDistribution.total).toBe(464640171303597n);
    expect(state.drepDistribution.power.size + 2).toBe(3022);
    expect(
      state.go.stake.get(
        "script:7aa4312097def38936c7b69fb380f9e8685dfa17c52c68151781ea03",
      )?.stake,
    ).toBe(962877672146n);
    expect(
      state.drepDistribution.power.get(
        "key:000e058ed523b3c64865089580f1604e13178f5df2bee538e1b96203",
      ),
    ).toBe(296313592949n);
  });
});
