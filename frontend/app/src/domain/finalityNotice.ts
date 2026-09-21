/**
 * What the Survey screen says about a closed survey that has no final result
 * yet — a pure decision, unit-testable without SolidJS.
 *
 * The serving tier finalizes a survey only once the end of its end epoch is
 * `k` blocks deep and can no longer roll back, hours after the epoch boundary.
 * Until then the results on screen are the live ones, and may still move.
 */

import {
  ACTIVE_SLOTS_COEFF,
  SECURITY_PARAM,
  stabilityWindowSlots,
  type Network,
  type Settling,
} from "cardano-tessera-client";
import type { ChainTip, SurveyStatus } from "cip-179/domain";

export type FinalityNotice =
  /**
   * The end epoch is still settling. `hoursLeft` is an estimate to the half
   * hour, or 0 for under an hour.
   */
  | { readonly kind: "settling"; readonly hoursLeft: number }
  /** The end epoch is final; the serving tier has yet to publish the result. */
  | { readonly kind: "finalizing" };

export interface FinalityInputs {
  readonly network: Network;
  readonly tip: ChainTip;
  readonly status: SurveyStatus;
  readonly talliable: boolean;
  readonly endEpoch: number;
  /** The list payload's `settling`, absent when no epoch is. */
  readonly settling: Settling | undefined;
  /** The source finalizes surveys at all — direct-Koios mode does not. */
  readonly finalizes: boolean;
  /** The serving tier has decided this survey. */
  readonly decided: boolean;
}

export function finalityNotice(i: FinalityInputs): FinalityNotice | null {
  if (!i.finalizes || i.decided || !i.talliable || i.status !== "ended") {
    return null;
  }
  if (i.settling?.epoch !== i.endEpoch) return { kind: "finalizing" };
  const hours = secondsLeft(i.network, i.tip, i.settling.blocksLeft) / 3600;
  return {
    kind: "settling",
    hoursLeft: hours < 1 ? 0 : Math.round(hours * 2) / 2,
  };
}

/**
 * Seconds until `blocksLeft` more blocks exist, at the rate this epoch has
 * produced them so far (the protocol's `1 / f` a block before any is seen),
 * and never past the stability window, where finality holds regardless.
 * A slot is one second.
 */
function secondsLeft(
  network: Network,
  tip: ChainTip,
  blocksLeft: number,
): number {
  const seen = SECURITY_PARAM[network] - blocksLeft;
  const perBlock = seen > 0 ? tip.epochSlot / seen : 1 / ACTIVE_SLOTS_COEFF;
  return Math.min(
    blocksLeft * perBlock,
    Math.max(0, stabilityWindowSlots(network) - tip.epochSlot),
  );
}
