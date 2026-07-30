import { describe, expect, it } from "vitest";

import { Role, type SurveyDefinition } from "cip-179";
import { bytesToHex } from "cip-179/domain";

import {
  claimableRoles,
  ownerCredential,
  respondableRoles,
  roleCredential,
  walletCredToCip179,
  walletResponder,
} from "./roles";
import type { WalletCredential, WalletIdentity } from "~/wallet/types";

const hex = (n: number, fill: number): string =>
  bytesToHex(new Uint8Array(n).fill(fill));

const keyCred = (fill: number): WalletCredential => ({
  kind: "key",
  hashHex: hex(28, fill),
});

const scriptCred = (fill: number): WalletCredential => ({
  kind: "script",
  hashHex: hex(28, fill),
});

const payment = keyCred(1);
const stake = keyCred(2);
const drep = keyCred(3);
const scriptPayment = scriptCred(7);
const scriptStake = scriptCred(8);

/** A {@link WalletIdentity} carrying the given credentials (rest is filler). */
const identity = (creds: {
  payment?: WalletCredential;
  stake?: WalletCredential;
  drep?: WalletCredential;
}): WalletIdentity => ({
  walletKey: "demo",
  walletName: "Demo",
  networkId: 0,
  changeAddressBech32: "addr_test1demo",
  payment: creds.payment ?? payment,
  stake: creds.stake,
  drepKeyHex: creds.drep ? hex(32, 3) : undefined,
  drep: creds.drep,
});

const defWith = (...roles: Role[]): SurveyDefinition =>
  ({ eligibleRoles: roles }) as unknown as SurveyDefinition;

describe("claimableRoles", () => {
  it("payment-only wallet claims Keyholder", () => {
    expect(claimableRoles(identity({}))).toEqual([Role.Keyholder]);
  });

  it("adds Stakeholder / DRep when present, Keyholder last", () => {
    expect(claimableRoles(identity({ stake, drep }))).toEqual([
      Role.Stakeholder,
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("keys off the DRep credential's presence", () => {
    expect(claimableRoles(identity({ drep }))).toEqual([
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("drops the roles a script credential backs", () => {
    expect(
      claimableRoles(identity({ payment: scriptPayment, stake, drep })),
    ).toEqual([Role.Stakeholder, Role.DRep]);
    expect(
      claimableRoles(identity({ payment: scriptPayment, stake: scriptStake })),
    ).toEqual([]);
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
  const full = identity({ stake, drep });

  it("maps each wallet-derivable role to its credential", () => {
    expect(roleCredential(full, Role.Keyholder)).toEqual(
      walletCredToCip179(payment),
    );
    expect(roleCredential(full, Role.Stakeholder)).toEqual(
      walletCredToCip179(stake),
    );
    expect(roleCredential(full, Role.DRep)).toEqual(walletCredToCip179(drep));
  });

  it("returns undefined for a role the wallet can't produce", () => {
    expect(roleCredential(identity({}), Role.Stakeholder)).toBeUndefined();
    expect(roleCredential(identity({}), Role.DRep)).toBeUndefined();
  });

  it("returns undefined for non-wallet-derivable roles (SPO/CC)", () => {
    expect(roleCredential(full, Role.SPO)).toBeUndefined();
    expect(roleCredential(full, Role.CC)).toBeUndefined();
  });

  it("returns undefined for a script credential (unprovable in-browser)", () => {
    const scripted = identity({
      payment: scriptPayment,
      stake: scriptStake,
      drep,
    });
    expect(roleCredential(scripted, Role.Keyholder)).toBeUndefined();
    expect(roleCredential(scripted, Role.Stakeholder)).toBeUndefined();
    expect(roleCredential(scripted, Role.DRep)).toEqual(
      walletCredToCip179(drep),
    );
  });
});

describe("ownerCredential", () => {
  it("is the payment credential", () => {
    expect(ownerCredential(identity({ stake, drep }))).toEqual(
      walletCredToCip179(payment),
    );
  });

  it("is undefined for a script payment credential", () => {
    expect(
      ownerCredential(identity({ payment: scriptPayment, stake, drep })),
    ).toBeUndefined();
  });
});

describe("respondableRoles", () => {
  it("intersects eligible roles with what the wallet can produce", () => {
    const def = defWith(Role.SPO, Role.DRep, Role.Keyholder);
    expect(respondableRoles(def, identity({ drep }))).toEqual([
      Role.DRep,
      Role.Keyholder,
    ]);
  });

  it("is empty when the wallet can't claim any eligible role", () => {
    const def = defWith(Role.SPO, Role.CC);
    expect(respondableRoles(def, identity({ stake, drep }))).toEqual([]);
  });

  it("excludes an eligible role a script credential would have to prove", () => {
    const def = defWith(Role.Stakeholder, Role.Keyholder);
    expect(
      respondableRoles(def, identity({ payment: scriptPayment, stake })),
    ).toEqual([Role.Stakeholder]);
  });
});

describe("walletResponder", () => {
  it("maps every claimable role to its credential", () => {
    expect(walletResponder(identity({ stake, drep }))).toEqual({
      [Role.Keyholder]: walletCredToCip179(payment),
      [Role.Stakeholder]: walletCredToCip179(stake),
      [Role.DRep]: walletCredToCip179(drep),
    });
  });

  it("omits roles the wallet can't derive (no SPO/CC entry)", () => {
    const map = walletResponder(identity({}));
    expect(map[Role.Keyholder]).toEqual(walletCredToCip179(payment));
    expect(map[Role.Stakeholder]).toBeUndefined();
    expect(map[Role.SPO]).toBeUndefined();
  });

  it("omits script-backed roles", () => {
    expect(walletResponder(identity({ payment: scriptPayment, drep }))).toEqual(
      { [Role.DRep]: walletCredToCip179(drep) },
    );
  });
});
