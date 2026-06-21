/**
 * CIP-179 constants: metadata label, spec version, and the integer tags used
 * by the discriminated unions in the CDDL.
 *
 * @module
 */

/** Reserved transaction metadata label for CIP-179 payloads. */
export const METADATA_LABEL = 17;

/** Schema version defined by CIP-179 v4. */
export const SPEC_VERSION = 4;

/** Length of `tx_id`, `blake2b_256` and `drand_chain_hash`, in bytes. */
export const HASH32_BYTES = 32;

/** Length of `hash28` (key hash / script hash), in bytes. */
export const HASH28_BYTES = 28;

/** Top-level payload tags (`cip_179_payload`). */
export const PayloadTag = {
  Definitions: 0,
  Responses: 1,
  Cancellations: 2,
} as const;
export type PayloadTag = (typeof PayloadTag)[keyof typeof PayloadTag];

/** Credential tags (`credential = [0, addr_keyhash // 1, script_hash]`). */
export const CredentialTag = {
  Key: 0,
  Script: 1,
} as const;
export type CredentialTag = (typeof CredentialTag)[keyof typeof CredentialTag];

/** Submission mode tags (`submission_mode`). */
export const SubmissionModeTag = {
  Public: 0,
  Sealed: 1,
} as const;
export type SubmissionModeTag =
  (typeof SubmissionModeTag)[keyof typeof SubmissionModeTag];

/**
 * Question / answer type tags. The tag is shared between a question and its
 * matching answer. Tag 0 is the stable custom extension point.
 */
export const QuestionTag = {
  Custom: 0,
  SingleChoice: 1,
  MultiSelect: 2,
  Ranking: 3,
  NumericRange: 4,
  PointsAllocation: 5,
  Rating: 6,
} as const;
export type QuestionTag = (typeof QuestionTag)[keyof typeof QuestionTag];

/**
 * Roles permitted to respond (`role`). A role declares eligibility and hints
 * the UI which key to present; it is not a weighting directive.
 */
export const Role = {
  DRep: 0,
  SPO: 1,
  CC: 2,
  Stakeholder: 3,
  Owner: 4,
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** All valid role values. */
export const ROLE_VALUES: readonly Role[] = [0, 1, 2, 3, 4];

/**
 * Documentation-only interop URN aliases for the built-in method tags. These
 * never appear in metadata; see the CIP-179 Method Identifier Registry.
 */
export const METHOD_URNS: Readonly<Record<QuestionTag, string | null>> = {
  [QuestionTag.Custom]: null,
  [QuestionTag.SingleChoice]: "urn:cardano:poll-method:single-choice:v2",
  [QuestionTag.MultiSelect]: "urn:cardano:poll-method:multi-select:v2",
  [QuestionTag.Ranking]: "urn:cardano:poll-method:ranking:v1",
  [QuestionTag.NumericRange]: "urn:cardano:poll-method:numeric-range:v2",
  [QuestionTag.PointsAllocation]:
    "urn:cardano:poll-method:points-allocation:v1",
  [QuestionTag.Rating]: "urn:cardano:poll-method:rating:v1",
};
