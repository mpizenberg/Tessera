/** Respond screen — answer a survey (public or sealed), with optional Pro rationale. */

const respond = {
  // --- Top-level navigation / progress ------------------------------------
  backToResults: "Back to results",
  submitting: "Submitting…",
  encrypting: "Encrypting…",
  pinningRationale: "Pinning rationale…",

  // --- Submit progress steps ----------------------------------------------
  stepPin: "Pinning rationale to IPFS",
  stepEncrypt: "Timelock-encrypting your answers",
  stepSubmit: "Signing & submitting the transaction",
  progressTitleSealed: "Sealing your response",
  progressTitlePublic: "Submitting your response",

  // --- Manual rationale validation problems -------------------------------
  ratProblemUriRequired: "Rationale: document URI is required.",
  ratProblemHashBytes: "Rationale: hash must be 32 bytes (64 hex chars).",
  ratProblemHashHex: "Rationale: hash is not valid hex.",

  // --- Unverified cancellation claim --------------------------------------
  cancelClaimLead: "Unverified cancellation claim.",
  cancelClaimBody:
    "A cancellation for this survey was published but couldn't be verified as the owner's, so it's ignored — you can still respond.",

  // --- Closed / cancelled notices -----------------------------------------
  closedCancelledTitle: "This survey was cancelled",
  closedTitle: "This survey has closed",
  closedCancelledBody:
    "The owner withdrew it with a tag-2 cancellation. New responses are rejected. The definition stays on-chain for reference.",
  closedBody:
    "Its end epoch has passed, so new responses are no longer accepted. You can still read the results.",

  // --- Connect prompt ------------------------------------------------------
  connectTitle: "Connect a wallet to respond",
  connectBody:
    "Use the Connect wallet button in the header. Eligibility is checked against your wallet's credentials. You can read the survey and its results without connecting.",

  // --- Ineligible ----------------------------------------------------------
  ineligibleTitle: "You can't respond to this survey",
  ineligibleLead:
    "It's open only to the roles below, and your connected wallet can't claim any of them here. Here's what each one means:",
  notClaimable: " Not claimable in a browser wallet.",

  // --- Header --------------------------------------------------------------
  respondLabel: "Respond",
  refTitle: "Full survey ref — defining transaction hash and output index",
  /** {ref} is a raw on-chain reference, shown verbatim. */
  refPrefix: "ref {ref}",
  untitledSurvey: "Untitled survey",
  respondingAs: "Responding as",

  // --- Already-responded banner -------------------------------------------
  /** {role} is the role label, or the fallback below when unknown. */
  alreadyResponded: "You already responded as {role}",
  alreadyRespondedRoleFallback: "this role",
  alreadyRespondedText:
    "Your previous answers are pre-filled. Submitting again publishes a new response that fully replaces the earlier one under latest-valid-wins; the old one stays on-chain but is no longer tallied.",

  // --- Sealed banner -------------------------------------------------------
  sealedTitle: "This is a sealed survey",
  /** Wraps a bold clause (sealedNoOne) and the formatted reveal date. */
  sealedTextBefore: "Your answers are timelock-encrypted on submit — ",
  sealedNoOne: "no one, not even you, can read them",
  sealedTextAfter:
    " until the drand round publishes ({reveal}). Aggregate results appear only after the reveal.",

  // --- Labels-absent banner -----------------------------------------------
  labelsAbsentTitle: "Presentation labels unavailable",
  /** Wraps an inline short-ref span and a bold "You can still respond" clause. */
  labelsAbsentTextBefore: "The off-chain document (",
  labelsAbsentTextMid:
    ") couldn't be fetched or failed its hash check, so option labels are shown as indices. ",
  labelsAbsentCanRespond: "You can still respond",
  labelsAbsentTextAfter:
    " — your answer references option indices, validated and tallied normally.",

  // --- Rationale section ---------------------------------------------------
  /** Followed by a styled (off-chain, hash-anchored) hint span. */
  ratToggle: "Attach a rationale document",
  ratToggleHint: "(off-chain, hash-anchored)",
  ratSourceLabel: "Rationale source",
  ratModeWrite: "Write & pin",
  ratModeManual: "Paste anchor",
  ratDocUri: "Document URI",
  ratDocUriPlaceholder: "ipfs://… or https://…",
  ratHashLabel: "Hash (blake2b-256, hex)",
  ratHashPlaceholder: "64 hex characters",
  ratManualHint:
    "Host the document yourself; the hash makes it tamper-evident.",
  ratWriteLabel: "Rationale",
  ratWritePlaceholder: "Why you answered this way…",
  /** Wraps an inline link reading "Settings" (ratSettingsLink). */
  ratNoPinningBefore: "No IPFS provider is configured — add a token in",
  ratSettingsLink: "Settings",
  ratNoPinningAfter: "to pin from here, or switch to “Paste anchor”.",
  ratWriteHint:
    "On submit, this is pinned to your IPFS providers and anchored (URI + blake2b-256 hash) on your response. Informational only — never affects validation or tallies.",

  // --- Question type labels -----------------------------------------------
  typeCustom: "Custom · external schema",
  typeSingleChoice: "Single choice",
  typeMultiSelect: "Multi-select",
  typeRanking: "Ranking",
  typeNumericRange: "Numeric range",
  typePointsAllocation: "Points allocation",
  typeRating: "Rating",
  /** Type meta suffixes; {min}/{max}/{budget} are locale-formatted counts. */
  typeMetaRange: "{base} · {min}–{max}",
  typeMetaBudget: "{base} · budget {budget}",

  // --- Question card -------------------------------------------------------
  /** {n} is the 1-based question number. */
  questionChip: "Q{n}",
  required: "Required",
  skipped: "Skipped",
  skip: "Skip",
  noPrompt: "(no prompt)",
  skippedNote: "Skipped — abstaining. Nothing is recorded for this question.",

  // --- Multi-select body ---------------------------------------------------
  /** {min}/{max}/{chosen} are locale-formatted counts. */
  multiSelectCount: "select {min}–{max} · {chosen} chosen",
  noneLead: '"None of these" is a real answer.',
  noneNote:
    "This question allows 0 selections — submitting with nothing checked records a deliberate empty answer, different from Skip (abstain).",

  // --- Ranking body --------------------------------------------------------
  rankMoveUp: "Move up",
  rankMoveDown: "Move down",
  rankRemove: "Remove from ranking",
  /** {min}/{max} are locale-formatted counts. */
  rankPoolHint: "tap to add · rank {min}–{max}",

  // --- Points allocation body ---------------------------------------------
  pointsRemainLabel: "Remaining to allocate",
  /** {n} is the locale-formatted remaining points. */
  pointsRemain: "{n} pts",
  /** {budget} is the locale-formatted budget. */
  pointsFooter: "distribute {budget} points · sum must equal budget",

  // --- Custom body ---------------------------------------------------------
  customSchemaTag: "schema",
  customPlaceholder: "Your answer",
  customHint:
    "Encoded as a raw text metadatum and interpreted by the method at the anchor.",

  // --- Submit bar ----------------------------------------------------------
  /** {decided}/{total} are locale-formatted counts. */
  decidedCount: "{decided} of {total} decided",
  replacesNote: "✓ replaces your previous response",
  /** {network} is a chain name (e.g. mainnet/preview), shown verbatim. */
  switchNetwork: "Switch your wallet to {network} to submit",
  encryptAndSubmit: "Encrypt & submit",
  signAndSubmit: "Sign & submit",

  // --- Submitted panel -----------------------------------------------------
  submittedTitle: "Response submitted",
  submittedText:
    "Your response was published under metadata label 17. It may take a few moments to appear in the tally as the indexer catches up.",
  viewResults: "View results →",

  // --- Empty / loading / error --------------------------------------------
  loading: "Loading…",
  notFound: "Survey not found.",
  loadError: "Couldn't load from the network — this may be a transient error.",
  retry: "Retry",

  // --- Submit problems list ------------------------------------------------
  problemsTitle: "Please fix before submitting",

  // --- Option fallback label ----------------------------------------------
  /** {n} is the 1-based option number. */
  optionFallback: "Option {n}",
};

export type Messages = typeof respond;
export default respond;
