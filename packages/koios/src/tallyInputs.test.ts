import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "cip-179";

import { credentialKey, hexToBytes } from "cip-179/domain";
import type { AppConfig } from "cardano-tessera-core";

import { evolutionCodec } from "cip-179/evolution";
import { stringifyKoiosJson } from "./json";
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

/** A `/drep_updates` row, as the registration read projects it. */
const drepUpdate = (drep_id: string, block_time: number, action: string) => ({
  drep_id,
  block_time,
  action,
});

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

/**
 * What the readiness check reads: the end time of the survey's end epoch
 * (`null`: Koios serves none), Koios's tip epoch, and the epochs its stake
 * cache serves. By default the end is long past and Koios far beyond it.
 */
interface Readiness {
  readonly endTime?: number | null;
  readonly tipEpoch?: number;
  readonly snapshots?: readonly { epoch_no: number; active_stake: string }[];
}

/**
 * Answers the readiness check's reads itself, so `handler` sees only the
 * reads under test.
 */
function stubFetch(handler: Handler, readiness: Readiness = {}) {
  const {
    endTime = 1_700_000_000,
    tipEpoch = 1_000_000,
    snapshots = [],
  } = readiness;
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as never) : null;
    const answer = url.includes("select=end_time")
      ? endTime === null
        ? []
        : [{ end_time: endTime }]
      : url.includes("/tip?")
        ? [{ epoch_no: tipEpoch }]
        : url.includes("/pool_list?")
          ? [{ pool_id_bech32: "pool1test" }]
          : url.includes("/pool_stake_snapshot?")
            ? snapshots
            : handler(url, body);
    return new Response(stringifyKoiosJson(answer), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("KoiosTallyInputs.stakeholderWeights", () => {
  it("joins registration at the end of the epoch with the mark taken then", async () => {
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
        // The mark, taken at the end of 1345.
        expect(url).toContain("epoch_no=eq.1347");
        return [
          {
            stake_address: addrA,
            epoch_no: 1347,
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
    // Registered-but-empty counts with weight 0.
    expect(weights.get(`key:${HASH_C}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("reads active stake served as a string or as a number, exactly", async () => {
    const [addrA, addrB] = await Promise.all([
      stakeAddress(cred(HASH_A), "preview"),
      stakeAddress(cred(HASH_B), "preview"),
    ]);
    stubFetch((url) => {
      if (url.includes("/account_update_history")) {
        return [reg(addrA, 10), reg(addrB, 10)];
      }
      return [
        {
          stake_address: addrA,
          epoch_no: 1,
          active_stake: "21391325252789667",
        },
        { stake_address: addrB, epoch_no: 1, active_stake: 21391325252789667n },
      ];
    });
    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(1, [
      cred(HASH_A),
      cred(HASH_B),
    ]);
    for (const hash of [HASH_A, HASH_B]) {
      expect(weights.get(`key:${hash}`)).toEqual({
        registered: true,
        weight: 21_391_325_252_789_667n,
      });
    }
  });

  it("throws rather than weigh from an amount that is not an integer", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    stubFetch((url) =>
      url.includes("/account_update_history")
        ? [reg(addrA, 10)]
        : [{ stake_address: addrA, epoch_no: 1, active_stake: 1.5 }],
    );
    await expect(
      new KoiosTallyInputs(CONFIG).stakeholderWeights(1, [cred(HASH_A)]),
    ).rejects.toThrow("account_stake_history.active_stake");
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

  it("re-asks about the addresses a page left unsettled, without the churny one (finding 13)", async () => {
    const [addrA, addrB] = await Promise.all([
      stakeAddress(cred(HASH_A), "preview"),
      stakeAddress(cred(HASH_B), "preview"),
    ]);
    const asks: { batch: string[]; offset: number }[] = [];
    stubFetch((url, body) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        const batch = body?._stake_addresses ?? [];
        const offset = Number(new URL(url).searchParams.get("offset"));
        asks.push({ batch, offset });
        // A's history is deeper than one page, so a page covering both accounts
        // never reaches B's rows at all.
        return batch.includes(addrA)
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
    // A settles on the first page, so the next ask narrows to B and restarts at
    // offset 0 — A's remaining history is never paged through.
    expect(asks).toEqual([
      { batch: [addrA, addrB], offset: 0 },
      { batch: [addrB], offset: 0 },
    ]);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 0n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("pages deeper only when a page settles nothing — a deciding slot longer than one page", async () => {
    const addrA = await stakeAddress(cred(HASH_A), "preview");
    const seenOffsets: number[] = [];
    stubFetch((url) => {
      if (url.includes("/account_stake_history")) return [];
      if (url.includes("/account_update_history")) {
        const offset = Number(new URL(url).searchParams.get("offset"));
        seenOffsets.push(offset);
        // One block's certificate list, wider than a page: nothing can settle
        // until the read passes the end of slot 500.
        return offset === 0
          ? Array.from({ length: PAGE }, () => reg(addrA, 500))
          : [reg(addrA, 500), dereg(addrA, 400)];
      }
      throw new Error(`unexpected ${url}`);
    });

    const weights = await new KoiosTallyInputs(CONFIG).stakeholderWeights(
      1345,
      [cred(HASH_A)],
    );
    expect(seenOffsets).toEqual([0, PAGE]);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true, // slot 500 is all registrations; the 400 dereg is stale
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
  it("weighs from the power row, and asks nothing more when every id has one", async () => {
    const idA = evolutionCodec.drepId(cred(HASH_A));
    const idB = evolutionCodec.drepId(cred(HASH_B));
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return [
        { drep_id: idA, epoch_no: 1346, amount: "157298068" },
        { drep_id: idB, epoch_no: 1346, amount: "0" },
      ];
    });
    const weights = await new KoiosTallyInputs(CONFIG).drepWeights(1345, [
      cred(HASH_A),
      cred(HASH_B),
    ]);
    expect(seen).toHaveLength(1);
    // The distribution taken at the end of 1345, labelled 1346. Both epoch
    // filters (the endpoint's own bounds the query, the PostgREST column
    // filter is the reliable one), and every id of the batch in one `in.(…)`
    // list.
    expect(seen[0]).toContain(
      `/drep_voting_power_history?_epoch_no=1346&epoch_no=eq.1346&drep_id=in.(${idA},${idB})`,
    );
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 157_298_068n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("reads voting power served as a string or as a number, exactly", async () => {
    const idA = evolutionCodec.drepId(cred(HASH_A));
    const idB = evolutionCodec.drepId(cred(HASH_B));
    stubFetch(() => [
      { drep_id: idA, epoch_no: 1, amount: "15213065217906634" },
      { drep_id: idB, epoch_no: 1, amount: 15213065217906634n },
    ]);
    const weights = await new KoiosTallyInputs(CONFIG).drepWeights(1, [
      cred(HASH_A),
      cred(HASH_B),
    ]);
    for (const hash of [HASH_A, HASH_B]) {
      expect(weights.get(`key:${hash}`)).toEqual({
        registered: true,
        weight: 15_213_065_217_906_634n,
      });
    }
    stubFetch(() => [{ drep_id: idA, epoch_no: 1, amount: "12abc" }]);
    await expect(
      new KoiosTallyInputs(CONFIG).drepWeights(1, [cred(HASH_A)]),
    ).rejects.toThrow("drep_voting_power_history.amount");
  });

  it("reads registration for the ids the power endpoint omits, and only those", async () => {
    const idA = evolutionCodec.drepId(cred(HASH_A));
    const idB = evolutionCodec.drepId(cred(HASH_B));
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/drep_voting_power_history")) {
        return [{ drep_id: idA, epoch_no: 1346, amount: "157298068" }];
      }
      // Registered, and nobody delegated to it — a member at weight 0.
      return [drepUpdate(idB, 1_699_000_000, "registered")];
    });
    const weights = await new KoiosTallyInputs(CONFIG).drepWeights(1345, [
      cred(HASH_A),
      cred(HASH_B),
    ]);
    const updates = seen.find((u) => u.includes("/drep_updates"))!;
    expect(updates).toContain(`drep_id=in.(${idB})`);
    expect(updates).toContain("block_time=lte.1700000000");
    expect(updates).toContain("action=in.(registered,deregistered)");
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 157_298_068n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("excludes a DRep deregistered by the boundary, or with no event before it", async () => {
    const idA = evolutionCodec.drepId(cred(HASH_A));
    const idB = evolutionCodec.drepId(cred(HASH_B));
    stubFetch((url) => {
      // B retired during the end epoch: the distribution taken at its end
      // holds no row for it, though the one taken at its start did.
      if (url.includes("/drep_voting_power_history")) return [];
      // Newest first, as the query asks for.
      return [
        // A: re-registered after a deregistration — a member.
        drepUpdate(idA, 1_699_000_500, "registered"),
        drepUpdate(idA, 1_699_000_400, "deregistered"),
        // B: deregistered last — not a member. C: never registered at all.
        drepUpdate(idB, 1_699_000_300, "deregistered"),
        drepUpdate(idB, 1_699_000_200, "registered"),
      ];
    });
    const weights = await new KoiosTallyInputs(CONFIG).drepWeights(1345, [
      cred(HASH_A),
      cred(HASH_B),
      cred(HASH_C),
    ]);
    expect(weights.get(`key:${HASH_A}`)).toEqual({
      registered: true,
      weight: 0n,
    });
    expect(weights.get(`key:${HASH_B}`)).toEqual({
      registered: false,
      weight: 0n,
    });
    expect(weights.get(`key:${HASH_C}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("postpones rather than guess a registration and deregistration in one block", async () => {
    const idA = evolutionCodec.drepId(cred(HASH_A));
    stubFetch((url) => {
      if (url.includes("/drep_voting_power_history")) return [];
      return [
        drepUpdate(idA, 1_699_000_500, "registered"),
        drepUpdate(idA, 1_699_000_500, "deregistered"),
      ];
    });
    await expect(
      new KoiosTallyInputs(CONFIG).drepWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(/no within-block order/);
  });

  it("postpones when the epoch's end time is unavailable", async () => {
    stubFetch(() => [], { endTime: null });
    await expect(
      new KoiosTallyInputs(CONFIG).drepWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(/no end_time/);
  });

  it("chunks past the batch size and merges the pages", async () => {
    const creds = Array.from({ length: 120 }, (_, i) =>
      cred(i.toString(16).padStart(2, "0").repeat(28)),
    );
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      const ids = /drep_id=in\.\(([^)]*)\)/.exec(url)![1]!.split(",");
      return ids.map((id) => ({ drep_id: id, epoch_no: 1346, amount: "7" }));
    });
    const weights = await new KoiosTallyInputs(CONFIG).drepWeights(1345, creds);
    expect(seen).toHaveLength(3);
    expect(weights.size).toBe(120);
    for (const c of creds)
      expect(weights.get(credentialKey(c))).toEqual({
        registered: true,
        weight: 7n,
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

  it("reads totals served as numbers, zero included, exactly", async () => {
    stubFetch((url) =>
      url.includes("/epoch_info")
        ? [{ active_stake: 21391325252789667n }]
        : [{ amount: 0 }],
    );
    const inputs = new KoiosTallyInputs(CONFIG);
    expect(await inputs.stakeholderTotal(654)).toBe(21_391_325_252_789_667n);
    expect(await inputs.drepTotal(654)).toBe(0n);
  });

  it("maps a total that is not an integer to null (retry)", async () => {
    stubFetch((url) =>
      url.includes("/epoch_info") ? [{ active_stake: 1.5 }] : [{ amount: "x" }],
    );
    const inputs = new KoiosTallyInputs(CONFIG);
    expect(await inputs.stakeholderTotal(654)).toBeNull();
    expect(await inputs.drepTotal(654)).toBeNull();
  });
});

describe("reading the end of end_epoch", () => {
  const drepRows = (url: string) => {
    const ids = /drep_id=in\.\(([^)]*)\)/.exec(url)?.[1]?.split(",") ?? [];
    return ids.map((id) => ({ drep_id: id, epoch_no: 1346, amount: "7" }));
  };

  it("waits the margin past the next epoch's start, before asking anything more", async () => {
    const seen: string[] = [];
    const mock = stubFetch(
      (url) => {
        seen.push(url);
        return [];
      },
      { endTime: Math.floor(Date.now() / 1000) - 3600 },
    );
    const inputs = new KoiosTallyInputs(CONFIG);
    await expect(inputs.drepWeights(1345, [cred(HASH_A)])).rejects.toThrow(
      /the end of epoch 1345 is read from/,
    );
    await expect(
      inputs.stakeholderWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(/the end of epoch 1345 is read from/);
    expect(await inputs.stakeholderTotal(1345)).toBeNull();
    expect(await inputs.drepTotal(1345)).toBeNull();
    expect(seen).toEqual([]);
    expect(
      mock.mock.calls.every(([u]) => String(u).includes("select=end_time")),
    ).toBe(true);
  });

  it("waits for Koios's stake cache to hold the mark while the tip is in the next epoch", async () => {
    stubFetch(drepRows, {
      tipEpoch: 1346,
      snapshots: [
        { epoch_no: 1345, active_stake: "1" },
        { epoch_no: 1346, active_stake: "2" },
      ],
    });
    await expect(
      new KoiosTallyInputs(CONFIG).drepWeights(1345, [cred(HASH_A)]),
    ).rejects.toThrow(
      /not finished writing the stake snapshot taken at the end of epoch 1345/,
    );
  });

  it("reads once the cache holds the mark, asking any active pool", async () => {
    const mock = stubFetch(drepRows, {
      tipEpoch: 1346,
      snapshots: [
        { epoch_no: 1345, active_stake: "1" },
        { epoch_no: 1346, active_stake: "2" },
        { epoch_no: 1347, active_stake: "3" },
      ],
    });
    const inputs = new KoiosTallyInputs(CONFIG);
    expect(
      (await inputs.drepWeights(1345, [cred(HASH_A)])).get(`key:${HASH_A}`),
    ).toEqual({ registered: true, weight: 7n });
    const urls = mock.mock.calls.map(([u]) => String(u));
    expect(urls.find((u) => u.includes("/pool_list?"))).toContain(
      "pool_status=eq.registered&active_stake=not.is.null&retiring_epoch=is.null",
    );
    expect(urls.find((u) => u.includes("/pool_stake_snapshot?"))).toContain(
      "_pool_bech32=pool1test",
    );
    // Passed once, the check is not repeated.
    const asked = urls.length;
    await inputs.drepWeights(1345, [cred(HASH_A)]);
    expect(mock.mock.calls.length - asked).toBe(1);
  });

  it("needs no pool once the tip is three epochs on", async () => {
    const mock = stubFetch(drepRows, { tipEpoch: 1348 });
    await new KoiosTallyInputs(CONFIG).drepWeights(1345, [cred(HASH_A)]);
    expect(
      mock.mock.calls.some(([u]) => String(u).includes("/pool_list?")),
    ).toBe(false);
  });
});

describe("totals at the end of end_epoch", () => {
  it("reads the mark's total and the next epoch's DRep distribution", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return url.includes("/epoch_info")
        ? [{ active_stake: "11" }]
        : [{ amount: "22" }];
    });
    const inputs = new KoiosTallyInputs(CONFIG);
    expect(await inputs.stakeholderTotal(1345)).toBe(11n);
    expect(await inputs.drepTotal(1345)).toBe(22n);
    expect(seen[0]).toContain("/epoch_info?_epoch_no=1347&");
    expect(seen[1]).toContain("/drep_epoch_summary?_epoch_no=1346&");
  });

  it("takes the mark's total from the stake cache before its epoch begins", async () => {
    stubFetch(() => [], {
      tipEpoch: 1346,
      snapshots: [{ epoch_no: 1347, active_stake: "33" }],
    });
    expect(await new KoiosTallyInputs(CONFIG).stakeholderTotal(1345)).toBe(33n);
  });
});
