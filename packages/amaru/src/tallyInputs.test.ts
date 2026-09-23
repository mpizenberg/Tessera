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

/**
 * Three snapshots asked about the same three credentials, where each question
 * has a different answer per epoch.
 */
function stores(): AmaruStores {
  const dir = mkdtempSync(join(tmpdir(), "amaru-"));
  const write = (epoch: number, body: object) =>
    writeFileSync(
      join(dir, `snapshot-${epoch}.json`),
      JSON.stringify({
        epoch,
        gov_action_lifetime: 30,
        proposals: {},
        ...body,
      }),
    );
  write(98, {
    accounts: {
      [`key:${KEY}`]: { stake: "1000", pool: "pool" },
      [`script:${SCRIPT}`]: { stake: "500", pool: null },
      [`key:${ABSENT}`]: null,
    },
    dreps: {
      [`key:${KEY}`]: { voting_stake: "98" },
      [`script:${SCRIPT}`]: null,
    },
  });
  write(99, {
    accounts: {
      [`key:${KEY}`]: { stake: "2000", pool: "pool" },
      [`script:${SCRIPT}`]: null,
      [`key:${ABSENT}`]: null,
    },
    dreps: {
      [`key:${KEY}`]: { voting_stake: "99" },
      [`script:${SCRIPT}`]: null,
    },
  });
  write(100, {
    accounts: {
      [`key:${KEY}`]: { stake: "3000", pool: "pool" },
      [`script:${SCRIPT}`]: { stake: "700", pool: "pool" },
      [`key:${ABSENT}`]: null,
    },
    dreps: {
      [`key:${KEY}`]: { voting_stake: "100" },
      [`script:${SCRIPT}`]: { voting_stake: "1" },
    },
  });
  return new AmaruStores(dir);
}

describe("AmaruTallyInputs", () => {
  const inputs = new AmaruTallyInputs(stores());

  it("weighs a stakeholder registered at E by the stake of E-2 behind a standing pool", async () => {
    const got = await inputs.stakeholderWeights(100, [
      cred(KEY),
      cred(SCRIPT, "script"),
      cred(ABSENT),
    ]);
    expect(got.get(`key:${KEY}`)).toEqual({ registered: true, weight: 1000n });
    // Registered at E, but no pool at E-2: registered and empty.
    expect(got.get(`script:${SCRIPT}`)).toEqual({
      registered: true,
      weight: 0n,
    });
    expect(got.get(`key:${ABSENT}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("weighs a DRep registered at E by the voting stake of E-1", async () => {
    const got = await inputs.drepWeights(100, [
      cred(KEY),
      cred(SCRIPT, "script"),
    ]);
    expect(got.get(`key:${KEY}`)).toEqual({ registered: true, weight: 99n });
    // Registered at E, absent from E-1's distribution.
    expect(got.get(`script:${SCRIPT}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("refuses a credential the snapshots were not asked about", async () => {
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
