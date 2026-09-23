import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accountAtEnd, drepAtEnd, parseDebug, poolStandsAt } from "./dump";

// Dumped from a preview store stopped at the first block of 1429, whose first
// slot is 123465600: the ledger at the end of 1428.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const DELEGATED = fixture("account-delegated");
const DEREGISTERED = fixture("account-deregistered");
const DREP = fixture("drep-reregistered");
const POOL = fixture("pool");
const START = 123465600;

describe("parseDebug", () => {
  it("reads every fixture whole", () => {
    for (const text of [DELEGATED, DEREGISTERED, DREP, POOL])
      expect(() => parseDebug(text)).not.toThrow();
  });

  it("reads structs, newtypes, tuples, lists, strings and options", () => {
    expect(
      parseDebug(
        'S {\n    a: Some(\n        (\n            1,\n            2,\n        ),\n    ),\n    b: None,\n    c: [\n        "x\\"y",\n    ],\n    d: Key(\n        true,\n    ),\n    e: Unit,\n}\n',
      ),
    ).toEqual({
      kind: "struct",
      name: "S",
      fields: {
        a: {
          kind: "tuple",
          name: "Some",
          items: [{ kind: "tuple", name: "", items: [1n, 2n] }],
        },
        b: null,
        c: ['x"y'],
        d: { kind: "tuple", name: "Key", items: [true] },
        e: { kind: "unit", name: "Unit" },
      },
    });
  });

  it("refuses what it cannot read", () => {
    expect(() => parseDebug("S { a: 1.5 }")).toThrow(/fractional/);
    expect(() => parseDebug("S { a: 1 } trailing")).toThrow(/trailing/);
  });
});

describe("accountAtEnd", () => {
  it("reads a delegated account's mark: its stake and pool at the end", () => {
    expect(accountAtEnd(DELEGATED, 1428, START)).toEqual({
      registered: true,
      stake: 8_073_247_350_332n,
      pool: "2afbef2f8a3a624f6f4492260fe2053f6daebd8c5ff13f6f14574417",
    });
  });

  it("reads an account deregistered during the epoch as not registered", () => {
    expect(accountAtEnd(DEREGISTERED, 1428, START)).toMatchObject({
      registered: false,
      pool: null,
    });
  });

  it("reads a registration after the end as not registered then", () => {
    const text = DELEGATED.replace("31176641", String(START + 14));
    expect(accountAtEnd(text, 1428, START).registered).toBe(false);
  });

  it("refuses a deregistration after the end", () => {
    const text = DEREGISTERED.replace("123412190", String(START + 14));
    expect(() => accountAtEnd(text, 1428, START)).toThrow(
      /registration at the epoch's end is not read/,
    );
  });

  it("reads no stake or pool for a snapshot the value keeps no version of", () => {
    expect(accountAtEnd(DELEGATED, 1420, START)).toEqual({
      registered: true,
      stake: 0n,
      pool: null,
    });
  });
});

describe("drepAtEnd", () => {
  it("reads a DRep re-registered after an unregistration as registered, with its power", () => {
    expect(drepAtEnd(DREP, 1428, START)).toEqual({
      registered: true,
      power: 75_086_827n,
    });
  });

  it("orders a registration and an unregistration in one slot by transaction", () => {
    const event = (slot: number, order: number) =>
      `Some(\n (\n ${slot},\n ${order},\n ),\n )`;
    const drep = (registered: string, unregistered: string) =>
      `DRepState {\n registered_at: ${registered},\n voting_power: 5,\n unregistered_at: ${unregistered},\n}\n`;
    expect(
      drepAtEnd(drep(event(100, 1), event(100, 0)), 1428, START).registered,
    ).toBe(true);
    expect(
      drepAtEnd(drep(event(100, 0), event(100, 1)), 1428, START).registered,
    ).toBe(false);
    expect(drepAtEnd(drep("None", "None"), 1428, START).registered).toBe(false);
  });

  it("reads a registration after the end as not registered then", () => {
    const text = DREP.replace("78218995", String(START + 14));
    expect(drepAtEnd(text, 1428, START).registered).toBe(false);
  });

  it("refuses an unregistration after the end, which zeroed the power counted", () => {
    const text = DREP.replace("78218899", String(START + 14));
    expect(() => drepAtEnd(text, 1428, START)).toThrow(
      /power at the epoch's end/,
    );
  });
});

describe("poolStandsAt", () => {
  it("reads the pool's standing in the snapshot taken at the end", () => {
    expect(poolStandsAt(POOL, 1428)).toBe(true);
    let n = 0;
    const retiredAtMark = POOL.replace(/is_retired: false/g, (m) =>
      ++n === 2 ? "is_retired: true" : m,
    );
    expect(poolStandsAt(retiredAtMark, 1428)).toBe(false);
    expect(poolStandsAt(retiredAtMark, 1429)).toBe(true);
  });
});
