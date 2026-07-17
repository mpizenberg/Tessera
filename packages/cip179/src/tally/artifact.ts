/**
 * The content-addressed tally artifact (`backend/ARCHITECTURE.md` §7): the
 * self-describing, re-verifiable final result of a closed survey.
 *
 * Everything under `tally` is what the hash commits to — JSON-plain (numbers
 * are safe integers, weights are decimal strings) and hashed as
 * `blake2b256Hex(canonicalJson(tally))`. `provenance` records *where* the
 * inputs came from (useful, but re-fetchable) and is deliberately outside the
 * hash: a verifier reproduces `tally` from chain data + this ruleset and
 * compares hashes, regardless of which provider it queried.
 *
 * The ruleset itself is pinned the same way: {@link RULESET_DESCRIPTOR} is a
 * canonical description of every counting rule, and its hash is embedded in
 * each tally body — two artifacts hashed under different rules can never
 * compare equal.
 */

import type { AnswerItem, SurveyDefinition } from "../index.js";

import { blake2b256Hex, canonicalJson } from "./canonical.js";
import { fromJsonSafe, toJsonSafe } from "./wire.js";
import {
  weightedTallySurvey,
  type WeightedQuestionTally,
  type WeightedResponder,
} from "./weightedTally.js";

/**
 * The counting rules this implementation applies, as data. Change any rule and
 * `rulesetHash()` changes with it — bump `rulesetVersion` whenever that happens
 * (a golden test in `artifact.test.ts` pins the hash, so an unbumped change
 * fails CI). Note the hash commits to this *description*, not to the code it
 * describes: the load-bearing behaviors live in `cip-179`'s `validateResponse`
 * ("validity") and core's `dedupeResponses` ("dedup"), whose files carry a
 * matching RULESET-PINNED-BEHAVIOR note — a semantic change there needs the same
 * version bump even if this descriptor's text is untouched. Mirrors §6.2/§6.3
 * and the CIP-179 credential-proof mechanisms.
 */
