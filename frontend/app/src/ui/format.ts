/** Small presentation helpers shared across screens. */

import { Role } from "cip-179";
import {
  voteDeadlineUnix,
  type ChainTip,
  type SurveyAggregate,
} from "cip-179/domain";
import { IPFS_GATEWAYS } from "cip-179/content";
import { roleDescriptionKey } from "cardano-tessera-respond-core";
import { expectedNetworkId, type Network } from "~/config";
import { t, n } from "~/i18n";

/** Role naming and browser-claimability are shared with the widget. */
export { roleLabel, roleBrowserClaimable } from "cardano-tessera-respond-core";

/**
 * Link to a transaction on the Cardano Explorer aggregator. Mainnet lives at
 * the root (`/tx/<id>`); other networks are namespaced (`/preview/tx/<id>`).
 */
export function explorerTxUrl(network: Network, txHash: string): string {
  const prefix = network === "mainnet" ? "" : `${network}/`;
  return `https://explorer.cardano.org/${prefix}tx/${txHash}`;
}

/**
 * Whether a connected wallet is on a different network than the app is
 * configured for. `undefined` (no wallet) is **not** a mismatch — gating on this
 * blocks a signature against the wrong network, but absence of a wallet is
 * handled by the connect prompt, not here. Shared by every submit gate (create,
 * respond, propose) and the header warning so they can't drift apart.
 */
export function networkMismatch(
  walletNetworkId: number | undefined,
  network: Network,
): boolean {
  return (
    walletNetworkId !== undefined &&
    walletNetworkId !== expectedNetworkId(network)
  );
}

/**
 * A browser-openable href for an **untrusted** content-anchor URI, or `null` if
 * the URI's scheme is not safe to navigate to. `ipfs://` is rewritten to the
 * first public gateway; `https://` is returned verbatim. NOT hash-verified —
 * this is only for "go look at the raw document" links, never trusted fetches.
 *
 * Returning `null` (rather than the raw string) is the security boundary: anchor
 * URIs come from on-chain data an attacker controls, so a `javascript:`, `data:`,
 * `file:`, or plain-`http:` URI must never reach an `<a href>`. Callers render
 * the link only when this returns non-null. Mirrors the scheme allow-list that
 * `cip-179/content` enforces on the fetch path.
 */
export function safeExternalHref(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    return IPFS_GATEWAYS[0] + uri.slice("ipfs://".length);
  }
  try {
    return new URL(uri).protocol === "https:" ? uri : null;
  } catch {
    // Not a parseable absolute URL (e.g. a bare "javascript:alert(1)" with no
    // authority still parses, but malformed input throws) — reject.
    return null;
  }
}

/**
 * Whether an untrusted anchor URI uses a scheme we are willing to link to or
 * record on-chain (`ipfs:` or `https:`). Single source of truth with
 * {@link safeExternalHref}. Use to gate submit actions that would otherwise
 * commit an attacker-navigable URI (e.g. a governance anchor) to the chain.
 */
export function isSafeAnchorUri(uri: string): boolean {
  return safeExternalHref(uri) !== null;
}

const ROLE_ABBR: Record<number, string> = {
  [Role.DRep]: "DRep",
  [Role.SPO]: "SPO",
  [Role.CC]: "CC",
  [Role.Stakeholder]: "Stake",
  [Role.Keyholder]: "Key",
};

/** [text color, background] per role, mirroring the mockup palette. */
const ROLE_COLORS: Record<number, readonly [string, string]> = {
  [Role.DRep]: ["var(--accent)", "var(--accent-bg)"],
  [Role.SPO]: ["#2E6B5E", "#E4EFEB"],
  [Role.CC]: ["#6B4FA0", "#ECE7F4"],
  [Role.Stakeholder]: ["#4F7A3A", "#E8F1E0"],
  [Role.Keyholder]: ["#9A6B1E", "#F6EDD9"],
};

export function roleDescription(role: number): string {
  const key = roleDescriptionKey(role);
  return key ? t(key) : "";
}

export function roleAbbr(role: number): string {
  return ROLE_ABBR[role] ?? `R${role}`;
}

export function roleColors(role: number): readonly [string, string] {
  return ROLE_COLORS[role] ?? ["var(--muted)", "var(--surface3)"];
}

/**
 * Presentation status: the mockup conflates lifecycle with visibility into one
 * of five register states. `public`/`sealed` are both "open"; `ended`/
 * `cancelled`/`invalid` are closed (never answerable). `invalid` = the on-chain
 * definition is spec-invalid, so the survey is untalliable (findings 10/11) — it
 * has highest precedence (a malformed survey is not a real one, regardless of
 * lifecycle or cancellation).
 */
export type ViewStatus =
  | "public"
  | "sealed"
  | "ended"
  | "cancelled"
  | "invalid";

export function viewStatus(a: SurveyAggregate): ViewStatus {
  if (!a.talliable) return "invalid";
  if (a.cancelled) return "cancelled";
  if (a.status === "ended") return "ended";
  return a.sealed ? "sealed" : "public";
}

export function isClosed(v: ViewStatus): boolean {
  return v === "ended" || v === "cancelled" || v === "invalid";
}

/** A short, human-friendly survey ref: "abcd…1234#0". */
export function shortRef(key: string): string {
  const [hash, index] = key.split(":");
  const h = hash ?? "";
  const short = h.length > 12 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h;
  return `${short}#${index ?? "0"}`;
}

/**
 * The complete survey ref id, "<txHash>#<index>" — the full transaction hash so
 * savvy (pro-mode) users can look the survey's defining transaction up on a
 * chain explorer. The ref key is internally "<txHash>:<index>".
 */
export function fullRef(key: string): string {
  const [hash, index] = key.split(":");
  return `${hash ?? ""}#${index ?? "0"}`;
}

/** A bare hex hash, elided in the middle: "abcdef…1234". */
export function shortHash(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

/** Coarse "time left to vote": days+hours up high, hours+minutes near the end. */
function timeLeft(deadlineUnix: number, nowUnix: number): string {
  const s = deadlineUnix - nowUnix;
  if (s <= 0) return t("explore.endingNow");
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return t("explore.timeLeftDaysHours", { d: n(d), h: n(h) });
  if (h >= 1) return t("explore.timeLeftHoursMinutes", { h: n(h), m: n(m) });
  return t("explore.timeLeftMinutes", { m: n(Math.max(1, m)) });
}

/** What an "Ends" cell reads: time-left while open, lifecycle word once closed. */
export function endsText(
  a: SurveyAggregate,
  tip: ChainTip,
  secondsPerEpoch: number,
  nowUnix: number,
): string {
  const v = viewStatus(a);
  if (v === "invalid") return t("explore.endsInvalid");
  if (v === "cancelled") return t("explore.endsWithdrawn");
  if (v === "ended") return t("explore.endsClosed");
  return timeLeft(
    voteDeadlineUnix(a.record.definition.endEpoch, tip, secondsPerEpoch),
    nowUnix,
  );
}
