/**
 * Fabricated, fully offline sample data for the dev harness. The widget never
 * fetches — the host always supplies `definition` / `responder` / `tipEpoch` —
 * so these mock props exercise exactly the same code paths as real ones.
 */

import {
  Role,
  SPEC_VERSION,
  type Credential,
  type Question,
  type SubmissionMode,
  type SurveyDefinition,
  type SurveyRef,
} from "cip-179";
import { hexToBytes } from "cip-179/domain";
import { QUICKNET_CHAIN_HASH } from "cip-179/tlock";
import type { Responder } from "@tessera/respond-core";

const keyCred = (hex: string): Credential => ({
  type: "key",
  keyHash: hexToBytes(hex),
});

const OWNER = keyCred("00".repeat(28));

/** The survey's on-chain location (a definition carries no ref — the host has it). */
export const surveyRef: SurveyRef = {
  txId: hexToBytes("11".repeat(32)),
  index: 0,
};

/**
 * A wallet-shaped responder eligible as DRep / Stakeholder / Keyholder — the
 * role→credential map a host derives from a connected wallet.
 */
export const responder: Responder = {
  [Role.Keyholder]: keyCred("aa".repeat(28)),
  [Role.Stakeholder]: keyCred("bb".repeat(28)),
  [Role.DRep]: keyCred("cc".repeat(28)),
};

/**
 * The same wallet, on a host that also vouches for an SPO credential (a pool
 * cold key hash a browser wallet can't hold) — just an extra entry in the map.
 * The widget trusts it, lets the user answer as SPO, and hands the credential
 * back in `proveCredentials`; proving it through the tx stays the host's job.
 */
export const spoResponder: Responder = {
  ...responder,
  [Role.SPO]: keyCred("dd".repeat(28)),
};

/** Current chain tip — before every sample's `endEpoch` except `closed`. */
export const TIP_EPOCH = 500;

// One question of every type, so the harness exercises every body component.
const QUESTIONS: Question[] = [
  {
    type: "singleChoice",
    prompt: "Which upgrade should ship first?",
    required: true,
    options: {
      type: "options",
      labels: ["Scaling (Leios)", "Governance polish", "Developer tooling"],
    },
  },
  {
    type: "multiSelect",
    prompt: "Which areas need funding? (pick up to 2, or none)",
    minSelections: 0,
    maxSelections: 2,
    options: {
      type: "options",
      labels: ["Core protocol", "Wallets", "Education", "Marketing"],
    },
  },
  {
    type: "ranking",
    prompt: "Rank these values by importance.",
    minRanked: 1,
    maxRanked: 3,
    options: {
      type: "options",
      labels: ["Decentralization", "Sustainability", "Usability"],
    },
  },
  {
    type: "numericRange",
    prompt: "Suggested treasury cut (%)?",
    constraints: { min: 0n, max: 100n, step: 5n },
  },
  {
    type: "pointsAllocation",
    prompt: "Distribute 100 points across the pillars.",
    budget: 100,
    options: {
      type: "options",
      labels: ["Research", "Community", "Infrastructure"],
    },
  },
  {
    type: "rating",
    prompt: "Rate each proposal (leave any blank).",
    requireAll: false,
    scale: { type: "labels", labels: ["Poor", "Fair", "Good", "Great"] },
    options: { type: "options", labels: ["Proposal A", "Proposal B"] },
  },
  {
    type: "custom",
    prompt: "Anything else? (interpreted by an external schema)",
    methodSchema: {
      uri: "ipfs://bafybeigdyrexamplecustomschemametadatumuri/schema.json",
      hash: hexToBytes("22".repeat(32)),
    },
  },
];

function makeDef(o: {
  title: string;
  eligibleRoles?: readonly Role[];
  endEpoch?: number;
  submissionMode?: SubmissionMode;
}): SurveyDefinition {
  return {
    specVersion: SPEC_VERSION,
    owner: OWNER,
    title: o.title,
    description:
      "A demo survey driving the <tessera-respond> widget in the dev harness.",
    eligibleRoles: o.eligibleRoles ?? [
      Role.DRep,
      Role.Stakeholder,
      Role.Keyholder,
    ],
    endEpoch: o.endEpoch ?? 600,
    submissionMode: o.submissionMode ?? { type: "public" },
    questions: QUESTIONS,
  };
}

export const SAMPLES = {
  public: makeDef({ title: "Public demo survey" }),
  sealed: makeDef({
    title: "Sealed demo survey",
    submissionMode: {
      type: "sealed",
      chainHash: QUICKNET_CHAIN_HASH,
      round: 45_000_000,
      paddingSize: 512,
    },
  }),
  closed: makeDef({ title: "Closed demo survey", endEpoch: 400 }),
  // Cancellation isn't in the definition (or `surveyStatus`) — it's an
  // on-chain tag-2 message only the host can observe, passed to the widget as
  // the `cancelled` prop. main.tsx sets it for this sample.
  cancelled: makeDef({ title: "Cancelled demo survey" }),
  ineligible: makeDef({
    title: "SPO/CC-only demo survey",
    eligibleRoles: [Role.SPO, Role.CC],
  }),
  // Same SPO/CC-only gate, but main.tsx pairs this sample with `spoResponder`
  // (host-supplied SPO credential) — so it's answerable, unlike `ineligible`.
  spo: makeDef({
    title: "SPO/CC-only demo survey (host credential)",
    eligibleRoles: [Role.SPO, Role.CC],
  }),
} satisfies Record<string, SurveyDefinition>;

export type SampleKey = keyof typeof SAMPLES;
