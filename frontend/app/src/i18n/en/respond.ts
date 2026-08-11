/**
 * Respond screen — answer a survey (public or sealed), with optional Pro
 * rationale.
 *
 * The answering UI itself is `respond-ui`'s, shared with the `<tessera-respond>`
 * widget, and so is its wording: this namespace *is* `respond-core`'s `respond`
 * catalog, plus the strings for what only the app does (wallet, network,
 * IPFS pinning, submit progress, navigation) and the two the app says
 * differently because it has a wallet to name.
 */

import { enMessages } from "cardano-tessera-respond-core";

const respond = {
  ...enMessages.respond,

  // --- Shared strings the app words differently (it has a wallet) ---------
  ineligibleLead:
    "It's open only to the roles below, and your connected wallet can't claim any of them here. Here's what each one means:",
  notClaimable: " Not claimable in a browser wallet.",

  // --- Top-level navigation / progress ------------------------------------
  backToResults: "Back to results",
  submitting: "Submitting…",
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

  // --- Invalid definition (the widget never renders one) ------------------
  untalliableTitle: "This survey's definition is invalid",
  untalliableBody:
    "Its on-chain definition doesn't conform to CIP-179 v5 (wrong spec version, or a constraint the spec forbids), so it is untalliable and no conformant reader counts it. Responding would waste a fee, so submission is disabled.",

  // --- Connect prompt ------------------------------------------------------
  connectTitle: "Connect a wallet to respond",
  connectBody:
    "Use the Connect wallet button in the header. Eligibility is checked against your wallet's credentials. You can read the survey and its results without connecting.",

  // --- Header --------------------------------------------------------------
  refTitle: "Full survey ref — defining transaction hash and output index",
  /** {ref} is a raw on-chain reference, shown verbatim. */
  refPrefix: "ref {ref}",

  // --- Vote deadline --------------------------------------------------------
  deadlinePassed:
    "Voting closed while this page was open — a response submitted now would be excluded from the tally.",
  /** {m} is the number of minutes left before responses stop counting. */
  deadlineSoon:
    "Voting closes in about {m} min — submit now, or your response may miss the deadline.",

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

  // --- Submit bar ----------------------------------------------------------
  /** {network} is a chain name, shown verbatim. */
  switchNetwork: "Switch your wallet to {network} to submit",

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
};

export type Messages = typeof respond;
export default respond;
