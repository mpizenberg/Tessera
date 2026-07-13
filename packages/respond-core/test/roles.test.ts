import { describe, expect, it } from "vitest";

import { Role, type Credential, type SurveyDefinition } from "cip-179";
import { bytesToHex } from "cip-179/domain";

import {
  claimableRoles,
  respondableRoles,
  roleCredential,
  walletCredToCip179,
  type ResponderIdentity,
  type WalletCredential,
} from "../src/index.js";

const hex = (n: number, fill: number): string =>
  bytesToHex(new Uint8Array(n).fill(fill));

const keyCred = (fill: number): WalletCredential => ({
  kind: "key",
  hashHex: hex(28, fill),
});

const payment = keyCred(1);
const stake = keyCred(2);
const drep = keyCred(3);

const defWith = (...roles: Role[]): SurveyDefinition =>
  ({ eligibleRoles: roles }) as SurveyDefinition;

describe("claimableRoles", () => {
  it("payment-only identity claims Keyholder", () => {
    expect(claimableRoles({ payment })).toEqual([Role.Keyholder]);
  });

  it("adds Stakeholder / DRep when those credentials are present, Keyholder last", () => {
    expect(claimableRoles({ payment, stake, drep })).toEqual([
      Role.Stakeholder,
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("keys off drep presence (not a raw DRep key)", () => {
    expect(claimableRoles({ payment, drep })).toEqual([
      Role.DRep,
      Role.Keyholder,
    ]);
  });
});

describe("walletCredToCip179", () => {
  it("round-trips a key credential's hash", () => {
    const cred = walletCredToCip179(payment);
    expect(cred.type).toBe("key");
    expect(bytesToHex((cred as { keyHash: Uint8Array }).keyHash)).toBe(
      payment.hashHex,
    );
  });

  it("maps a script credential to scriptHash", () => {
    const cred = walletCredToCip179({ kind: "script", hashHex: hex(28, 9) });
    expect(cred.type).toBe("script");
    expect(bytesToHex((cred as { scriptHash: Uint8Array }).scriptHash)).toBe(
      hex(28, 9),
    );
  });
});

describe("roleCredential", () => {
  const full: ResponderIdentity = { payment, stake, drep };

  it("maps each wallet-derivable role to its credential", () => {
    expect(roleCredential(full, Role.Keyholder)).toEqual(
      walletCredToCip179(payment),
    );
    expect(roleCredential(full, Role.Stakeholder)).toEqual(
      walletCredToCip179(stake),
    );
    expect(roleCredential(full, Role.DRep)).toEqual(walletCredToCip179(drep));
  });

  it("returns undefined for a role the identity can't produce", () => {
    expect(roleCredential({ payment }, Role.Stakeholder)).toBeUndefined();
    expect(roleCredential({ payment }, Role.DRep)).toBeUndefined();
  });

  it("returns undefined for non-wallet-derivable roles (SPO/CC)", () => {
    expect(roleCredential(full, Role.SPO)).toBeUndefined();
    expect(roleCredential(full, Role.CC)).toBeUndefined();
  });
});

describe("respondableRoles", () => {
  it("intersects eligible roles with what the identity can produce", () => {
    const def = defWith(Role.SPO, Role.DRep, Role.Keyholder);
    expect(respondableRoles(def, { payment, drep })).toEqual([
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("is empty when the identity can't claim any eligible role", () => {
    const def = defWith(Role.SPO, Role.CC);
    expect(respondableRoles(def, { payment, stake, drep })).toEqual([]);
  });
});
