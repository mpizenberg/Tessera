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

/** Must match tallyInputs' `PAGE_LIMIT`. */
const PAGE = 100;

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

/** A `/tx_info` row (with `_certs:true`) for a conflicting tx. */
const txInfoRow = (
  tx_hash: string,
  tx_block_index: number | null,
  certificates:
    | { type: string; index: number; info: { stake_address?: string } }[]
    | null,
) => ({ tx_hash, tx_block_index, certificates });
const regCert = (addr: string, index: number) => ({
  type: "stake_registration",
  index,
  info: { stake_address: addr },
});
const deregCert = (addr: string, index: number) => ({
  type: "stake_deregistration",
  index,
  info: { stake_address: addr },
});

type Handler = (
  url: string,
  body: {
    _stake_addresses?: string[];
    _tx_hashes?: string[];
    _certs?: boolean;
  } | null,
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
        // Newest first, as the query asks for: each account's first row is its
        // deciding one and everything below it is already overridden.
        return [
          // C: re-registered after a deregistration — registered, but no stake
          // row → weight 0.
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
          // B: registered then deregistered — out.
          {
            stake_address: addrB,
            action_type: "deregistration",
            absolute_slot: 30,
            epoch_no: 2,
          },
          // A: registered then delegated — registered, has stake.
          {
            stake_address: addrA,
            action_type: "delegation_pool",
            absolute_slot: 20,
            epoch_no: 1,
          },
          {
            stake_address: addrA,
            action_type: "registration",
            absolute_slot: 10,
            epoch_no: 1,
          },
          {
            stake_address: addrB,
            action_type: "registration",
            absolute_slot: 10,
            epoch_no: 1,
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

  it("decides a churny account from its newest slot, never reading its history (finding 13)", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    const seenOffsets: number[] = [];
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        // The query is filtered to the two state-changing event types.
        expect(url).toContain("action_type=in.(registration,deregistration)");
        seenOffsets.push(Number(new URL(url).searchParams.get("offset")));
        // A lifetime of churn, newest first and longer than one page. Only the
        // top row can decide; the rest must never be paid for.
        return [
          dereg(addrA, 10_000),
          ...Array.from({ length: PAGE - 1 }, (_, i) => reg(addrA, PAGE - i)),
        ];
      }
      throw new Error(`unexpected ${url}`);
    });

    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A)],
    );
    expect(seenOffsets).toEqual([0]); // stopped as soon as the account was passed
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: false, // the newest slot's deregistration decides
      weight: 0n,
    });
  });

  it("re-reads the addresses a full pass left unsettled, without the churny one (finding 13)", async () => {
    const [addrA, addrB] = await Promise.all([
      stakeAddress(cred(HASH_A), "preview"),
      stakeAddress(cred(HASH_B), "preview"),
    ]);
    const batches: string[][] = [];
    stubFetch((url, body) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        const asked = body?._stake_addresses ?? [];
        const offset = Number(new URL(url).searchParams.get("offset"));
        if (offset === 0) batches.push(asked);
        // A's history is deeper than the page cap, so a pass over both accounts
        // never reaches B's rows at all.
        return asked.includes(addrA)
          ? Array.from({ length: PAGE }, (_, i) =>
              reg(addrA, 1_000_000 - offset - i),
            )
          : [dereg(addrB, 100)];
      }
      throw new Error(`unexpected ${url}`);
    });

    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A), cred(HASH_B)],
    );
    // The second pass drops A — settled on page 1 — and asks only about B.
    expect(batches).toEqual([[addrA, addrB], [addrB]]);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 0n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("throws rather than trust a response that ignored the descending order", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        // Ascending: the early stop would read the *oldest* slot as deciding.
        return [reg(addrA, 100), dereg(addrA, 200)];
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      new KoiosTallyInputs(CONFIG).stakeholderWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(/descending slot order/);
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
          txInfoRow("tx1", 3, [deregCert(addrA, 0)]),
          txInfoRow("tx2", 5, [regCert(addrA, 0)]),
          txInfoRow("tx3", 5, [regCert(addrB, 0)]),
          txInfoRow("tx4", 8, [deregCert(addrB, 0)]),
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

  it("resolves two certs for one credential in ONE tx by cert_index — exact ledger order, no convention (finding 5)", async () => {
    const [addrA, addrB] = await Promise.all([
      stakeAddress(cred(HASH_A), "preview"),
      stakeAddress(cred(HASH_B), "preview"),
    ]);
    let txInfoCalls = 0;
    let certsRequested = false;
    stubFetch((url, body) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        return [
          // A: register then deregister in the SAME tx → dereg is cert 1 → OUT.
          reg(addrA, 100, "txA"),
          dereg(addrA, 100, "txA"),
          // B: deregister then re-register in the SAME tx → reg is cert 1 → IN.
          dereg(addrB, 100, "txB"),
          reg(addrB, 100, "txB"),
        ];
      }
      if (url.includes("/tx_info")) {
        txInfoCalls += 1;
        certsRequested = body?._certs === true;
        return [
          txInfoRow("txA", 0, [regCert(addrA, 0), deregCert(addrA, 1)]),
          txInfoRow("txB", 0, [deregCert(addrB, 0), regCert(addrB, 1)]),
        ];
      }
      throw new Error(`unexpected ${url}`);
    });
    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A), cred(HASH_B)],
    );
    // Same-tx conflict now needs the cert list — one tx_info read, `_certs` on.
    expect(txInfoCalls).toBe(1);
    expect(certsRequested).toBe(true);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: false, // dereg (cert 1) applied last
      weight: 0n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: true, // reg (cert 1) applied last
      weight: 0n,
    });
  });

  it("throws (retry) when a conflicting tx's cert data is unavailable — never guesses", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        return [dereg(addrA, 100, "tx1"), reg(addrA, 100, "tx2")];
      }
      if (url.includes("/tx_info")) {
        // tx2's data is unavailable → can't order the tie → must retry.
        return [
          txInfoRow("tx1", 3, [deregCert(addrA, 0)]),
          txInfoRow("tx2", null, null),
        ];
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      new KoiosTallyInputs(CONFIG).stakeholderWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(/tx_info unavailable/);
  });

  it("reads no tx_info when no account has a same-slot conflict (common case)", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    let txInfoCalls = 0;
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        // Distinct slots: the newest one (dereg@200) decides on its own.
        return [dereg(addrA, 200, "tx2"), reg(addrA, 100, "tx1")];
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

  it("orders both reads by a total key so offset pages are stable (finding 2)", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return []; // empty → one page each; we only inspect the request URLs
    });
    await new KoiosTallyInputs(CONFIG).stakeholderWeights(1345, [cred(HASH_A)]);

    const updateUrl = seen.find((u) => u.includes("/account_update_history"))!;
    const stakeUrl = seen.find((u) => u.includes("/account_stake_history"))!;
    // Newest first — the early stop reads the deciding slot off the top — and a
    // *unique* tiebreak, not just absolute_slot, otherwise PostgREST can shuffle
    // tied rows across a page boundary and drop/duplicate one, corrupting the
    // registration verdict that feeds the hashed artifact.
    expect(updateUrl).toContain(
      "order=absolute_slot.desc,stake_address.asc,tx_hash.asc,action_type.asc",
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
