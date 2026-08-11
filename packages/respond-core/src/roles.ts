/**
 * What a CIP-179 role is called, what explains it, and whether a browser can
 * ever claim it — the facts about roles that every host states the same way.
 *
 * Labels are proper nouns from the spec, not prose, so they are not in the
 * message catalog. Descriptions are: this exposes the catalog *key* rather than
 * the text, because a host looks it up through its own `t` (the app's reactive
 * global, or the widget's injected {@link I18n}).
 */

import { Role } from "cip-179";

import type { MsgKey } from "./messages/types.js";

const LABEL: Record<number, string> = {
  [Role.DRep]: "DRep",
  [Role.SPO]: "SPO",
  [Role.CC]: "CC",
  [Role.Stakeholder]: "Stakeholder",
  [Role.Keyholder]: "Keyholder",
};

const DESCRIPTION_KEY = {
  [Role.DRep]: "roles.drep",
  [Role.SPO]: "roles.spo",
  [Role.CC]: "roles.cc",
  [Role.Stakeholder]: "roles.stakeholder",
  [Role.Keyholder]: "roles.keyholder",
} as const satisfies Record<number, MsgKey>;

export function roleLabel(role: number): string {
  return LABEL[role] ?? `Role ${role}`;
}

/** Catalog key for a role's one-line explanation; undefined for an unknown role. */
export function roleDescriptionKey(role: number): MsgKey | undefined {
  return DESCRIPTION_KEY[role as keyof typeof DESCRIPTION_KEY];
}

/**
 * Whether a browser wallet can ever prove this role. SPO and CC need cold/hot
 * keys that live outside browser wallets, so they are never claimable there —
 * a host that vouches for one supplies the credential itself.
 */
export function roleBrowserClaimable(role: number): boolean {
  return role !== Role.SPO && role !== Role.CC;
}
