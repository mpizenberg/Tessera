import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import { bytesToHex } from "cip-179/domain";

import {
  credentialForRole,
  respondableRolesFor,
  walletCredToCip179,
  type ResponderIdentity,
  type WalletCredential,
} from "../src/index.js";

const keyCred = (fill: number): WalletCredential => ({
  kind: "key",
  hashHex: bytesToHex(new Uint8Array(28).fill(fill)),
});

const identity: ResponderIdentity = {
  payment: keyCred(1),
  drep: keyCred(3),
};

const spoCred: Credential = {
  type: "key",
  keyHash: new Uint8Array(28).fill(7),
};

const defWith = (...roles: Role[]): SurveyDefinition =>
  ({ eligibleRoles: roles }) as SurveyDefinition;

describe("credentialForRole", () => {
  it("derives a wallet role from the identity", () => {
    expect(credentialForRole(Role.Keyholder, { identity })).toEqual(
      walletCredToCip179(identity.payment),
    );
  });

  it("uses a host-trusted credential for SPO/CC", () => {
    expect(
      credentialForRole(Role.SPO, { hostCredentials: { [Role.SPO]: spoCred } }),
    ).toBe(spoCred);
  });

  it("tolerates an absent identity (host-only responder)", () => {
    expect(
      credentialForRole(Role.SPO, { hostCredentials: { [Role.SPO]: spoCred } }),
    ).toBe(spoCred);
    expect(credentialForRole(Role.Keyholder, {})).toBeUndefined();
  });

  it("prefers the wallet-derived credential over a host one for the same role", () => {
    const result = credentialForRole(Role.Keyholder, {
      identity,
      hostCredentials: { [Role.Keyholder]: spoCred },
    });
    expect(result).toEqual(walletCredToCip179(identity.payment));
    expect(result).not.toBe(spoCred);
  });

  it("returns undefined when neither wallet nor host can satisfy the role", () => {
    expect(credentialForRole(Role.SPO, { identity })).toBeUndefined();
  });
});

describe("respondableRolesFor", () => {
  it("is eligible ∩ (wallet-derivable ∪ host-provided)", () => {
    const def = defWith(Role.SPO, Role.DRep, Role.Keyholder);
    expect(
      respondableRolesFor(def, {
        identity,
        hostCredentials: { [Role.SPO]: spoCred },
      }),
    ).toEqual([Role.SPO, Role.DRep, Role.Keyholder]);
  });

  it("drops host-only roles when no host credential is supplied", () => {
    const def = defWith(Role.SPO, Role.DRep, Role.Keyholder);
    expect(respondableRolesFor(def, { identity })).toEqual([
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("works with only host credentials (no identity)", () => {
    const def = defWith(Role.SPO, Role.DRep);
    expect(
      respondableRolesFor(def, {
        hostCredentials: { [Role.SPO]: spoCred },
      }),
    ).toEqual([Role.SPO]);
  });
});
