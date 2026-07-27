/**
 * The small subset of the app's `ui/format.ts` role presentation the widget
 * needs, re-implemented from the injected catalog + tokens.
 *
 * Role labels stay hard-coded proper nouns (DRep/SPO/CC/…), matching the app.
 * Role descriptions come from the `roles` catalog namespace. Role colors are
 * the `--tessera-role-*` tokens (defaults in theme.css), so hosts can re-skin
 * the chips via CSS or the `theme` prop.
 */

import { Role } from "cip-179";
import type { I18n, MsgKey } from "@tessera/respond-core";

import type { ProofKeyKind } from "./types";

const ROLE_LABEL: Record<number, string> = {
  [Role.DRep]: "DRep",
  [Role.SPO]: "SPO",
  [Role.CC]: "CC",
  [Role.Stakeholder]: "Stakeholder",
  [Role.Keyholder]: "Keyholder",
};

/** [text color, background] per role — the `--tessera-role-*` theme tokens. */
const ROLE_COLORS: Record<number, readonly [string, string]> = {
  [Role.DRep]: ["var(--tessera-role-drep)", "var(--tessera-role-drep-bg)"],
  [Role.SPO]: ["var(--tessera-role-spo)", "var(--tessera-role-spo-bg)"],
  [Role.CC]: ["var(--tessera-role-cc)", "var(--tessera-role-cc-bg)"],
  [Role.Stakeholder]: [
    "var(--tessera-role-stakeholder)",
    "var(--tessera-role-stakeholder-bg)",
  ],
  [Role.Keyholder]: [
    "var(--tessera-role-keyholder)",
    "var(--tessera-role-keyholder-bg)",
  ],
};

/** `roles` catalog key for each role's one-line explanation. */
const ROLE_DESCRIPTION_KEY = {
  [Role.DRep]: "roles.drep",
  [Role.SPO]: "roles.spo",
  [Role.CC]: "roles.cc",
  [Role.Stakeholder]: "roles.stakeholder",
  [Role.Keyholder]: "roles.keyholder",
} as const satisfies Record<number, MsgKey>;

/** Which key must sign to prove a role's credential (for `required_signers`). */
const ROLE_KEY_KIND: Record<number, ProofKeyKind> = {
  [Role.DRep]: "drep",
  [Role.SPO]: "pool",
  [Role.CC]: "cc",
  [Role.Stakeholder]: "stake",
  [Role.Keyholder]: "payment",
};

export function roleLabel(role: number): string {
  return ROLE_LABEL[role] ?? `Role ${role}`;
}

export function roleColors(role: number): readonly [string, string] {
  return (
    ROLE_COLORS[role] ?? ["var(--tessera-muted)", "var(--tessera-surface3)"]
  );
}

export function roleDescription(i18n: I18n, role: number): string {
  const key = ROLE_DESCRIPTION_KEY[role as keyof typeof ROLE_DESCRIPTION_KEY];
  return key ? i18n.t(key) : "";
}

/**
 * Whether a browser wallet can ever prove this role. SPO and CC need cold/hot
 * keys that live outside browser wallets, so they're never claimable here.
 */
export function roleBrowserClaimable(role: number): boolean {
  return role !== Role.SPO && role !== Role.CC;
}

export function keyKindForRole(role: Role): ProofKeyKind {
  return ROLE_KEY_KIND[role] ?? "payment";
}
