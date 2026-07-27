/**
 * The sealed-submission seam — the one place that pulls in the timelock weight.
 *
 * For a sealed survey the answers are timelock-encrypted (drand quicknet) before
 * submission, so nobody — not even the responder — can read them until the
 * reveal round publishes. That needs two heavy dependencies cip-179 keeps as
 * optional peers: a CBOR encoder for the plaintext answers (`cip-179/evolution`,
 * evolution-sdk) and the tlock stack (`cip-179/tlock`, `@mattpiz/tlock-js`).
 *
 * Both are **dynamically imported** here so the public answering path never
 * loads either: the widget's build splits them into chunks fetched only when a
 * sealed survey is actually answered.
 */

import type { AnswerItem } from "cip-179";

/**
 * Timelock-encrypt a sealed response's answers to `round`, padded to
 * `paddingSize` (so every sealed response encrypts to a uniform length and the
 * answered-question count can't leak through ciphertext size). Returns the
 * ciphertext bytes for a sealed {@link import("cip-179").SurveyResponse}.
 *
 * Lazy by construction — the two imports below are the only reference to the
 * evolution/tlock chunks in the widget's public bundle.
 */
export async function sealResponse(
  answers: readonly AnswerItem[],
  round: number,
  paddingSize: number,
): Promise<Uint8Array> {
  const { evolutionCodec } = await import("cip-179/evolution");
  const { sealAnswers } = await import("cip-179/tlock");
  return sealAnswers(evolutionCodec, answers, round, paddingSize);
}
