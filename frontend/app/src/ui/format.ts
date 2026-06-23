/** Small presentation helpers shared across screens. */

import { Role } from "cip-179";
import type { Network } from "~/config";
import type { SurveyAggregate } from "~/domain/survey";

/**
 * Link to a transaction on the Cardano Explorer aggregator. Mainnet lives at
 * the root (`/tx/<id>`); other networks are namespaced (`/preview/tx/<id>`).
 */
export function explorerTxUrl(network: Network, txHash: string): string {
  const prefix = network === "mainnet" ? "" : `${network}/`;
  return `https://explorer.cardano.org/${prefix}tx/${txHash}`;
}

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

/** One-line explanation of what each role is and how it's claimed. */
const ROLE_DESCRIPTION: Record<number, string> = {
  [Role.DRep]:
    "A registered delegate representative — claimed in-browser via your wallet's CIP-95 DRep key.",
  [Role.SPO]:
    "A stake pool operator — proven with cold/hot pool keys a browser wallet can't hold.",
  [Role.CC]:
    "A Constitutional Committee member — proven with committee keys a browser wallet can't hold.",
  [Role.Stakeholder]:
    "Any ada holder with a stake key — claimed in-browser by your connected wallet.",
  [Role.Owner]:
    "The survey's creator — claimable only by the wallet that published it.",
};

export function roleLabel(role: number): string {
  return ROLE_LABEL[role] ?? `Role ${role}`;
}

export function roleDescription(role: number): string {
  return ROLE_DESCRIPTION[role] ?? "";
}

/**
 * Whether a browser wallet can ever prove this role. SPO and CC need cold/hot
 * keys that live outside browser wallets, so they're never claimable here.
 */
export function roleBrowserClaimable(role: number): boolean {
  return role !== Role.SPO && role !== Role.CC;
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
