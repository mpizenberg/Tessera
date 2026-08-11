import { describe, expect, it } from "vitest";

import { responsesCsv, type CsvEntry } from "./export";

const base: CsvEntry = {
  disposition: "counted",
  role: 3,
  credential: "key:aa",
  weight: 1n,
  weightUnit: "count",
  txHash: "t1",
  responseIndex: 0,
  answers: null,
  sealed: false,
};

/** Split the RFC 4180 (CRLF-delimited) output back into cells. */
const rows = (csv: string): string[][] =>
  csv
    .trim()
    .split("\r\n")
    .map((line) => line.split(","));

describe("responsesCsv", () => {
  it("expands one counted responder into one row per answer", () => {
    const csv = responsesCsv([
      {
        ...base,
        answers: [
          { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
          { type: "numeric", questionIndex: 1, value: 42n },
        ],
      },
    ]);
    const [header, ...body] = rows(csv);
    expect(header).toEqual([
      "disposition",
      "role",
      "credential",
      "weight",
      "weight_unit",
      "response_tx",
      "response_index",
      "question_index",
      "question_type",
      "answer",
    ]);
    expect(body).toEqual([
      [
        "counted",
        "Stakeholder",
        "key:aa",
        "1",
        "count",
        "t1",
        "0",
        "0",
        "singleChoice",
        "1",
      ],
      [
        "counted",
        "Stakeholder",
        "key:aa",
        "1",
        "count",
        "t1",
        "0",
        "1",
        "numeric",
        "42",
      ],
    ]);
  });

  it("an unreadable sealed payload still gets its envelope row", () => {
    const [, row] = rows(responsesCsv([{ ...base, sealed: true }]));
    expect(row!.slice(7)).toEqual(["", "sealed", ""]);
  });

  it("an excluded response records why, with no weight and no content", () => {
    const [, row] = rows(
      responsesCsv([
        {
          ...base,
          disposition: "superseded",
          weight: null,
          weightUnit: "",
          answers: null,
        },
      ]),
    );
    expect(row![0]).toBe("superseded");
    expect(row!.slice(3, 5)).toEqual(["", ""]);
    expect(row!.slice(7)).toEqual(["", "", ""]);
  });

  it("every view yields the same columns, so two exports are comparable", () => {
    const live = responsesCsv([base]);
    const chainWeighted = responsesCsv([
      {
        ...base,
        weight: 45_000_000_000n,
        weightUnit: "active_stake_at_end_epoch",
      },
    ]);
    expect(rows(live)[0]).toEqual(rows(chainWeighted)[0]);
    expect(rows(live)[1]!.length).toBe(rows(chainWeighted)[1]!.length);
  });
});
