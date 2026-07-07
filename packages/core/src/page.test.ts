import { describe, expect, it } from "vitest";
import type { Credential, SurveyDefinition } from "cip-179";

import {
  bytesToHex,
  type ChainTip,
  type GovLink,
  type SurveyRecord,
} from "cip-179/domain";
import {
  encodeSurveyCursor,
  pageSurveyList,
  parseSurveyCursor,
  searchTermsOf,
} from "./page";
import type { SurveyListPayload } from "./source";

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
}

/** One survey per txId byte; slot varies so ordering is observable. */
function survey(id: number, slot: number, opts: Opts = {}): SurveyRecord {
  const definition: SurveyDefinition = {
    specVersion: 4,
    owner: owner(opts.ownerByte ?? 1),
    title: opts.title ?? `survey ${id}`,
    description: "",
    eligibleRoles: [],
    endEpoch: opts.endEpoch ?? 12,
    submissionMode: opts.sealed
      ? {
          type: "sealed",
          chainHash: new Uint8Array(32),
          round: 1,
          paddingSize: 64,
        }
      : { type: "public" },
    questions: [],
  };
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
    finalizedCancelled: [],
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
});

describe("pageSurveyList ordering and cursors", () => {
  // Buckets: s3 linked (0), s1/s2 open (1), s0 ended (2); slots break ties.
  const s0 = survey(0, 400, { endEpoch: 8 });
  const s1 = survey(1, 300);
  const s2 = survey(2, 500);
  const s3 = survey(3, 100);
  const full = payload([s0, s1, s2, s3], [link(s3)]);

  it("orders gov-linked, then open by slot desc, then closed", () => {
    const page = pageSurveyList(full, { limit: 10 });
    expect(page.surveys.map(keyOf)).toEqual([
      keyOf(s3), // linked
      keyOf(s2), // open, newest
      keyOf(s1),
      keyOf(s0), // closed
    ]);
    expect(page.nextCursor).toBeNull();
    // The page slices ride along, restricted to page members.
    expect(page.govLinks).toEqual([link(s3)]);
    expect(Object.keys(page.responseCounts).sort()).toEqual(
      [s0, s1, s2, s3].map(keyOf).sort(),
    );
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
    expect(seen).toEqual([keyOf(s3), keyOf(s2), keyOf(s1), keyOf(s0)]);
  });

  it("counts are global (search-scoped), not page-scoped", () => {
    const page = pageSurveyList(full, { limit: 1 });
    expect(page.surveys).toHaveLength(1);
    expect(page.counts).toEqual({
      all: 4,
      linked: 1,
      active: 3,
      sealed: 0,
      public: 3,
      mine: 0,
    });
    expect(page.nextCursor).not.toBeNull();
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
});

describe("searchTermsOf", () => {
  it("lowercases, trims, splits on whitespace", () => {
    expect(searchTermsOf("  Foo   BAR ")).toEqual(["foo", "bar"]);
    expect(searchTermsOf(undefined)).toEqual([]);
    expect(searchTermsOf("   ")).toEqual([]);
  });
});
