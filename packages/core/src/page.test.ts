import { describe, expect, it } from "vitest";
import { Role, type Credential, type SurveyDefinition } from "cip-179";

import {
  bytesToHex,
  type ChainTip,
  type GovLink,
  type SurveyRecord,
} from "cip-179/domain";
import {
  MAX_SEARCH_TERMS,
  encodeResponseCursor,
  encodeSurveyCursor,
  pageSurveyList,
  parseResponseCursor,
  parseSurveyCursor,
  searchTermsOf,
  surveyListSlice,
} from "./page";
import type { SurveyListPayload } from "cardano-tessera-client";

const TIP: ChainTip = {
  epoch: 10,
  slot: 1050,
  epochSlot: 50,
  time: 1_000_000,
  govActionLifetime: 6,
};

const owner = (b: number): Credential => ({
  type: "key",
  keyHash: Uint8Array.of(b),
});
const ownerKey = (b: number) => `key:${bytesToHex(Uint8Array.of(b))}`;

interface Opts {
  endEpoch?: number;
  sealed?: boolean;
  ownerByte?: number;
  title?: string;
  /** No question: spec-invalid, so untalliable. */
  invalid?: boolean;
}

/** One survey per txId byte; slot varies so ordering is observable. */
function survey(id: number, slot: number, opts: Opts = {}): SurveyRecord {
  const definition: SurveyDefinition = {
    specVersion: 5,
    owner: owner(opts.ownerByte ?? 1),
    title: opts.title ?? `survey ${id}`,
    description: "",
    eligibleRoles: [Role.Stakeholder],
    endEpoch: opts.endEpoch ?? 12,
    submissionMode: opts.sealed
      ? {
          type: "sealed",
          chainHash: new Uint8Array(32),
          round: 1,
          paddingSize: 64,
        }
      : { type: "public" },
    questions: opts.invalid
      ? []
      : [
          {
            type: "singleChoice",
            prompt: "",
            options: { type: "options", labels: ["a", "b"] },
          },
        ],
  } as unknown as SurveyDefinition;
  return {
    txHash: bytesToHex(Uint8Array.of(id)),
    slot,
    epochNo: 9,
    ref: { txId: Uint8Array.of(id), index: 0 },
    definition,
  };
}

const keyOf = (s: SurveyRecord) => `${s.txHash}:0`;

function payload(
  surveys: SurveyRecord[],
  govLinks: GovLink[] = [],
): SurveyListPayload {
  return {
    surveys,
    cancellations: [],
    govLinks,
    tip: TIP,
    responseCounts: Object.fromEntries(surveys.map((s, i) => [keyOf(s), i])),
    finalState: {},
  };
}

const link = (s: SurveyRecord): GovLink => ({
  surveyKey: keyOf(s),
  actionId: "gov_action1xyz",
  endEpoch: s.definition.endEpoch,
  title: "linked action",
});

describe("cursor wire form", () => {
  it("round-trips and rejects malformed input", () => {
    const c = { bucket: 1, slot: 42, key: `${"ab".repeat(32)}:3` };
    expect(parseSurveyCursor(encodeSurveyCursor(c))).toEqual(c);
    expect(parseSurveyCursor("nope")).toBeNull();
    expect(parseSurveyCursor("3:1:aa:0")).toBeNull(); // bucket out of range
    expect(parseSurveyCursor("1:x:aa:0")).toBeNull();
  });

  it("round-trips the snapshot generation; generation-less stays valid", () => {
    const c = {
      bucket: 0,
      slot: 7,
      key: `${"cd".repeat(32)}:0`,
      generation: 1_785_000_000,
    };
    expect(parseSurveyCursor(encodeSurveyCursor(c))).toEqual(c);
    expect(parseSurveyCursor("1:42:aa:3")).toEqual({
      bucket: 1,
      slot: 42,
      key: "aa:3",
    });
  });
});

