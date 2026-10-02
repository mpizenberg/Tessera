import { describe, expect, test } from "vitest";

import {
  Role,
  SPEC_VERSION,
  decodePayload,
  encodePayload,
  type Metadatum,
  type SurveyDefinition,
} from "cip-179";

import {
  fromDetailedJson,
  toDetailedJson,
  type DetailedJsonProblemCode,
} from "./detailedJson";

const MAX = 2n ** 64n - 1n;

const read = (text: string) => {
  const r = fromDetailedJson(text);
  if ("problem" in r) throw new Error(JSON.stringify(r.problem));
  return r.metadata;
};

const problem = (text: string) => {
  const r = fromDetailedJson(text);
  if ("metadata" in r) throw new Error("read without a problem");
  return r.problem;
};

const at17 = (value: string) => `{"17": ${value}}`;

describe("toDetailedJson / fromDetailedJson", () => {
  test("a metadatum survives the round trip through text, map order included", () => {
    const value: Metadatum = new Map<Metadatum, Metadatum>([
      [3n, [MAX, -MAX, 0n]],
      [1n, "é".repeat(32)],
      [2n, new Uint8Array(64).fill(0xab)],
      ["text key", new Map()],
      [new Uint8Array([1]), []],
    ]);
    const metadata = new Map([[17n, value]]);
    const back = read(toDetailedJson(metadata));
    expect(back).toEqual(metadata);
    expect([...(back.get(17n) as Map<Metadatum, Metadatum>).keys()]).toEqual([
      ...value.keys(),
    ]);
  });

  test("integers are written as exact JSON numbers", () => {
    const text = toDetailedJson(new Map([[17n, [MAX, -MAX, 7n]]]));
    expect(text).toContain('"int": 18446744073709551615');
    expect(text).toContain('"int": -18446744073709551615');
    expect(text).toContain('"int": 7');
  });

  test("reads the schema as cardano-cli writes it", () => {
    const text = `{
      "17": {"list": [
        {"int": 0},
        {"map": [{"k": {"int": 1}, "v": {"bytes": "DEADbeef"}}]},
        {"string": "hi"}
      ]}
    }`;
    expect(read(text)).toEqual(
      new Map([
        [
          17n,
          [0n, new Map([[1n, new Uint8Array([0xde, 0xad, 0xbe, 0xef])]]), "hi"],
        ],
      ]),
    );
  });

  test("a survey definition payload round-trips", () => {
    const definition: SurveyDefinition = {
      specVersion: SPEC_VERSION,
      owner: { type: "key", keyHash: new Uint8Array(28).fill(7) },
      title: "Treasury priorities",
      description: "x".repeat(150),
      eligibleRoles: [Role.DRep, Role.Stakeholder],
      endEpoch: 600,
      submissionMode: { type: "public" },
      questions: [
        {
          type: "numericRange",
          prompt: "How much?",
          required: true,
          constraints: { min: -MAX, max: MAX, step: 3n },
        },
      ],
    };
    const payload = encodePayload({
      type: "definitions",
      definitions: [definition],
    });
    const back = read(toDetailedJson(new Map([[17n, payload]]))).get(17n)!;
    expect(decodePayload(back)).toEqual({
      type: "definitions",
      definitions: [definition],
    });
  });

  test.each<[string, string, DetailedJsonProblemCode, string?]>([
    ["not JSON", "{", "detailedJson.notJson"],
    ["a list at the top", "[]", "detailedJson.notObject"],
    ["a number at the top", "5", "detailedJson.notObject"],
    ["a word label", `{"x": {"int": 1}}`, "detailedJson.badLabel", "x"],
    [
      "a zero-padded label",
      `{"017": {"int": 1}}`,
      "detailedJson.badLabel",
      "017",
    ],
    [
      "a label past 2^64-1",
      `{"18446744073709551616": {"int": 1}}`,
      "detailedJson.badLabel",
      "18446744073709551616",
    ],
    [
      "two tags",
      at17(`{"int": 1, "string": "a"}`),
      "detailedJson.badValue",
      "17",
    ],
    ["an unknown tag", at17(`{"float": 1}`), "detailedJson.badValue", "17"],
    ["a bare value", at17(`1`), "detailedJson.badValue", "17"],
    [
      "a string as int",
      at17(`{"int": "1"}`),
      "detailedJson.notInteger",
      "17.int",
    ],
    ["a fraction", at17(`{"int": 1.5}`), "detailedJson.notInteger", "17.int"],
    ["an exponent", at17(`{"int": 1e3}`), "detailedJson.notInteger", "17.int"],
    [
      "2^64",
      at17(`{"int": 18446744073709551616}`),
      "detailedJson.intOutOfRange",
      "17.int",
    ],
    [
      "-2^64, which the ledger takes and cardano-cli does not",
      at17(`{"int": -18446744073709551616}`),
      "detailedJson.intOutOfRange",
      "17.int",
    ],
    [
      "odd-length hex",
      at17(`{"bytes": "abc"}`),
      "detailedJson.badHex",
      "17.bytes",
    ],
    [
      "non-hex bytes",
      at17(`{"bytes": "zz"}`),
      "detailedJson.badHex",
      "17.bytes",
    ],
    [
      "0x-prefixed bytes",
      at17(`{"bytes": "0xab"}`),
      "detailedJson.badHex",
      "17.bytes",
    ],
    [
      "65 bytes of text",
      at17(`{"string": "${"a".repeat(65)}"}`),
      "detailedJson.tooLong",
      "17.string",
    ],
    [
      "65 bytes",
      at17(`{"bytes": "${"ab".repeat(65)}"}`),
      "detailedJson.tooLong",
      "17.bytes",
    ],
    [
      "a map entry without v",
      at17(`{"map": [{"k": {"int": 1}}]}`),
      "detailedJson.badMapEntry",
      "17.map[0]",
    ],
    [
      "a repeated int key",
      at17(
        `{"map": [{"k": {"int": 1}, "v": {"int": 1}}, {"k": {"int": 1}, "v": {"int": 2}}]}`,
      ),
      "detailedJson.duplicateKey",
      "17.map[1]",
    ],
    [
      "a repeated bytes key, spelled in another case",
      at17(
        `{"map": [{"k": {"bytes": "AB"}, "v": {"int": 1}}, {"k": {"bytes": "ab"}, "v": {"int": 2}}]}`,
      ),
      "detailedJson.duplicateKey",
      "17.map[1]",
    ],
    [
      "a problem deep inside",
      at17(
        `{"list": [{"map": [{"k": {"int": 0}, "v": {"list": [{"int": 0.5}]}}]}]}`,
      ),
      "detailedJson.notInteger",
      "17.list[0].map[0].v.list[0].int",
    ],
  ])("rejects %s", (_name, text, code, where) => {
    expect(problem(text)).toEqual(
      where === undefined ? { code } : { code, params: { where } },
    );
  });
});