export const RULESET_DESCRIPTOR = {
  // v2: responders record (txHash, responseIndex) — the artifact body schema
  // changed, so hashes are incomparable with v1 artifacts.
  // v3: sealed surveys now emit artifacts (the three sealed-* rules below); the
  // body gains `sealed=true`, counted responders commit their revealed answers,
  // and the schema change makes v3 hashes incomparable with v2.
  // v4: CIP-179 v5 — rating `require_all` tightens answer validity (the
  // validity rule), and mechanism B becomes purely additive: a qualifying vote
  // on any linked action proves on its own, a non-qualifying vote never
  // invalidates (mechanism A decides). Both change the counted set, so hashes
  // are incomparable with v3.
  // v5: per-question tallies are now *sparse* — `options`/`perOption` carry only
  // options that were actually answered (each with its own `index`), and rating
  // level distributions carry only populated levels. A hostile definition can
  // declare an astronomically large option count / rating span, and the old
  // dense arrays were sized by that declared width (a DoS: `new Array(2^40)`);
  // the sparse body grows with responses, never with the declared span. Pure
  // representation change — the counted set and every aggregate value are
  // unchanged — but the body schema differs, so hashes are incomparable with v4.
  // v6: dropped two presentation/redundant fields from the hashed body — the
  // rating per-option level histogram (display-only, read by no verifier,
  // derivable from the committed responders) and the points per-option
  // `answeredWeight` (which merely duplicated the question-level value, identical
  // for every option). `ratingScaleInfo` no longer participates in the hashed
  // body at all. Pure representation change — no counted value differs — but the
  // schema differs, so v6 hashes are incomparable with v5.
  // v7: an empty answers array is no longer a valid response (CDDL
  // `response_answers = [+ answer_item]`). The public path already couldn't
  // carry one (the decoder rejects `[]`), but a *sealed* response could reveal
  // to a zero-answer plaintext and was counted as a participant; the reveal now
  // treats an empty decoded array as a decode failure and the validity rule
  // rejects it, so such a ballot is excluded. Only sealed surveys with such a
  // ballot change count, but the counted set can differ, so v7 hashes are
  // incomparable with v6.
  // v8: read-side definition validity is now enforced (findings 10, 11 via the
  // `definition-validity` rule below). A survey whose on-chain definition fails
  // semantic validation on any error-severity problem — including
  // `spec_version != 5` — is untalliable and produces no artifact, where before
  // it was decoded and tallied under v5 semantics. No *valid* survey's tally
  // value changes, but the set of talliable surveys does (invalid ones drop out)
  // and the gate is now pinned, so v8 hashes are incomparable with v7.
  rulesetVersion: 8,
  cip179SpecVersion: 5,
  /** Roles artifacts cover: 0 DRep, 3 Stakeholder, 4 Keyholder (SPO/CC deferred). */
  coveredRoles: [0, 3, 4],
  /** What one unit of weight measures, per covered role. */
  roleMeasures: {
    "0": "drep_voting_power_at_end_epoch",
    "3": "active_stake_at_end_epoch",
    "4": "count",
  },
  rules: [
    "definition-validity: a survey is talliable only if its on-chain definition passes semantic validation with no error-severity problem — spec_version == 5, non-empty eligible_roles, at least one question, in-bounds question constraints (option/selection/ranked/rating/points/numeric bounds), and for a sealed survey round > 0 and padding_size > 0; duplicate eligible_roles is a SHOULD (warning) and does not disqualify. An untalliable survey produces no artifact and is never counted; a backend that tallies one diverges from a conformant verifier (which independently reaches the same untalliable verdict)",
    "window: a response is countable iff its transaction's epoch_no <= the survey's end_epoch (inclusive)",
    "validity: a response must pass full CIP-179 codec validation against the on-chain definition (eligible role, at least one answer, in-constraint answers including require_all rating coverage, required questions answered)",
    "credential-proof: mechanism A (credential key in required_signers, or its native script witnessed and satisfied) or mechanism B (a voting_procedures vote in the response transaction by the same credential on any governance action linked to the survey, with the voter tag's role equal to the claimed role — sufficient on its own); a response with no qualifying vote falls back to mechanism A (a non-qualifying vote never invalidates); mechanism B applies only to governance-linked surveys, and votability needs no separate check — the ledger only accepts votes on actions still in the proposal set",
    "dedup: at most one counted response per (survey, role, credential) — the latest in chain order wins, ordered by (slot, tx_block_index, response_index)",
    "membership+weight: role membership and weights are snapshotted at the survey's end_epoch; a credential registered at end_epoch but without stake counts with weight 0; unregistered credentials are excluded",
    "cancellation: a survey is cancelled iff a cancelling transaction at epoch_no <= end_epoch proves the definition's owner credential via mechanism A; the earliest such transaction in chain order (slot, then tx hash) is the one recorded; a cancelled survey's artifact carries no per-role tallies",
    "sealed-reveal: for a sealed survey, decrypt every in-window (rule 1), structurally-valid (rule 2), credential-proven (rule 3) response with the definition-pinned round's BLS-verified drand beacon, then decode the plaintext as the CBOR answers array (trailing zero padding to padding_size is ignored; an empty array is a decode failure) and re-validate those answers against the definition; a response that fails to decrypt, decode, or re-validate is excluded",
    "sealed-dedup: latest-in-chain dedup (rule 4) runs only over sealed responses whose decrypted answers re-validated; undecryptable/invalid responses are excluded and never supersede an earlier valid one; excluded responses are not committed to the artifact",
    "sealed-artifact: a sealed survey's tally carries sealed=true (cancellations included); each counted responder commits its revealed answers in JSON-safe wire form (bytes→hex, bigint→decimal string, Map→tagged pairs); only drand quicknet (chain hash 52db9ba7...c84e971) is supported — a non-quicknet sealed survey gets no artifact",
  ],
} as const;

/** blake2b-256 of the canonical {@link RULESET_DESCRIPTOR}. */
export function rulesetHash(): string {
  return blake2b256Hex(canonicalJson(RULESET_DESCRIPTOR));
}

