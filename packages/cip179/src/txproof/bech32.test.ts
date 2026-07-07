import { describe, expect, it } from "vitest";
import type { Credential } from "../index.js";

import { hexToBytes } from "../domain/index.js";

import { drepId, govActionId, stakeAddress } from "./bech32.js";

// A real preview DRep: Koios /vote_list reports voter_id
// drep1ytgkj79hlqzj45ec80h9jvxn0mq9leyrlaz804gd7dv9c4ck89389 (CIP-129) for
// this key hash — the pair pins our encoding to what Koios itself emits.
const DREP_KEY_HASH =
  "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57";

// A real preview action: Koios /proposal_list reports this proposal_id for
// (tx 178a…e00f, index 0).
const ACTION_TX =
  "178a410703c9a88d38acc8e7e00217722f98e697c826ebd105e0c5beaf32e00f";
const ACTION_ID =
  "gov_action1z79yzpcrex5g6w9vern7qqshwghe3e5heqnwh5g9urzmatejuq8sq5ak6sd";

const keyCred = (hex: string): Credential => ({
  type: "key",
  keyHash: hexToBytes(hex),
});
const scriptCred = (hex: string): Credential => ({
  type: "script",
  scriptHash: hexToBytes(hex),
});

describe("drepId", () => {
  it("encodes a key-hash DRep to its CIP-129 id (Koios voter_id vector)", async () => {
    expect(await drepId(keyCred(DREP_KEY_HASH))).toBe(
      "drep1ytgkj79hlqzj45ec80h9jvxn0mq9leyrlaz804gd7dv9c4ck89389",
    );
  });

  it("distinguishes script DReps (different CIP-129 header)", async () => {
    const key = await drepId(keyCred(DREP_KEY_HASH));
    const script = await drepId(scriptCred(DREP_KEY_HASH));
    expect(script).toMatch(/^drep1/);
    expect(script).not.toBe(key);
  });
});

describe("govActionId", () => {
  it("encodes (txId, index) to the CIP-129 id (Koios proposal_id vector)", async () => {
    expect(await govActionId(ACTION_TX, 0)).toBe(ACTION_ID);
  });

  it("the action index changes the id", async () => {
    expect(await govActionId(ACTION_TX, 1)).not.toBe(ACTION_ID);
  });
});

describe("stakeAddress", () => {
  const HASH = "32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc";

  it("uses the CIP-19 header nibbles (key/script × network prefixes)", async () => {
    expect(await stakeAddress(keyCred(HASH), "preview")).toMatch(
      /^stake_test1u/,
    );
    expect(await stakeAddress(keyCred(HASH), "mainnet")).toMatch(/^stake1u/);
    expect(await stakeAddress(scriptCred(HASH), "preview")).toMatch(
      /^stake_test17/,
    );
    expect(await stakeAddress(scriptCred(HASH), "mainnet")).toMatch(/^stake17/);
  });

  it("is deterministic per credential", async () => {
    expect(await stakeAddress(keyCred(HASH), "preview")).toBe(
      await stakeAddress(keyCred(HASH), "preview"),
    );
  });
});
