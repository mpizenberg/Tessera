import { describe, expect, it } from "vitest";
import type { Credential } from "cip-179";

import { bytesToHex } from "~/util/hex";
import type { CancellationProof, NativeScriptInfo } from "~/data/source";
import { cancellationVerified, nativeScriptSatisfied } from "./cancellation";

const keyHash = (b: number) => Uint8Array.of(b);
const keyOwner = (b: number): Credential => ({
  type: "key",
  keyHash: keyHash(b),
});
const scriptOwner = (b: number): Credential => ({
  type: "script",
  scriptHash: keyHash(b),
});
const hx = (b: number) => bytesToHex(keyHash(b));

const proof = (
  requiredSigners: string[],
  nativeScripts: CancellationProof["nativeScripts"] = [],
): CancellationProof => ({ requiredSigners, nativeScripts });

describe("cancellationVerified — key-based owner", () => {
  it("verifies when the owner key hash is a required signer", () => {
    expect(cancellationVerified(keyOwner(1), proof([hx(1)]))).toBe(true);
    expect(cancellationVerified(keyOwner(1), proof([hx(9), hx(1)]))).toBe(true);
  });

  it("rejects when the owner key hash is absent (forgery / griefing)", () => {
    expect(cancellationVerified(keyOwner(1), proof([hx(2), hx(3)]))).toBe(
      false,
    );
    expect(cancellationVerified(keyOwner(1), proof([]))).toBe(false);
  });

  it("rejects when there is no proof at all", () => {
    expect(cancellationVerified(keyOwner(1), null)).toBe(false);
  });
});

describe("cancellationVerified — native-script owner", () => {
  const sig = (b: number): NativeScriptInfo => ({
    kind: "sig",
    keyHash: hx(b),
  });

  it("verifies a single-sig script satisfied by the required signers", () => {
    const p = proof([hx(5)], [{ scriptHash: hx(7), script: sig(5) }]);
    expect(cancellationVerified(scriptOwner(7), p)).toBe(true);
  });

  it("rejects when the script is present but its signer is missing", () => {
    const p = proof([hx(6)], [{ scriptHash: hx(7), script: sig(5) }]);
    expect(cancellationVerified(scriptOwner(7), p)).toBe(false);
  });

  it("rejects when no native script matches the owner hash (e.g. Plutus owner)", () => {
    const p = proof([hx(5)], [{ scriptHash: hx(8), script: sig(5) }]);
    expect(cancellationVerified(scriptOwner(7), p)).toBe(false);
  });
});

describe("nativeScriptSatisfied", () => {
  const sig = (b: number): NativeScriptInfo => ({
    kind: "sig",
    keyHash: hx(b),
  });
  const signers = (...bs: number[]) => new Set(bs.map(hx));

  it("all: every child must be satisfied", () => {
    const s: NativeScriptInfo = { kind: "all", scripts: [sig(1), sig(2)] };
    expect(nativeScriptSatisfied(s, signers(1, 2))).toBe(true);
    expect(nativeScriptSatisfied(s, signers(1))).toBe(false);
  });

  it("any: at least one child must be satisfied", () => {
    const s: NativeScriptInfo = { kind: "any", scripts: [sig(1), sig(2)] };
    expect(nativeScriptSatisfied(s, signers(2))).toBe(true);
    expect(nativeScriptSatisfied(s, signers(3))).toBe(false);
  });

  it("atLeast: at least N children must be satisfied", () => {
    const s: NativeScriptInfo = {
      kind: "atLeast",
      required: 2,
      scripts: [sig(1), sig(2), sig(3)],
    };
    expect(nativeScriptSatisfied(s, signers(1, 3))).toBe(true);
    expect(nativeScriptSatisfied(s, signers(1))).toBe(false);
  });

  it("timelock clauses don't constrain signer satisfaction", () => {
    // all [ sig(1), timelock ] is satisfied by signer 1 alone.
    const s: NativeScriptInfo = {
      kind: "all",
      scripts: [sig(1), { kind: "timelock" }],
    };
    expect(nativeScriptSatisfied(s, signers(1))).toBe(true);
  });

  it("handles nested composites", () => {
    // all [ sig(1), any [ sig(2), sig(3) ] ]
    const s: NativeScriptInfo = {
      kind: "all",
      scripts: [sig(1), { kind: "any", scripts: [sig(2), sig(3)] }],
    };
    expect(nativeScriptSatisfied(s, signers(1, 3))).toBe(true);
    expect(nativeScriptSatisfied(s, signers(1))).toBe(false);
    expect(nativeScriptSatisfied(s, signers(2, 3))).toBe(false); // missing sig(1)
  });
});
