import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "cip-179";

import { hexToBytes } from "cip-179/domain";
import type { AppConfig } from "@tessera/core";

import { evolutionCodec } from "cip-179/evolution";
import { KoiosTallyInputs } from "./tallyInputs";

const stakeAddress = evolutionCodec.stakeAddress;

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

/** An `account_update_history` row of the given action at `slot` in `tx`. */
const update = (
  stake_address: string,
  action_type: string,
  slot: number,
  tx_hash = "tx0",
) => ({
  stake_address,
  action_type,
  absolute_slot: slot,
  epoch_no: 1,
  tx_hash,
});
const reg = (addr: string, slot: number, tx = "tx0") =>
  update(addr, "registration", slot, tx);
const dereg = (addr: string, slot: number, tx = "tx0") =>
  update(addr, "deregistration", slot, tx);

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

  it("resolves a same-slot tie across DIFFERENT txs by tx_block_index — chain order, not convention (finding 5)", async () => {
    const [addrA, addrB] = await Promise.all([
      stakeAddress(cred(HASH_A), "preview"),
      stakeAddress(cred(HASH_B), "preview"),
    ]);
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        return [
          // A: dereg (block 3) then reg (block 5) in the SAME slot → the reg is
          // applied last → REGISTERED. A slot-only "deregistration-last" rule
          // would wrongly say deregistered; tx_block_index is the truth.
          dereg(addrA, 100, "tx1"),
          reg(addrA, 100, "tx2"),
          // B: reg (block 5) then dereg (block 8), same slot → DEREGISTERED.
          reg(addrB, 100, "tx3"),
          dereg(addrB, 100, "tx4"),
        ];
      }
      if (url.includes("/tx_info")) {
        return [
          { tx_hash: "tx1", tx_block_index: 3 },
          { tx_hash: "tx2", tx_block_index: 5 },
          { tx_hash: "tx3", tx_block_index: 5 },
          { tx_hash: "tx4", tx_block_index: 8 },
        ];
      }
      throw new Error(`unexpected ${url}`);
    });

    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A), cred(HASH_B)],
    );
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 0n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("falls back to the deregistration-last convention only for two certs in ONE tx (documented limitation)", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    let txInfoCalls = 0;
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        // register + deregister in the SAME tx — cert order unobservable.
        return [reg(addrA, 100, "txX"), dereg(addrA, 100, "txX")];
      }
      if (url.includes("/tx_info")) {
        txInfoCalls += 1;
        return [];
      }
      throw new Error(`unexpected ${url}`);
    });
    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A)],
    );
    // One tx → nothing to order → no tx_info read; convention → deregistered.
    expect(txInfoCalls).toBe(0);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("throws (retry) when a cross-tx same-slot tie has no tx_block_index — never guesses", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        return [dereg(addrA, 100, "tx1"), reg(addrA, 100, "tx2")];
      }
      if (url.includes("/tx_info")) {
        return [{ tx_hash: "tx1", tx_block_index: 3 }]; // tx2's index missing
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      new KoiosTallyInputs(CONFIG).stakeholderWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(/tx_block_index unavailable/);
  });

  it("reads no tx_info when no account has a same-slot tie (common case)", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    let txInfoCalls = 0;
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        // Distinct slots: the later one (dereg@200) decides, no ordering needed.
        return [reg(addrA, 100, "tx1"), dereg(addrA, 200, "tx2")];
      }
      if (url.includes("/tx_info")) {
        txInfoCalls += 1;
        return [];
      }
      throw new Error(`unexpected ${url}`);
    });
    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A)],
    );
    expect(txInfoCalls).toBe(0);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("orders both paginated reads by a total key so offset pages are stable (finding 2)", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return []; // empty → one page each; we only inspect the request URLs
    });
    await new KoiosTallyInputs(CONFIG).stakeholderWeights(1345, [cred(HASH_A)]);

    const updateUrl = seen.find((u) => u.includes("/account_update_history"))!;
    const stakeUrl = seen.find((u) => u.includes("/account_stake_history"))!;
    // A *unique* tiebreak, not just absolute_slot — otherwise PostgREST can
    // shuffle tied rows across a page boundary and drop/duplicate one, corrupting
    // the registration walk that feeds the hashed artifact.
    expect(updateUrl).toContain(
      "order=absolute_slot.asc,stake_address.asc,tx_hash.asc,action_type.asc",
    );
    expect(stakeUrl).toContain("order=stake_address.asc");
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
