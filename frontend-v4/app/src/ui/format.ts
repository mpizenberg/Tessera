/** Small presentation helpers shared across screens. */

import { Role } from "cip-179";
import type { SurveyAggregate } from "~/domain/survey";

const ROLE_LABEL: Record<number, string> = {
  [Role.DRep]: "DRep",
  [Role.SPO]: "SPO",
  [Role.CC]: "CC",
  [Role.Stakeholder]: "Stakeholder",
  [Role.Owner]: "Owner",
};

const ROLE_ABBR: Record<number, string> = {
  [Role.DRep]: "DRep",
  [Role.SPO]: "SPO",
  [Role.CC]: "CC",
  [Role.Stakeholder]: "Stake",
  [Role.Owner]: "Owner",
};

/** [text color, background] per role, mirroring the mockup palette. */
const ROLE_COLORS: Record<number, readonly [string, string]> = {
  [Role.DRep]: ["var(--accent)", "var(--accent-bg)"],
  [Role.SPO]: ["#2E6B5E", "#E4EFEB"],
  [Role.CC]: ["#6B4FA0", "#ECE7F4"],
  [Role.Stakeholder]: ["#4F7A3A", "#E8F1E0"],
  [Role.Owner]: ["#9A6B1E", "#F6EDD9"],
};

export function roleLabel(role: number): string {
  return ROLE_LABEL[role] ?? `Role ${role}`;
}

export function roleAbbr(role: number): string {
  return ROLE_ABBR[role] ?? `R${role}`;
}

export function roleColors(role: number): readonly [string, string] {
  return ROLE_COLORS[role] ?? ["var(--muted)", "var(--surface3)"];
}

/**
 * Presentation status: the mockup conflates lifecycle with visibility into one
 * of four register states. `public`/`sealed` are both "open"; `ended`/
 * `cancelled` are closed.
 */
export type ViewStatus = "public" | "sealed" | "ended" | "cancelled";

export function viewStatus(a: SurveyAggregate): ViewStatus {
  if (a.cancelled) return "cancelled";
  if (a.status === "ended") return "ended";
  return a.sealed ? "sealed" : "public";
}

export function isClosed(v: ViewStatus): boolean {
  return v === "ended" || v === "cancelled";
}

/** A short, human-friendly survey ref: "abcd…1234#0". */
export function shortRef(key: string): string {
  const [hash, index] = key.split(":");
  const h = hash ?? "";
  const short = h.length > 12 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h;
  return `${short}#${index ?? "0"}`;
}