describe("pageSurveyList ordering and cursors", () => {
  // Buckets: s3 linked open and s4 linked ended (0, by slot alone), s1/s2
  // open (1), s0 ended and s5 invalid (2); slots break ties.
  const s0 = survey(0, 400, { endEpoch: 8 });
  const s1 = survey(1, 300);
  const s2 = survey(2, 500);
  const s3 = survey(3, 100);
  const s4 = survey(4, 150, { endEpoch: 8 });
  const s5 = survey(5, 600, { invalid: true });
  const full = payload([s0, s1, s2, s3, s4, s5], [link(s3), link(s4)]);
  const order = [s4, s3, s2, s1, s5, s0].map(keyOf);

  it("orders linked, then open, then closed", () => {
    const page = pageSurveyList(full, { limit: 10 });
    expect(page.surveys.map(keyOf)).toEqual(order);
    expect(page.nextCursor).toBeNull();
    // The page slices ride along, restricted to page members.
    expect(page.govLinks).toEqual([link(s3), link(s4)]);
    expect(Object.keys(page.responseCounts).sort()).toEqual([...order].sort());
  });

  it("walks the whole set page by page without gaps or repeats", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard++) {
      const page = pageSurveyList(full, { limit: 2, cursor });
      seen.push(...page.surveys.map(keyOf));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(order);
  });

  it("counts are global (search-scoped), not page-scoped", () => {
    const page = pageSurveyList(full, { limit: 1 });
    expect(page.surveys).toHaveLength(1);
    // The invalid survey is closed, whatever its end epoch.
    expect(page.counts).toEqual({
      all: 6,
      linked: 2,
      active: 3,
      sealed: 0,
      public: 3,
      mine: 0,
    });
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("surveyListSlice", () => {
  it("carries a survey off page one with its links and counts", () => {
    const s0 = survey(0, 400);
    const s1 = survey(1, 300);
    const full = payload([s0, s1], [link(s1)]);
    expect(pageSurveyList(full, { limit: 1 }).surveys).toEqual([s1]);
    expect(surveyListSlice(full, [s0])).toEqual({
      surveys: [s0],
      cancellations: [],
      govLinks: [],
      tip: TIP,
      responseCounts: { [keyOf(s0)]: 0 },
      finalState: {},
    });
  });
});

describe("pageSurveyList snapshot generations", () => {
  const s0 = survey(0, 400, { endEpoch: 8 });
  const s1 = survey(1, 300);
  const full: SurveyListPayload = { ...payload([s0, s1]), fetchedAt: 111 };

  it("echoes fetchedAt and mints it into nextCursor", () => {
    const page = pageSurveyList(full, { limit: 1 });
    expect(page.fetchedAt).toBe(111);
    expect(parseSurveyCursor(page.nextCursor!)?.generation).toBe(111);
    expect(page.resync).toBeUndefined();
  });

  it("flags resync on a cross-generation cursor but still answers", () => {
    const cursor = pageSurveyList(full, { limit: 1 }).nextCursor!;
    const stale = pageSurveyList(
      { ...full, fetchedAt: 222 },
      {
        limit: 1,
        cursor,
      },
    );
    expect(stale.resync).toBe(true);
    expect(stale.surveys).toHaveLength(1); // best-effort page, not an error
    // Same generation → no resync; so does a generation-less payload.
    expect(pageSurveyList(full, { limit: 1, cursor }).resync).toBeUndefined();
    expect(
      pageSurveyList(payload([s0, s1]), { limit: 1, cursor }).resync,
    ).toBeUndefined();
  });
});

describe("pageSurveyList filters and search", () => {
  const mineOpen = survey(1, 300, { ownerByte: 7, title: "budget poll" });
  const sealedOpen = survey(2, 400, { sealed: true, title: "sealed vote" });
  const ended = survey(3, 500, { endEpoch: 9, title: "old budget" });
  const full = payload([mineOpen, sealedOpen, ended]);

  it("applies the filter chips", () => {
    const by = (filter: Parameters<typeof pageSurveyList>[1]["filter"]) =>
      pageSurveyList(full, { limit: 10, filter }).surveys.map(keyOf);
    expect(by("active").sort()).toEqual(
      [keyOf(mineOpen), keyOf(sealedOpen)].sort(),
    );
    expect(by("sealed")).toEqual([keyOf(sealedOpen)]);
    expect(by("public")).toEqual([keyOf(mineOpen)]);
    expect(by("linked")).toEqual([]);
  });

  it("mine matches the caller's credentials against survey owners", () => {
    const page = pageSurveyList(full, {
      limit: 10,
      filter: "mine",
      credentials: [ownerKey(7)],
    });
    expect(page.surveys.map(keyOf)).toEqual([keyOf(mineOpen)]);
    expect(page.counts?.mine).toBe(1);
  });

  it("search ANDs terms over on-chain text and scopes the counts", () => {
    const page = pageSurveyList(full, { limit: 10, search: "budget" });
    expect(page.surveys.map(keyOf).sort()).toEqual(
      [keyOf(mineOpen), keyOf(ended)].sort(),
    );
    expect(page.counts?.all).toBe(2);
    expect(
      pageSurveyList(full, { limit: 10, search: "budget old" }).surveys.map(
        keyOf,
      ),
    ).toEqual([keyOf(ended)]);
  });

  it("a term of 8 characters or more matches the survey key too", () => {
    const hashed: SurveyRecord = {
      ...survey(4, 600),
      txHash: "ab".repeat(32),
      ref: { txId: new Uint8Array(32).fill(0xab), index: 0 },
    };
    const withKey = payload([mineOpen, hashed]);
    const keys = (search: string) =>
      pageSurveyList(withKey, { limit: 10, search }).surveys.map(keyOf);
    expect(keys("abababab")).toEqual([keyOf(hashed)]);
    expect(keys(`${"ab".repeat(32)}:0`)).toEqual([keyOf(hashed)]);
    expect(keys("abababa")).toEqual([]);
  });
});

describe("searchTermsOf", () => {
  it("lowercases, trims, splits on whitespace", () => {
    expect(searchTermsOf("  Foo   BAR ")).toEqual(["foo", "bar"]);
    expect(searchTermsOf(undefined)).toEqual([]);
    expect(searchTermsOf("   ")).toEqual([]);
  });

  it("caps the term count to bound D1 bound-params (finding 42)", () => {
    const many = Array.from({ length: 200 }, (_, i) => `t${i}`).join(" ");
    const terms = searchTermsOf(many);
    expect(terms).toHaveLength(MAX_SEARCH_TERMS);
    expect(terms[0]).toBe("t0"); // keeps the leading terms, drops the tail
  });
});

describe("response cursor", () => {
  it("round-trips, with and without a generation", () => {
    const c = { slot: 42, txHash: "ab".repeat(32), responseIndex: 3 };
    expect(parseResponseCursor(encodeResponseCursor(c))).toEqual(c);
    const stamped = { ...c, generation: 1_750_000_000 };
    expect(parseResponseCursor(encodeResponseCursor(stamped))).toEqual(stamped);
  });

  it("rejects anything that is not a full keyset position", () => {
    for (const s of [
      "",
      "junk",
      "42",
      `42:${"ab".repeat(32)}`,
      `42:nothex:0`,
      `42:${"ab".repeat(31)}:0`, // short hash
      `-1:${"ab".repeat(32)}:0`,
    ])
      expect(parseResponseCursor(s)).toBeNull();
  });
});
