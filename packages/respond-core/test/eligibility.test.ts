import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";

import {
  credentialForRole,
  respondableRolesFor,
  type Responder,
} from "../src/index.js";

const cred = (fill: number): Credential => ({
  type: "key",
  keyHash: new Uint8Array(28).fill(fill),
});

const defWith = (...roles: Role[]): SurveyDefinition =>
  ({ eligibleRoles: roles }) as SurveyDefinition;

describe("credentialForRole", () => {
  it("returns the credential the responder asserts for a role", () => {
    const payment = cred(1);
    expect(
      credentialForRole(Role.Keyholder, { [Role.Keyholder]: payment }),
    ).toBe(payment);
  });

  it("returns undefined for a role the responder has no credential for", () => {
    expect(credentialForRole(Role.SPO, {})).toBeUndefined();
    expect(
      credentialForRole(Role.Keyholder, { [Role.DRep]: cred(3) }),
    ).toBeUndefined();
  });
});

describe("respondableRolesFor", () => {
  it("is eligible ∩ roles the responder has a credential for", () => {
    const def = defWith(Role.SPO, Role.DRep, Role.Keyholder);
    const responder: Responder = {
      [Role.DRep]: cred(3),
      [Role.Keyholder]: cred(1),
      [Role.SPO]: cred(7),
    };
    expect(respondableRolesFor(def, responder)).toEqual([
      Role.SPO,
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("drops eligible roles with no credential (e.g. an SPO-only survey, wallet responder)", () => {
    const def = defWith(Role.SPO, Role.DRep, Role.Keyholder);
    expect(
      respondableRolesFor(def, {
        [Role.DRep]: cred(3),
        [Role.Keyholder]: cred(1),
      }),
    ).toEqual([Role.DRep, Role.Keyholder]);
  });

  it("is empty when no eligible role has a credential", () => {
    const def = defWith(Role.SPO, Role.CC);
    expect(respondableRolesFor(def, { [Role.Keyholder]: cred(1) })).toEqual([]);
  });

  it("preserves the definition's role order, not the responder's key order", () => {
    const def = defWith(Role.Keyholder, Role.SPO);
    expect(
      respondableRolesFor(def, {
        [Role.SPO]: cred(7),
        [Role.Keyholder]: cred(1),
      }),
    ).toEqual([Role.Keyholder, Role.SPO]);
  });
});