/** One counted responder as committed in the artifact (weight in lovelace). */
export interface ArtifactResponder {
  /** "key:<hex>" | "script:<hex>" — same identity the dedup rule uses. */
  readonly credential: string;
  /** Decimal string; "1" per responder for the count-only Keyholder role. */
  readonly weight: string;
  /** Tx that carried the counted response. */
  readonly txHash: string;
  /**
   * Index of the response within that tx's label-17 payload. With `txHash`,
   * the full on-chain coordinate of the exact response dedup counted — a tx
   * can carry several responses, so the hash alone is ambiguous.
   */
  readonly responseIndex: number;
  /**
   * The responder's revealed answers, present **iff** the survey is sealed — a
   * `toJsonSafe`-encoded `AnswerItem[]` (the `sealed-artifact` rule's wire form).
   * Sealed answers live only in the ciphertext, so a verifier cannot rejoin them
   * from the on-chain response the way public tallies do; committing them here
   * makes a sealed tally reproducible. Decode with {@link responderAnswers}.
   */
  readonly answers?: unknown;
}

/** JSON-plain mirror of {@link WeightedQuestionTally} (bigints → strings). */
export type ArtifactQuestion =
  | {
      readonly kind: "options";
      readonly unit: "singleChoice" | "multiSelect" | "rankingFirst";
      /** One entry per *answered* option, `index` ascending (sparse). */
      readonly options: readonly {
        readonly index: number;
        readonly weight: string;
        readonly count: number;
      }[];
      readonly answeredCount: number;
      readonly answeredWeight: string;
    }
  | {
      readonly kind: "numeric";
      readonly weightedSum: string;
      readonly answeredWeight: string;
      readonly answeredCount: number;
      readonly values: readonly {
        readonly value: string;
        readonly weight: string;
        readonly count: number;
      }[];
    }
  | {
      readonly kind: "perOption";
      readonly unit: "points" | "rating";
      /** One entry per *answered* option, `index` ascending (sparse). */
      readonly perOption: readonly {
        readonly index: number;
        readonly weightedSum: string;
        /**
         * The mean's exact denominator. Rating only — each option's raters
         * differ; points omits it (the denominator is the question-level
         * `answeredWeight`, identical for every option).
         */
        readonly answeredWeight?: string;
        readonly count: number;
      }[];
      readonly answeredCount: number;
      readonly answeredWeight: string;
    }
  | {
      readonly kind: "custom";
      readonly answeredCount: number;
      readonly answeredWeight: string;
    };

/** One covered role's weighted result. */
export interface ArtifactRoleTally {
  /** CIP-179 role tag (0 DRep, 3 Stakeholder, 4 Keyholder). */
  readonly role: number;
  /**
   * The role's electorate total at end_epoch (decimal lovelace) — turnout's
   * denominator. `null` for count-only roles (Keyholder), where responder count
   * is the only meaningful total.
   */
  readonly total: string | null;
  /** Counted responders, sorted by credential identity. */
  readonly responders: readonly ArtifactResponder[];
  /** Weighted aggregates, one per question in definition order. */
  readonly questions: readonly ArtifactQuestion[];
}

/** The hashed part: everything the result *is*, nothing about where from. */
export interface TallyBody {
  /** {@link rulesetHash} of the rules this tally was computed under. */
  readonly rulesetHash: string;
  readonly network: string;
  readonly survey: {
    /** Defining tx hash (hex) + index within its definitions array. */
    readonly txId: string;
    readonly index: number;
    readonly endEpoch: number;
  };
  /**
   * True iff the survey's definition submission mode is `sealed` — i.e. answers
   * were timelock-encrypted and revealed after the drand round (the
   * `sealed-artifact` rule). Set on cancellation artifacts too. A hash-committed
   * value, so it is the same on the emitter and any re-verifier.
   */
  readonly sealed: boolean;
  /** Present iff the survey was cancelled in-window; `perRole` is then empty. */
  readonly cancelled?: {
    readonly txHash: string;
    readonly slot: number;
    readonly epoch: number;
  };
  /** Sorted by role ascending. */
  readonly perRole: readonly ArtifactRoleTally[];
}

