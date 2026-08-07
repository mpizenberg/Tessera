/**
 * The preprod interoperability record (interop/preprod-fixtures.json) pins the
 * raw label-17 metadata of the on-chain fixture transactions next to the wire
 * form this backend serves for them. Replaying the exact decode path a refresh
 * runs — Koios JSON → Metadatum → payload items → JSON-safe wire form — makes
 * any codec change that would break the recorded contract fail here instead of
 * being discovered by a consumer diffing the live API.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePayloadItems } from "cip-179";
import { toJsonSafe } from "cip-179/tally";
import { koiosJsonToMetadatum, type KoiosJson } from "cardano-tessera-koios";

interface FixtureTx {
  readonly txHash: string;
  readonly kind: "definitions" | "responses";
  readonly label17: KoiosJson;
  readonly expected: readonly unknown[];
}

const record = JSON.parse(
  readFileSync(
    new URL("../../../interop/preprod-fixtures.json", import.meta.url),
    "utf8",
  ),
) as { network: string; transactions: FixtureTx[] };

describe("preprod interoperability fixtures", () => {
  it("records the preprod network", () => {
    expect(record.network).toBe("preprod");
  });

  for (const tx of record.transactions) {
    it(`decodes the ${tx.kind} tx ${tx.txHash.slice(0, 8)}… to the recorded wire form`, () => {
      const { payload, skipped } = decodePayloadItems(
        koiosJsonToMetadatum(tx.label17),
      );
      expect(skipped).toEqual([]);
      expect(payload.type).toBe(tx.kind);
      const items =
        payload.type === "definitions"
          ? payload.definitions
          : payload.type === "responses"
            ? payload.responses
            : payload.cancellations;
      // The on-chain array position is the record's identity (survey_index /
      // response_index), so it must match the recorded order exactly.
      expect(items.map((item) => item.index)).toEqual(
        tx.expected.map((_, i) => i),
      );
      expect(items.map((item) => toJsonSafe(item.value))).toEqual(tx.expected);
    });
  }
});
