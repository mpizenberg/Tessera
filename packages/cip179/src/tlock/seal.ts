/**
 * Seal / reveal orchestration for sealed (commit-reveal) surveys.
 *
 * Ties three layers together — the `cip-179` codec (answer ↔ metadatum), the
 * `./cbor` seam (metadatum ↔ bytes), and the `./client` tlock seam (timelock
 * encrypt/decrypt) — so it pulls in evolution-sdk and the tlock bundle; import
 * it lazily (it is reached only from the submit and reveal paths).
 *
 * Wire format (interoperable with the spec and the Elm reference): the timelock
 * **plaintext is the CBOR of the answers array, zero-padded to `padding_size`**
 * so every sealed response encrypts to a uniform length and the count of
 * answered questions doesn't leak through ciphertext size.
 */

import {
  decodeAnswerItem,
  encodeAnswerItem,
  type AnswerItem,
  type Metadatum,
  type SurveyResponse,
} from "../index.js";

import type { RandomnessBeacon } from "./client.js";
import { decryptWithBeacon, encryptToRound, fetchBeacon } from "./client.js";
import { cborToMetadatum, metadatumToCbor } from "./cbor.js";

/** Right-pad bytes with zeros to at least `size` (no-op if already longer). */
function padTo(bytes: Uint8Array, size: number): Uint8Array {
  if (bytes.length >= size) return bytes;
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

/**
 * Timelock-encrypt a response's answers for a sealed survey. Returns the
 * ciphertext bytes to place in a sealed {@link SurveyResponse}.
 */
export async function sealAnswers(
  answers: readonly AnswerItem[],
  round: number,
  paddingSize: number,
): Promise<Uint8Array> {
  const metadatum: Metadatum = answers.map(encodeAnswerItem);
  const plaintext = padTo(metadatumToCbor(metadatum), paddingSize);
  return encryptToRound(plaintext, round);
}

/**
 * Reveal a batch of sealed responses with an **already-fetched** beacon — the
 * offline half of the reveal. Decrypt each ciphertext, decode its answers, and
 * re-emit it as a public response (preserving ref / role / credential). A
 * response that fails to decrypt or decode becomes `null` (callers pair each
 * result with its original record by index) — one bad payload never sinks the
 * tally. Non-sealed responses pass through unchanged.
 *
 * Split from {@link revealResponses} so callers that fetch (and BLS-verify) the
 * beacon themselves — the backend finalizer, the verifier — can reuse it and
 * commit the same beacon to the artifact's provenance.
 */
export async function revealWithBeacon(
  sealed: readonly SurveyResponse[],
  beacon: RandomnessBeacon,
): Promise<(SurveyResponse | null)[]> {
  const results: (SurveyResponse | null)[] = [];

  for (const r of sealed) {
    if (r.answers.type !== "sealed") {
      results.push(r);
      continue;
    }
    try {
      const plaintext = await decryptWithBeacon(r.answers.ciphertext, beacon);
      const m = cborToMetadatum(plaintext);
      if (!Array.isArray(m)) throw new Error("decrypted payload is not a list");
      const answers: AnswerItem[] = m.map((item, i) =>
        decodeAnswerItem(item, `answer[${i}]`),
      );
      results.push({ ...r, answers: { type: "public", answers } });
    } catch {
      results.push(null);
    }
  }

  return results;
}

/**
 * Reveal a batch of sealed responses: fetch (and BLS-verify) the round's beacon
 * once, then {@link revealWithBeacon}. The online convenience wrapper for the
 * browser reveal path; the fetch is the only networked step.
 */
export async function revealResponses(
  sealed: readonly SurveyResponse[],
  round: number,
): Promise<(SurveyResponse | null)[]> {
  const beacon = await fetchBeacon(round);
  return revealWithBeacon(sealed, beacon);
}
