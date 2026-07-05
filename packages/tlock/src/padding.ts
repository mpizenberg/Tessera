/**
 * Default sealed-response padding: the worst-case CBOR byte size of a
 * fully-answered response.
 *
 * Sealed responses are zero-padded to a fixed `padding_size` before timelock
 * encryption so every ciphertext for a survey shares one length — otherwise the
 * ciphertext size would leak how much each respondent answered. Sizing the pad
 * to the *largest possible* plaintext means a complete answer set still fits in
 * one length, and shorter ones are indistinguishable from it.
 *
 * This estimates that worst case analytically from the question definitions
 * (no encoding needed), mirroring `cip-179`'s {@link
 * import("cip-179").encodeAnswerItem} layout — each answer item is the 3-tuple
 * `[tag, question_index, value]`. Ported from the Elm reference's
 * `maxPlaintextSize`, extended to all seven question types.
 *
 * It is a safe **upper bound**, and tight for the common (small-number) case.
 * The one documented gap: free-text (`custom`) answers are counted as the empty
 * string since their length is unbounded — a long custom answer can exceed the
 * estimate and so yield a longer (size-leaking) ciphertext. Pure, no I/O.
 */

import type { OptionsOrCount, Question, RatingScale } from "cip-179";

// ----------------------------------------------------------------------------
// CBOR width helpers (how many bytes a value occupies, without encoding it)
// ----------------------------------------------------------------------------

/**
 * Bytes to CBOR-encode a non-negative integer of magnitude `mag` — also the
 * header width for array / byte-string / text lengths. Immediate forms up to
 * the 64-bit head, then a bignum (tag byte + byte string).
 */
function cborUintWidth(mag: bigint): number {
  if (mag < 0n) mag = -mag; // defensive; callers pass non-negative magnitudes
  if (mag < 24n) return 1;
  if (mag < 0x100n) return 2;
  if (mag < 0x10000n) return 3;
  if (mag < 0x1_0000_0000n) return 5;
  if (mag < 0x1_0000_0000_0000_0000n) return 9;
  const bytes = byteLength(mag);
  return 1 + cborUintWidth(BigInt(bytes)) + bytes; // tag + bytestring(header+body)
}

/** Bytes to CBOR-encode a possibly-negative integer (negative `v` encodes `-1 - v`). */
function cborIntWidth(v: bigint): number {
  return v >= 0n ? cborUintWidth(v) : cborUintWidth(-1n - v);
}

/** Minimum bytes to hold a positive magnitude (≥ 1). */
function byteLength(mag: bigint): number {
  let len = 0;
  for (let m = mag; m > 0n; m >>= 8n) len++;
  return Math.max(1, len);
}

/** Small non-negative count → its CBOR width. */
const uintWidth = (n: number): number => cborUintWidth(BigInt(Math.max(0, n)));

// ----------------------------------------------------------------------------
// Per-question worst-case value width
// ----------------------------------------------------------------------------

function optionCount(o: OptionsOrCount): number {
  return o.type === "options" ? o.labels.length : o.count;
}

/** Largest option index (0-based), or 0 when there are none. */
const maxIndex = (opts: number): number => Math.max(0, opts - 1);

/**
 * Worst-case width of a list of distinct choice indices: at most `limit` of
 * them (capped by the option count), each no wider than the largest index.
 */
function choiceListWidth(opts: number, limit: number): number {
  const count = Math.min(limit, opts);
  return uintWidth(count) + count * uintWidth(maxIndex(opts));
}

/**
 * Worst-case width of a list of `[index, value]` pairs — one per option,
 * each value no wider than `valueWidth` (points budget / top rating).
 */
function pairListWidth(opts: number, valueWidth: number): number {
  const pair = 1 /* 2-array header */ + uintWidth(maxIndex(opts)) + valueWidth;
  return uintWidth(opts) + opts * pair;
}

/** Top of a rating scale (the widest rating value it can carry). */
function ratingMaxValue(scale: RatingScale): bigint {
  switch (scale.type) {
    case "numeric":
      return scale.constraints.max;
    case "labels":
      return BigInt(Math.max(0, scale.labels.length - 1));
    case "count":
      return BigInt(Math.max(0, scale.count - 1));
  }
}

/** Worst-case width of one answer item `[tag, question_index, value]`. */
function maxAnswerItemSize(question: Question, qIndex: number): number {
  let valueWidth: number;
  switch (question.type) {
    case "custom":
      valueWidth = 1; // empty text string; unbounded answers may exceed this
      break;
    case "singleChoice":
      valueWidth = uintWidth(maxIndex(optionCount(question.options)));
      break;
    case "multiSelect":
      valueWidth = choiceListWidth(
        optionCount(question.options),
        question.maxSelections,
      );
      break;
    case "ranking":
      valueWidth = choiceListWidth(
        optionCount(question.options),
        question.maxRanked,
      );
      break;
    case "numericRange":
      valueWidth = Math.max(
        cborIntWidth(question.constraints.min),
        cborIntWidth(question.constraints.max),
      );
      break;
    case "pointsAllocation":
      valueWidth = pairListWidth(
        optionCount(question.options),
        uintWidth(question.budget),
      );
      break;
    case "rating":
      valueWidth = pairListWidth(
        optionCount(question.options),
        cborIntWidth(ratingMaxValue(question.scale)),
      );
      break;
  }
  // 1 (3-array header) + 1 (tag, always < 24) + question index + value.
  return 2 + uintWidth(qIndex) + valueWidth;
}

/**
 * Worst-case CBOR size (bytes) of a fully-answered response to `questions`:
 * the answers array header plus every question's largest-encoding answer item.
 * The default `padding_size` for a sealed survey.
 */
export function maxPlaintextSize(questions: readonly Question[]): number {
  const items = questions.reduce(
    (sum, q, i) => sum + maxAnswerItemSize(q, i),
    0,
  );
  return uintWidth(questions.length) + items;
}
