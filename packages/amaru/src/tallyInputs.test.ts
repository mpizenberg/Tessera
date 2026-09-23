import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Credential } from "cip-179";
import { hexToBytes } from "cip-179/domain";
import { describe, expect, it } from "vitest";

import { AmaruStores } from "./stores";
import { AmaruTallyInputs } from "./tallyInputs";

const KEY = "aa".repeat(28);
const SCRIPT = "bb".repeat(28);
const ABSENT = "cc".repeat(28);
const cred = (hash: string, kind: "key" | "script" = "key"): Credential =>
  kind === "key"
    ? { type: "key", keyHash: hexToBytes(hash) }
    : { type: "script", scriptHash: hexToBytes(hash) };

/** Snapshot 100, the ledger at the end of epoch 100. */
function stores(): AmaruStores {
  const dir = mkdtempSync(join(tmpdir(), "amaru-"));
  writeFileSync(
    join(dir, "snapshot-100.json"),
    JSON.stringify({
      epoch: 100,
      proposals: {},
      accounts: {
        [`key:${KEY}`]: { stake: "3000", pool: "pool" },
        [`script:${SCRIPT}`]: { stake: "700", pool: null },
        [`key:${ABSENT}`]: null,
      },
      dreps: {
        [`key:${KEY}`]: { voting_stake: "100" },
        [`script:${SCRIPT}`]: { voting_stake: "0" },
      },
    }),
  );
  return new AmaruStores(dir);
}

describe("AmaruTallyInputs", () => {
  const inputs = new AmaruTallyInputs(stores());

  it("weighs a stakeholder registered at E's end by its stake behind a standing pool then", async () => {
    const got = await inputs.stakeholderWeights(100, [
      cred(KEY),
      cred(SCRIPT, "script"),
      cred(ABSENT),
    ]);
    expect(got.get(`key:${KEY}`)).toEqual({ registered: true, weight: 3000n });
    // Registered, but no pool standing: registered and empty.
    expect(got.get(`script:${SCRIPT}`)).toEqual({
      registered: true,
      weight: 0n,
    });
    expect(got.get(`key:${ABSENT}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("weighs a DRep registered at E's end by the distribution taken then", async () => {
    const got = await inputs.drepWeights(100, [
      cred(KEY),
      cred(SCRIPT, "script"),
    ]);
    expect(got.get(`key:${KEY}`)).toEqual({ registered: true, weight: 100n });
    expect(got.get(`script:${SCRIPT}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("refuses a credential the snapshot was not asked about", async () => {
    await expect(inputs.drepWeights(100, [cred(ABSENT)])).rejects.toThrow(
      `snapshot-100.json was not asked about key:${ABSENT}`,
    );
  });

  it("refuses a snapshot file whose epoch is not its name", () => {
    const dir = mkdtempSync(join(tmpdir(), "amaru-"));
    writeFileSync(join(dir, "snapshot-5.json"), JSON.stringify({ epoch: 6 }));
    expect(() => new AmaruStores(dir).snapshot(5)).toThrow("epoch 6");
  });
});
