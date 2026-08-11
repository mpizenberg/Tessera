/**
 * The responses CSV, one shape for every results view: an auditor gets the same
 * columns whether they opened a live survey, a finalized one, or either
 * weighting of the latter, so two exports can be diffed against each other.
 *
 * One row per counted responder × answer, plus one envelope-only row for a
 * responder whose answers aren't readable here (an unrevealed sealed payload)
 * or shouldn't be republished (an excluded response — the row records that it
 * exists and why, so it can be looked up on-chain).
 */

import type { AnswerItem } from "cip-179";
import { serializeAnswer } from "cip-179/domain";

import { roleLabel } from "~/ui/format";
import { toCsv } from "~/util/csv";

export interface CsvEntry {
  /** `"counted"`, or why this response wasn't. */
  readonly disposition: string;
  readonly role: number;
  /** Stable credential identity, `key:<hex>` / `script:<hex>`. */
  readonly credential: string;
  /** What this responder carried into the tally; null when unweighed. */
  readonly weight: bigint | null;
  /** What {@link weight} measures — heterogeneous across roles. */
  readonly weightUnit: string;
  readonly txHash: string;
  readonly responseIndex: number;
  /** Null when the answers aren't readable or aren't being republished. */
  readonly answers: readonly AnswerItem[] | null;
  /** Whether a null {@link answers} is null because the payload is sealed. */
  readonly sealed: boolean;
}

const HEADER = [
  "disposition",
  "role",
  "credential",
  "weight",
  "weight_unit",
  "response_tx",
  "response_index",
  "question_index",
  "question_type",
  "answer",
];

export function responsesCsv(entries: readonly CsvEntry[]): string {
  const rows = entries.flatMap((e) => {
    const who = [
      e.disposition,
      roleLabel(e.role),
      e.credential,
      e.weight === null ? "" : String(e.weight),
      e.weightUnit,
      e.txHash,
      String(e.responseIndex),
    ];
    return e.answers
      ? e.answers.map((a) => [
          ...who,
          String(a.questionIndex),
          a.type,
          serializeAnswer(a),
        ])
      : [[...who, "", e.sealed ? "sealed" : "", ""]];
  });
  return toCsv([HEADER, ...rows]);
}
