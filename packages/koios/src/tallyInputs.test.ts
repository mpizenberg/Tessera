import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "cip-179";

import { hexToBytes } from "cip-179/domain";
import type { AppConfig } from "@tessera/core";

import { stakeAddress } from "cip-179/txproof";
import { KoiosTallyInputs } from "./tallyInputs";

const CONFIG: AppConfig = {
  network: "preview",
  koiosUrl: "http://koios.test/api/v1",
  koiosToken: undefined,
  sinceUnix: 0,
  secondsPerEpoch: 86_400,
};

const HASH_A = "aa".repeat(28);
const HASH_B = "bb".repeat(28);
const HASH_C = "cc".repeat(28);
const cred = (hex: string): Credential => ({
  type: "key",
  keyHash: hexToBytes(hex),
});

type Handler = (
  url: string,
  body: { _stake_addresses?: string[] } | null,
) => unknown;

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as never) : null;
    return new Response(JSON.stringify(handler(String(input), body)), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("KoiosTallyInputs.stakeholderWeights", () => {
  it("joins registration state and active stake at the epoch", async () => {
    const [addrA, addrB, addrC] = await Promise.all([
      stakeAddress(cred(HASH_A), "preview"),
      stakeAddress(cred(HASH_B), "preview"),
      stakeAddress(cred(HASH_C), "preview"),
    ]);
    stubFetch((url) => {
      if (url.includes("/account_update_history")) {
        expect(url).toContain("epoch_no=lte.1345");
        return [
          // A: registered then delegated — registered, has stake.
          {
            stake_address: addrA,
            action_type: "registration",
            absolute_slot: 10,
            epoch_no: 1,
          },
          {
            stake_address: addrA,
            action_type: "delegation_pool",
            absolute_slot: 20,
            epoch_no: 1,
          },
          // B: registered then deregistered — out.
          {
            stake_address: addrB,
            action_type: "registration",
            absolute_slot: 10,
            epoch_no: 1,
          },
          {
            stake_address: addrB,
            action_type: "deregistration",
            absolute_slot: 30,
            epoch_no: 2,
          },
          // C: dereg then re-registration (order scrambled in the response —
          // absolute_slot decides) — registered, but no stake row → weight 0.
          {
            stake_address: addrC,
            action_type: "registration",
            absolute_slot: 50,
            epoch_no: 3,
          },
          {
            stake_address: addrC,
            action_type: "deregistration",
            absolute_slot: 40,
            epoch_no: 2,
          },
          {
            stake_address: addrC,
            action_type: "registration",
            absolute_slot: 10,
            epoch_no: 1,
          },
        ];
      }
      if (url.includes("/account_stake_history")) {
        expect(url).toContain("epoch_no=eq.1345");
        return [
          {
            stake_address: addrA,
            epoch_no: 1345,
            active_stake: "45000000000000000",
          },
        ];
      }
      throw new Error(`unexpected ${url}`);
    });

    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A), cred(HASH_B), cred(HASH_C)],
    );
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 45_000_000_000_000_000n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: false,
      weight: 0n,
    });
    // Registered-but-empty counts with weight 0 (§6.1).
    expect(weights.get(`key:${HASH_C}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("offset-paginates account_update_history past Koios's row cap (finding 4)", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    const PAGE = 100; // must match tallyInputs' PAGE_LIMIT
    const seenOffsets: number[] = [];
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        // The query is filtered to the two state-changing event types.
        expect(url).toContain("action_type=in.(registration,deregistration)");
        const offset = Number(new URL(url).searchParams.get("offset"));
        seenOffsets.push(offset);
        if (offset === 0) {
          // A full page of registration events at low slots — each leaves the
          // account "registered", so without page 2 it looks live.
          return Array.from({ length: PAGE }, (_, i) => ({
            stake_address: addrA,
            action_type: "registration",
            absolute_slot: i + 1,
            epoch_no: 1,
          }));
        }
        // The final event — a deregistration at the highest slot — lives only
        // on the second page; it must win, proving the page was read.
        if (offset === PAGE) {
          return [
            {
              stake_address: addrA,
              action_type: "deregistration",
              absolute_slot: 10_000,
              epoch_no: 5,
            },
          ];
        }
        return [];
      }
      throw new Error(`unexpected ${url}`);
    });

    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A)],
    );
    expect(seenOffsets).toEqual([0, PAGE]); // followed the offset cursor
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: false, // the page-2 deregistration wins
      weight: 0n,
    });
  });

  it("covers a credential with no events at all (never registered)", async () => {
    stubFetch((url) =>
      url.includes("/account_update_history") ||
      url.includes("/account_stake_history")
        ? []
        : [],
    );
    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A)],
    );
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });
});

describe("KoiosTallyInputs.drepWeights", () => {
  it("registered iff a power row exists at the epoch (PostgREST filter form)", async () => {
    let calls = 0;
    stubFetch((url) => {
      expect(url).toContain("/drep_voting_power_history?_drep_id=drep1");
      expect(url).toContain("epoch_no=eq.1345");
      // Registered with power for the first credential, absent for the second.
      calls += 1;
      return calls === 1
        ? [{ drep_id: "drep1x", epoch_no: 1345, amount: "157298068" }]
        : [];
    });
    const weights = await new KoiosTallyInputs(CONFIG).drepWeights(1345, [
      cred(HASH_A),
      cred(HASH_B),
    ]);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 157_298_068n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });
});

describe("totals", () => {
  it("parses totals and maps upstream failures to null (retry)", async () => {
    stubFetch((url) => {
      if (url.includes("/epoch_info")) {
        return [{ active_stake: "269276116609905" }];
      }
      if (url.includes("/drep_epoch_summary")) {
        throw new Error("boom"); // simulated word128-style failure
      }
      return [];
    });
    const inputs = new KoiosTallyInputs(CONFIG);
    expect(await inputs.stakeholderTotal(500)).toBe(269_276_116_609_905n);
    expect(await inputs.drepTotal(500)).toBeNull();
  });
});
