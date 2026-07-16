import { describe, expect, it } from "vitest";
import { Role, type Credential, type SurveyResponse } from "../index.js";

import {
  responseCredentialProof,
  responseCredentialProven,
  roleOfVoterTag,
} from "./proof.js";
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
const LINKED = [ACTION];

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
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), p, []),
    ).toBe(true);
  });

  it("fails a key credential absent from required_signers", () => {
    const p = proof({ requiredSigners: [hx(2)] });
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), p, []),
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
      responseCredentialProven(resp(Role.Stakeholder, scriptCred(7)), p, []),
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
        [],
      ),
    ).toBe(false);
    expect(
      responseCredentialProven(
        resp(Role.Stakeholder, scriptCred(7)),
        proof(),
        [],
      ),
    ).toBe(false);
  });

  it("fails with no proof at all (unfetchable tx)", () => {
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), null, []),
    ).toBe(false);
  });
});

describe("mechanism B (governance-linked survey)", () => {
  it("a qualifying vote proves the credential on its own", () => {
    // DRep key voter voting the linked action; no required_signers at all.
    const p = proof({ votes: [vote(2, 1)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, LINKED),
    ).toBe(true);
  });

  it("covers script DRep (tag 3), CC (tags 0/1) and SPO (tag 4) voters", () => {
    expect(
      responseCredentialProven(
        resp(Role.DRep, scriptCred(1)),
        proof({ votes: [vote(3, 1)] }),
        LINKED,
      ),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.CC, keyCred(1)),
        proof({ votes: [vote(0, 1)] }),
        LINKED,
      ),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.CC, scriptCred(1)),
        proof({ votes: [vote(1, 1)] }),
        LINKED,
      ),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.SPO, keyCred(1)),
        proof({ votes: [vote(4, 1)] }),
        LINKED,
      ),
    ).toBe(true);
  });

  it("a non-qualifying vote never invalidates — mechanism A decides", () => {
    // Same credential signs the tx (A passes); its vote on another action is
    // not a binding, so it neither proves nor invalidates.
    const wrongAction = proof({
      requiredSigners: [hx(1)],
      votes: [vote(2, 1, [OTHER_ACTION])],
    });
    expect(
      responseCredentialProven(
        resp(Role.DRep, keyCred(1)),
        wrongAction,
        LINKED,
      ),
    ).toBe(true);

    // Votes the linked action, but the voter tag's role ≠ the claimed role:
    // not a binding for this response either — mechanism A still carries it.
    const wrongRole = proof({
      requiredSigners: [hx(1)],
      votes: [vote(4, 1)], // SPO voter, response claims DRep
    });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), wrongRole, LINKED),
    ).toBe(true);
  });

  it("a non-qualifying vote with no other proof leaves the response unproven", () => {
    // Wrong action, and nothing for mechanism A to evaluate.
    const wrongAction = proof({ votes: [vote(2, 1, [OTHER_ACTION])] });
    expect(
      responseCredentialProven(
        resp(Role.DRep, keyCred(1)),
        wrongAction,
        LINKED,
      ),
    ).toBe(false);

    // Right action, wrong role — still not a binding.
    const wrongRole = proof({ votes: [vote(4, 1)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), wrongRole, LINKED),
    ).toBe(false);
  });

  it("a Stakeholder can never bind (no voter tag maps to 3) — A decides", () => {
    const p = proof({ requiredSigners: [hx(1)], votes: [vote(2, 1)] });
    expect(
      responseCredentialProven(resp(Role.Stakeholder, keyCred(1)), p, LINKED),
    ).toBe(true);
    expect(
      responseCredentialProven(
        resp(Role.Stakeholder, keyCred(1)),
        proof({ votes: [vote(2, 1)] }),
        LINKED,
      ),
    ).toBe(false);
  });

  it("an absent binding falls back to mechanism A", () => {
    // The tx votes, but with a different credential — not a binding for ours.
    const p = proof({ requiredSigners: [hx(1)], votes: [vote(2, 9)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, LINKED),
    ).toBe(true);
  });

  it("credential kinds don't cross-match (script binding ≠ key credential)", () => {
    // Same hash byte, but the vote is a script-DRep while the response
    // credential is a key — not the same credential, so mechanism A decides.
    const p = proof({ votes: [vote(3, 1)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, LINKED),
    ).toBe(false);
  });

  it("votes prove nothing on a standalone survey", () => {
    // A qualifying-looking vote exists, but the survey isn't linked:
    // mechanism B doesn't exist, so mechanism A alone decides.
    const p = proof({ votes: [vote(2, 1)] });
    expect(responseCredentialProven(resp(Role.DRep, keyCred(1)), p, [])).toBe(
      false,
    );
    const signed = proof({ requiredSigners: [hx(1)], votes: [vote(2, 1)] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), signed, []),
    ).toBe(true);
  });

  it("any one of several linked actions may satisfy the binding", () => {
    // Two actions link the survey; the credential votes only on the second.
    const p = proof({ votes: [vote(2, 1, [ACTION])] });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, [
        OTHER_ACTION,
        ACTION,
      ]),
    ).toBe(true);
  });

  it("any one of several votes by the credential may satisfy", () => {
    const p = proof({
      votes: [vote(2, 1, [OTHER_ACTION]), vote(2, 1, [ACTION])],
    });
    expect(
      responseCredentialProven(resp(Role.DRep, keyCred(1)), p, LINKED),
    ).toBe(true);
  });
});