/** The full served artifact: the hashed tally + unhashed provenance. */
export interface TallyArtifact {
  readonly tally: TallyBody;
  readonly provenance: {
    readonly source: {
      /** e.g. "koios". */
      readonly provider: string;
      readonly baseUrl: string;
    };
    /** Unix seconds when the weight snapshot completed. */
    readonly fetchedAt: number;
    /** Which endpoint supplied each role's weights/membership. */
    readonly byRole: readonly {
      readonly role: number;
      readonly endpoint: string;
    }[];
    /**
     * The epoch-aligned governance action ids the emitter resolved as linking
     * this survey (mechanism-B proof), sorted; `[]` = resolved and standalone.
     * Absent on a cancellation artifact (links aren't evaluated there).
     *
     * **Outside the hash**: the counted set these links produced is already
     * committed via {@link TallyBody.perRole}, so recording them changes no
     * content address. It makes the artifact self-describing, and lets a
     * re-verifier diff its own independently-resolved link set against the
     * emitter's — turning a would-be opaque tally mismatch into a precise
     * "link set diverged" signal (finding 6). Not a trust shortcut: the verifier
     * still re-resolves and re-checks; this is provenance, not evidence.
     */
    readonly govLinks?: readonly string[];
    /**
     * Present iff the survey is sealed: the drand chain + round the answers were
     * revealed with, and the beacon itself. Deliberately **outside** the hash —
     * the tally's on-chain definition already pins `(chainHash, round)`, and the
     * beacon is independently fetchable and BLS-verifiable, so an offline auditor
     * can re-derive the reveal without trusting this record.
     */
    readonly sealedReveal?: {
      /** Drand chain hash (hex) the round belongs to (quicknet). */
      readonly chainHash: string;
      /** Drand round whose beacon decrypts the responses. */
      readonly round: number;
      /** The beacon used, as returned by drand (re-verifiable against `round`). */
      readonly beacon: {
        readonly round: number;
        readonly randomness: string;
        readonly signature: string;
      };
    };
  };
}

/** blake2b-256 of the canonical tally body — the artifact's content address. */
export function artifactHash(tally: TallyBody): string {
  return blake2b256Hex(canonicalJson(tally));
}

/** Convert weighted tallies to their JSON-plain artifact form. */
export function toArtifactQuestions(
  tallies: readonly WeightedQuestionTally[],
): ArtifactQuestion[] {
  return tallies.map((t): ArtifactQuestion => {
    switch (t.kind) {
      case "options":
        return {
          kind: "options",
          unit: t.unit,
          options: t.options.map((o) => ({
            index: o.index,
            weight: String(o.weight),
            count: o.count,
          })),
          answeredCount: t.answeredCount,
          answeredWeight: String(t.answeredWeight),
        };
      case "numeric":
        return {
          kind: "numeric",
          weightedSum: String(t.weightedSum),
          answeredWeight: String(t.answeredWeight),
          answeredCount: t.answeredCount,
          values: t.values.map((v) => ({
            value: String(v.value),
            weight: String(v.weight),
            count: v.count,
          })),
        };
      case "perOption":
        return {
          kind: "perOption",
          unit: t.unit,
          perOption: t.perOption.map((o) => ({
            index: o.index,
            weightedSum: String(o.weightedSum),
            count: o.count,
            // Rating commits its per-option denominator; points omits it (it
            // equals the question-level `answeredWeight`).
            ...(o.answeredWeight !== undefined && {
              answeredWeight: String(o.answeredWeight),
            }),
          })),
          answeredCount: t.answeredCount,
          answeredWeight: String(t.answeredWeight),
        };
      case "custom":
        return {
          kind: "custom",
          answeredCount: t.answeredCount,
          answeredWeight: String(t.answeredWeight),
        };
    }
  });
}

/**
 * Convert counted responders to their committed artifact form — sorted by
 * credential identity, the determinism rule the hash depends on.
 *
 * For sealed surveys pass `{ revealedAnswers: true }`: each responder then also
 * commits its decrypted answers (`toJsonSafe(AnswerItem[])`, the `sealed-artifact`
 * wire form), taken from the already-revealed public response. Public tallies
 * omit `answers` — a verifier rejoins those from the on-chain response instead.
 */
