/**
 * Role presentation for the widget: the chip colors, and which key proves a
 * role. Labels, descriptions and browser-claimability are `respond-core`'s —
 * the app states them the same way, so they have one definition.
 *
 * Role colors are the `--tessera-role-*` tokens (defaults in theme.css), so
 * hosts can re-skin the chips via CSS or the `theme` prop.
 */

import { Role } from "cip-179";
import { roleDescriptionKey, type I18n } from "cardano-tessera-respond-core";

import type { ProofKeyKind } from "./types";

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

/** Which key must sign to prove a role's credential (for `required_signers`). */
const ROLE_KEY_KIND: Record<number, ProofKeyKind> = {
  [Role.DRep]: "drep",
  [Role.SPO]: "pool",
  [Role.CC]: "cc",
  [Role.Stakeholder]: "stake",
  [Role.Keyholder]: "payment",
};

export function roleColors(role: number): readonly [string, string] {
  return (
    ROLE_COLORS[role] ?? ["var(--tessera-muted)", "var(--tessera-surface3)"]
  );
}

export function roleDescription(i18n: I18n, role: number): string {
  const key = roleDescriptionKey(role);
  return key ? i18n.t(key) : "";
}

export function keyKindForRole(role: Role): ProofKeyKind {
  return ROLE_KEY_KIND[role] ?? "payment";
}