// --- Three-valued proof: "unknown" on an unresolvable link (finding 6) -------
//
// `responseCredentialProof` adds a third verdict for the case a resolved-link
// check can't decide: the response casts a qualifying vote on an EPOCH-ALIGNED
// action whose anchor couldn't be resolved, so if that anchor turns out to link
// the survey the verdict would flip to proven. Callers must not freeze that as
// a negative.

describe("responseCredentialProof (three-valued)", () => {
  const UNRESOLVED = [OTHER_ACTION]; // stands for an unresolved epoch-aligned action

  it("is proven via mechanism A regardless of unresolved anchors", () => {
    const p = proof({
      requiredSigners: [hx(1)],
      votes: [vote(2, 1, UNRESOLVED)],
    });
    expect(
      responseCredentialProof(resp(Role.DRep, keyCred(1)), p, [], UNRESOLVED),
    ).toBe("proven");
  });

  it("is proven via a vote on a RESOLVED link even if others are unresolved", () => {
    const p = proof({ votes: [vote(2, 1, [ACTION])] });
    expect(
      responseCredentialProof(
        resp(Role.DRep, keyCred(1)),
        p,
        LINKED,
        UNRESOLVED,
      ),
    ).toBe("proven");
  });

  it("is unknown when the sole possible proof votes an UNRESOLVED action", () => {
    // No signature (A fails), no resolved link — only a qualifying vote on the
    // action whose anchor we couldn't resolve. Could still prove → not final.
    const p = proof({ votes: [vote(2, 1, UNRESOLVED)] });
    expect(
      responseCredentialProof(resp(Role.DRep, keyCred(1)), p, [], UNRESOLVED),
    ).toBe("unknown");
  });

  it("is unproven (final) when the response never voted the unresolved action", () => {
    // The action is unresolved, but THIS response cast no qualifying vote on it,
    // so resolving it could never prove this response — the negative is final.
    // (Scoping the uncertainty to the actual voters avoids paralysis.)
    const p = proof({ votes: [vote(2, 1, [ACTION])] }); // votes a different action
    expect(
      responseCredentialProof(resp(Role.DRep, keyCred(1)), p, [], UNRESOLVED),
    ).toBe("unproven");
  });

  it("a wrong-role vote on the unresolved action is not a maybe-binding", () => {
    // SPO-tag vote, response claims DRep → not a qualifying vote, so even an
    // unresolved anchor can't flip it: final unproven, not unknown.
    const p = proof({ votes: [vote(4, 1, UNRESOLVED)] });
    expect(
      responseCredentialProof(resp(Role.DRep, keyCred(1)), p, [], UNRESOLVED),
    ).toBe("unproven");
  });

  it("with no unresolved actions it only ever returns proven/unproven", () => {
    const voteOnly = proof({ votes: [vote(2, 1, [ACTION])] });
    expect(
      responseCredentialProof(resp(Role.DRep, keyCred(1)), voteOnly, LINKED),
    ).toBe("proven");
    expect(
      responseCredentialProof(resp(Role.DRep, keyCred(1)), voteOnly, []),
    ).toBe("unproven");
  });

  it("no proof at all is unproven, never unknown", () => {
    expect(
      responseCredentialProof(
        resp(Role.DRep, keyCred(1)),
        null,
        [],
        UNRESOLVED,
      ),
    ).toBe("unproven");
  });
});
