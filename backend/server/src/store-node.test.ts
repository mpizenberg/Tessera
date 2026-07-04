/**
 * `store-node.ts` against a real (in-memory) SQLite database — exercised where
 * the SQL itself carries logic the in-memory store re-implements in JS, so the
 * two can't silently disagree. Today that's the `json_extract` predicate behind
 * `finalizedCancelledKeys` (D1 shares the same SQLite JSON1 dialect).
 */

import { afterEach, describe, expect, it } from "vitest";

import type { BackendStore } from "./store";
import { openBackendStore } from "./store-node";

const artifact = (surveyKey: string, tally: string, hash: string) => ({
  surveyKey,
  endEpoch: 500,
  artifactHash: hash,
  artifact: `{"tally":${tally},"provenance":{}}`,
  createdAt: 1,
});

describe("store-node finalizedCancelledKeys (json_extract)", () => {
  let store: BackendStore;
  afterEach(() => store.close());

  it("selects only artifacts whose tally.cancelled is set", async () => {
    store = openBackendStore(":memory:");
    await store.putArtifact(
      artifact("aa:0", `{"perRole":[{"role":3}]}`, "a1".repeat(32)),
    );
    await store.putArtifact(
      artifact(
        "bb:1",
        `{"cancelled":{"txHash":"cc","slot":1,"epoch":499},"perRole":[]}`,
        "b2".repeat(32),
      ),
    );
    // JSON null must read as not-cancelled, same as an absent key (the
    // json_extract → SQL NULL note in the query).
    await store.putArtifact(
      artifact("cc:2", `{"cancelled":null,"perRole":[]}`, "c3".repeat(32)),
    );

    expect(await store.finalizedCancelledKeys()).toEqual(new Set(["bb:1"]));
    expect(await store.finalizedSurveyKeys()).toEqual(
      new Set(["aa:0", "bb:1", "cc:2"]),
    );
  });

  it("is empty with no artifacts", async () => {
    store = openBackendStore(":memory:");
    expect(await store.finalizedCancelledKeys()).toEqual(new Set());
  });
});