export function toArtifactResponders(
  responders: readonly WeightedResponder[],
  opts?: { revealedAnswers?: boolean },
): ArtifactResponder[] {
  return responders
    .map((r): ArtifactResponder => {
      const base = {
        credential: r.credentialKey,
        weight: String(r.weight),
        txHash: r.txHash,
        responseIndex: r.responseIndex,
      };
      if (!opts?.revealedAnswers) return base;
      // By contract the response is already revealed to its public form here;
      // commit the answers array in JSON-safe wire form.
      const answers =
        r.response.answers.type === "public" ? r.response.answers.answers : [];
      return { ...base, answers: toJsonSafe(answers) };
    })
    .sort((a, b) =>
      a.credential < b.credential ? -1 : a.credential > b.credential ? 1 : 0,
    );
}

/**
 * The ruleset-pinned identity every tally body carries, independent of any
 * counts: the network, the survey coordinate, and whether answers were sealed.
 * `rulesetHash` is added by {@link baseTallyBody} so every variant commits to the
 * same rules.
 */
export interface TallyBodyIdentity {
  readonly network: string;
  readonly survey: TallyBody["survey"];
  readonly sealed: boolean;
}

/** The base shape shared by every body variant (weighted, cancelled, empty). */
function baseTallyBody(
  id: TallyBodyIdentity,
): Pick<TallyBody, "rulesetHash" | "network" | "survey" | "sealed"> {
  return {
    rulesetHash: rulesetHash(),
    network: id.network,
    survey: id.survey,
    sealed: id.sealed,
  };
}

/**
 * A body with no per-role tally: a survey that is untalliable (spec-invalid
 * definition), on an unsupported sealed chain, or short-circuited indeterminate.
 */
export function emptyTallyBody(id: TallyBodyIdentity): TallyBody {
  return { ...baseTallyBody(id), perRole: [] };
}

/** A cancelled survey's body: the winning cancellation marker, no per-role tally. */
export function cancelledTallyBody(
  id: TallyBodyIdentity,
  cancelled: NonNullable<TallyBody["cancelled"]>,
): TallyBody {
  return { ...baseTallyBody(id), cancelled, perRole: [] };
}

/**
 * One covered role's contribution to a weighted tally: its already
 * §6.1-membership-filtered weighted responders and its electorate `total`. The
 * membership filter and weight/total sourcing are inherently data-source-specific
 * (the emitter reads its frozen snapshot rows; the verifier re-fetches from
 * Koios), so they stay on each side; only the *result* flows through
 * {@link assembleTallyBody}.
 */
export interface RoleTally {
  readonly role: number;
  readonly responders: readonly WeightedResponder[];
  readonly total: string | null;
}

/**
 * Assemble the full weighted tally body from per-role inputs. This is the ONE
 * place the emitter and the verifier share role ordering, the per-role
 * artifact-question / responder shaping, and the base body — so the two
 * implementations cannot drift into a false MISMATCH (finding 29). Both already
 * shared `weightedTallySurvey` / `toArtifactResponders` / `toArtifactQuestions`;
 * this folds the surrounding glue (role sort + push shape + base body) in too.
 */
export function assembleTallyBody(
  definition: SurveyDefinition,
  id: TallyBodyIdentity,
  roles: readonly RoleTally[],
): TallyBody {
  const perRole: ArtifactRoleTally[] = [...roles]
    .sort((a, b) => a.role - b.role)
    .map(({ role, responders, total }) => ({
      role,
      total,
      responders: toArtifactResponders(
        responders,
        id.sealed ? { revealedAnswers: true } : undefined,
      ),
      questions: toArtifactQuestions(
        weightedTallySurvey(definition, responders),
      ),
    }));
  return { ...baseTallyBody(id), perRole };
}

/**
 * Decode a sealed responder's committed answers back to `AnswerItem[]` — the
 * inverse of the `toJsonSafe` encoding {@link toArtifactResponders} writes under
 * `{ revealedAnswers: true }`. Returns `null` for a public/legacy responder that
 * committed no answers.
 */
export function responderAnswers(r: ArtifactResponder): AnswerItem[] | null {
  if (r.answers === undefined) return null;
  return fromJsonSafe(r.answers) as AnswerItem[];
}
