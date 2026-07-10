import { describe, expect, it } from "vitest";
import { Role, type Credential, type SurveyResponse } from "../index.js";

import { responseCredentialProven, roleOfVoterTag } from "./proof.js";
import type { TxProof, VoteBinding } from "./records.js";

const keyCred = (b: number): Credential => ({
  type: "key",
  keyHash: Uint8Array.of(b),
});
const scriptCred = (b: number): Credential => ({
  type: "script",
  scriptHash: Uint8Array.of(b),
});
const hx = (b: number) => b.toString(16).padStart(2, "0");

const ACTION = "gov_action1linked";
const OTHER_ACTION = "gov_action1other";

function resp(role: Role, credential: Credential): SurveyResponse {
  return {
    specVersion: 5,
    surveyRef: { txId: Uint8Array.of(9), index: 0 },
    role,
    credential,
    answers: { type: "public", answers: [] },
  };
}

function proof(overrides: Partial<TxProof> = {}): TxProof {
  return { requiredSigners: [], nativeScripts: [], votes: [], ...overrides };
}

const vote = (
  voterTag: number,
  credByte: number,
  actionIds: string[] = [ACTION],
): VoteBinding => ({ voterTag, credentialHash: hx(credByte), actionIds });

describe("roleOfVoterTag", () => {
  it("maps Conway voter tags to CIP-179 roles", () => {
    expect(roleOfVoterTag(0)).toBe(Role.CC);
    expect(roleOfVoterTag(1)).toBe(Role.CC);
    expect(roleOfVoterTag(2)).toBe(Role.DRep);
    expect(roleOfVoterTag(3)).toBe(Role.DRep);
    expect(roleOfVoterTag(4)).toBe(Role.SPO);
    expect(roleOfVoterTag(9)).toBeNull();
  });
});

describe("mechanism A (standalone survey, or no binding)", () => {
  it("passes a key credential listed in required_signers", () => {
    const p = proof({ requiredSigners: [hx(1)] });
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), p, null),
    ).toBe(true);
  });

  it("fails a key credential absent from required_signers", () => {
    const p = proof({ requiredSigners: [hx(2)] });
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), p, null),
    ).toBe(false);
  });

  it("passes a native-script credential witnessed and satisfied", () => {
    const p = proof({
      requiredSigners: [hx(5)],
      nativeScripts: [
        { scriptHash: hx(7), script: { kind: "sig", keyHash: hx(5) } },
      ],
    });
    expect(
      responseCredentialProven(resp(Role.Stakeholder, scriptCred(7)), p, null),
    ).toBe(true);
  });

  it("fails a script credential whose script is unsatisfied or missing", () => {
    const unsatisfied = proof({
      requiredSigners: [hx(6)],
      nativeScripts: [
        { scriptHash: hx(7), script: { kind: "sig", keyHash: hx(5) } },
      ],
    });
    expect(
      responseCredentialProven(
        resp(Role.Stakeholder, scriptCred(7)),
        unsatisfied,
        null,
      ),
    ).toBe(false);
    expect(
      responseCredentialProven(
        resp(Role.Stakeholder, scriptCred(7)),
        proof(),
        null,
      ),
    ).toBe(false);
  });

  it("fails with no proof at all (unfetchable tx)", () => {
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), null, null),
    ).toBe(false);
  });
});

describe("mechanism B (governance-linked survey)", () => {
  it("a matching binding proves the credential on its own", () => {
    // DRep key voter voting the linked action; no required_signers at all.
    const p = proof({ votes: [vote(2, 1)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, ACTION),
    ).toBe(true);
  });

  it("covers script DRep (tag 3), CC (tags 0/1) and SPO (tag 4) voters", () => {
    expect(
      responseCredentialProven(
        resp(Role.DRep, scriptCred(1)),
        proof({ votes: [vote(3, 1)] }),
        ACTION,
      ),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.CC, keyCred(1)),
        proof({ votes: [vote(0, 1)] }),
        ACTION,
      ),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.CC, scriptCred(1)),
        proof({ votes: [vote(1, 1)] }),
        ACTION,
      ),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.SPO, keyCred(1)),
        proof({ votes: [vote(4, 1)] }),
        ACTION,
      ),
    ).toBe(true);
  });

  it("a present-but-failing binding invalidates even when mechanism A passes", () => {
    // Same credential signs the tx (A passes) but its vote is on another action.
    const wrongAction = proof({
      requiredSigners: [hx(1)],
      votes: [vote(2, 1, [OTHER_ACTION])],
    });
    expect(
      responseCredentialProven(
        resp(Role.DRep, keyCred(1)),
        wrongAction,
        ACTION,
      ),
    ).toBe(false);

    // Votes the linked action, but the voter tag's role ≠ the claimed role.
    const wrongRole = proof({
      requiredSigners: [hx(1)],
      votes: [vote(4, 1)], // SPO voter, response claims DRep
    });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), wrongRole, ACTION),
    ).toBe(false);
  });

  it("a Stakeholder with a binding is invalidated (no voter tag maps to 3)", () => {
    const p = proof({ requiredSigners: [hx(1)], votes: [vote(2, 1)] });
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), p, ACTION),
    ).toBe(false);
  });

  it("an absent binding falls back to mechanism A", () => {
    // The tx votes, but with a different credential — not a binding for ours.
    const p = proof({ requiredSigners: [hx(1)], votes: [vote(2, 9)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, ACTION),
    ).toBe(true);
  });

  it("credential kinds don't cross-match (script binding ≠ key credential)", () => {
    // Same hash byte, but the vote is a script-DRep while the response
    // credential is a key — not the same credential, so mechanism A decides.
    const p = proof({ votes: [vote(3, 1)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, ACTION),
    ).toBe(false);
  });

  it("bindings are ignored entirely on a standalone survey", () => {
    // A (would-be failing) vote binding exists, but the survey isn't linked:
    // mechanism A alone decides.
    const p = proof({
      requiredSigners: [hx(1)],
      votes: [vote(2, 1, [OTHER_ACTION])],
    });
    expect(responseCredentialProven(resp(Role.DRep, keyCred(1)), p, null)).toBe(
      true,
    );
  });

  it("any one of several bindings by the credential may satisfy", () => {
    const p = proof({
      votes: [vote(2, 1, [OTHER_ACTION]), vote(2, 1, [ACTION])],
    });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, ACTION),
    ).toBe(true);
  });
});
