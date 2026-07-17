/** Survey screen — results, owner controls, sealed reveal, response breakdown. */

const survey = {
  // Top navigation
  backAll: "All surveys",

  // Question type labels (BASE_TYPE) — composed with type-suffix sub-messages.
  typeCustom: "Custom",
  typeSingleChoice: "Single choice",
  typeMultiSelect: "Multi-select",
  typeRanking: "Ranking",
  typeNumericRange: "Numeric range",
  typePointsAllocation: "Points",
  typeRating: "Rating",

  // Unverified cancellation notice. The leading run is bold (its own <strong>),
  // the rest is plain — kept as two messages so each stays a whole phrase.
  claimedNoticeStrong: "Unverified cancellation claim.",
  claimedNoticeRest:
    "A cancellation referencing this survey was published, but this client couldn't verify it came from the survey owner — so it isn't acted on. Only an owner-signed cancellation invalidates a survey.",

  // Invalid-definition notice (untalliable survey). Bold lead + plain rest.
  invalidNoticeStrong: "Invalid definition.",
  invalidNoticeRest:
    "This survey's on-chain definition doesn't conform to CIP-179 v5 (wrong spec version, or a constraint the spec forbids), so it is untalliable: no results are produced and responding is disabled. The definition stays on-chain for reference.",

  // Respond CTA
  respondCta: "Respond to this survey",

  // Owner controls (cancel)
  cancelSubmittedTitle: "Cancellation submitted",
  cancelSubmittedBody:
    "New responses are rejected once it's indexed. The definition stays on-chain for reference.",
  ownerText:
    "You can withdraw it — existing responses stay on-chain but new ones are rejected.",
  /** Leading strong run of {@link ownerText}. */
  ownerTextStrong: "You own this survey.",
  cancelSurvey: "Cancel survey",
  cancelling: "Cancelling…",
  confirmCancel: "Confirm cancel",
  keep: "Keep",
  switchNetwork: "Switch your wallet to {network} to cancel",

  // Link survey to a governance action (any kind — CIP-179 v5)
  linkOptional: "Optional",
  linkTitle: "Link this survey to a governance action",
  /**
   * Linkage explainer, split into prose runs around four styled inline tokens:
   * a bold "Action → Survey", and the mono code literals `cip179`, `body`,
   * `@context`, `end_epoch <n>` (all untranslatable, kept literal in JSX). Each
   * linkBodyN below is one whole translatable run; the segment boundaries (and
   * their surrounding spaces) must be preserved when translating.
   */
  linkBody1: "Linkage is",
  /** Bold run between linkBody1 and linkBody2. */
  linkBodyDirection: "Action → Survey",
  linkBody2:
    ": your survey already exists, so the governance action just points at it. Nest this object as",
  linkBody3: "inside the action's CIP-108",
  linkBody4: "(and add the CIP-179",
  linkBody5:
    "terms, per the spec, so the anchor stays valid JSON-LD). The action's expiry epoch must equal this survey's",
  linkBody6: ", or tooling won't attach it.",
  copied: "Copied ✓",
  copyJson: "Copy JSON",
  /** Intro for the ready-made `@context` additions offered below the link JSON. */
  linkContextHint:
    "Merge these terms into your anchor's @context (the CIP179 namespace at the root, the cip179 term inside the body context) so the link is canonicalized and covered by the author witness:",
  copyContext: "Copy @context terms",
  linkFootnote:
    "any governance action kind may link · linkage is discovery + epoch-alignment, never an eligibility gate",

  // Header
  refTitle: "Full survey ref — defining transaction hash and output index",
  /** {ref} is the raw transaction-hash#index, shown untranslated. */
  refLead: "ref {ref}",
  untitledSurvey: "Untitled survey",
  govLinkBadge: "Linked action",
  govLinkAdvertisedFallback: "Advertised by a governance action",
  /** Prose run before the bold action title; the title is appended in JSX. */
  govLinkAdvertisedBy: "Advertised by",
  /** {epoch} is the raw end epoch, shown untranslated. */
  govLinkMeta:
    "survey & vote both close at epoch {epoch} · open to all eligible roles — casting the linked vote is optional",
  // Survey summary card (header): orientation metadata, plus a plain per-role
  // response count — no cross-role percentages, since roles are separate
  // electorates that shouldn't be compared as shares of one whole.
  summaryQuestions: "Questions",
  summaryEligible: "Eligible",
  summaryEnds: "Ends",
  summaryResponses: "Responses",

  // Per-question result widgets
  /** Question chip, e.g. "Q1"; {n} is the 1-based index (data). */
  qLabel: "Q{n}",
  noPrompt: "(no prompt)",
  /** "{n} abstained" — abstention count under a result card. */
  abstained: "{n} abstained",
  // typeLabel suffixes, composed as "{base} · {suffix}".
  typeSuffixResponders: "% of responders",
  typeSuffixFirstPreferences: "first preferences",
  typeSuffixDistribution: "distribution",
  typeSuffixAverageAllocation: "average allocation",
  typeSuffixNumericGrid: "numeric grid",
  typeSuffixLabelledScale: "labelled scale",
  typeSuffixInterpretedOffchain: "interpreted off-chain",
  /** "{base} · {suffix}" join used for every composed type label. */
  typeLabelJoined: "{base} · {suffix}",
  /** Points bar meta: "{avg} pts"; {avg} is preformatted. */
  pointsMeta: "{avg} pts",

  // Histogram card
  histMean: "mean",
  histMedian: "median",

  // Custom card
  /** Free-form answers count label following the value. */
  customCountLabel: "free-form answers · tallied per the external schema",

  // Empty states
  noResponsesYet: "No responses yet.",

  // Exclusion meta (exclusionMeta)
  exclAfterDeadlineLabel: "Submitted after the deadline",
  /** {epoch} is the raw end epoch, shown untranslated. */
  exclAfterDeadlineHint: "recorded past end_epoch {epoch}",
  exclInvalidLabel: "Invalid for this survey",
  exclInvalidHint:
    "out-of-constraint answer, ineligible role, or missing required answer",
  exclSupersededLabel: "Superseded by a later response",
  exclSupersededHint: "same role + credential · latest-wins",
  exclUndecryptableLabel: "Couldn't be decrypted or decoded",
  exclUndecryptableHint: "malformed or non-conformant payload",

  // Exclusion panel
  exclHeadTitle: "Why responses weren't counted",
  exclHeadNote: "on-chain checks only",
  /**
   * Footnote split around a mono "end_epoch <n>" run (untranslatable, literal in
   * JSX): exclFootnote1 is the prose before it, exclFootnote2 the prose after.
   */
  exclFootnote1:
    "Excluded responses stay on-chain but aren't tallied. Eligibility checks that need ledger state — role membership re-verified at the",
  exclFootnote2:
    "snapshot, credential proofs — are resolved by an indexer and aren't reflected here.",

  // Individual responses
  individualResponses: "Individual responses",
  /** "Show {n} more ({left} left)" expansion button. */
  showMore: "Show {n} more ({left} left)",

  // Response card
  responseRationaleTitle:
    "Open the voter's rationale document in a new tab (not hash-verified)",
  responseRationale: "rationale ↗",
  responseSealed: "(sealed — not yet revealed)",
  /** Per-answer question chip: "Q{n}"; {n} is 1-based (data). */
  responseAnswerQ: "Q{n}",

  // Results body — counted/excluded/export
  /** "{n} counted" pill. */
  counted: "{n} counted",
  /** "{n} excluded" toggle (caret rendered separately). */
  excluded: "{n} excluded",
  exportCsv: "Export CSV",
  incomplete:
    "More label-17 transactions exist on-chain than could be loaded, so this tally may be missing responses.",

  // Informational note (shown on every results view). Tessera tallies are
  // indicative; the survey creator interprets the outcome. Split around the
  // bold {@link infoNoteStrong} lead.
  infoBadge: "info",
  infoNoteStrong: "Informational tally.",
  infoNote:
    "Tessera counts on-chain responses under generic CIP-179 rules. It can't apply a survey's own validity rules, allow-lists, or custom weighting (quadratic, caps, …) — interpreting the result is the survey creator's job.",

  // Final results (artifact view): weighting switch + exports
  /** Segmented-switch label preceding the two weighting options. */
  weightingLabel: "Weighting",
  weightingChain: "Chain-weighted",
  weightingOne: "One vote each",
  exportArtifact: "Export artifact",
  exportVotesCsv: "Export votes (CSV)",
  weightedShowRaw: "View raw responses",
  weightedShowFinal: "\u2190 Final results",
  /** Per-role section header meta: "{n} counted". */
  weightedCounted: "{n} counted",
  /** Stake-weighted roles: total voting weight behind the counted responses. */
  weightedVotingWeight: "{ada} \u20b3 voting weight",
  /** Turnout against the role's electorate total. */
  weightedTurnout: "{pct}% turnout",
  /** Weighted mean shown on numeric results. */
  weightedMean: "weighted mean",
  /** Bar meta on weighted results: ada weight + responder count. */
  weightedBarMeta: "{ada} \u20b3 \u00b7 {n}",
  weightedCancelledTitle: "Survey cancelled by its owner",
  weightedCancelledBody:
    "An owner-proven cancellation was recorded on-chain in epoch {epoch}; no results are tallied.",
  /**
   * Footer under the final tally; {epoch} end epoch, {provider} weight source,
   * {hash} the artifact content address.
   */
  weightedFootnote:
    "membership & weights snapshotted at end epoch {epoch} from {provider} \u00b7 independently re-verifiable \u00b7 artifact {hash}",

  // Role filter
  roleFilterLabel: "Tally by role",

  /** Footer under the tally; {n} is the counted response total. */
  tallyFootnote:
    "tally derived independently from on-chain data · {n} responses counted",

  // Sealed results states (SealedStateNotice)
  sealedCancelledTitle: "This survey was cancelled",
  sealedCancelledBody:
    "The owner withdrew it. Any sealed responses stay on-chain but aren't tallied.",
  sealedUnsupportedTitle: "Unsupported drand chain",
  sealedUnsupportedBody:
    "This sealed survey pins a drand chain Tessera can't decrypt — only quicknet is supported here.",
  sealedTitle: "Answers are sealed",
  /** {n} responses, {date} the reveal date (data). */
  sealedBody:
    "{n} encrypted {responses} collected. They open {date} — no one, not even the owner, can read them until the drand round publishes.",
  /** Singular/plural noun spliced into {responses} of {@link sealedBody}. */
  responseSingular: "response",
  responsePlural: "responses",
  revealingTitle: "Revealing…",
  revealingBody: "Fetching the drand beacon and decrypting responses.",
  revealErrorTitle: "Couldn't reveal",
  sealedRevealableTitle: "Answers can now be revealed",
  /** {date} the reveal date (data), {n} the response count, {responses} noun. */
  sealedRevealableBody:
    "The drand round published on {date}. Revealing decrypts all {n} sealed {responses} in your browser and tallies them.",
  revealAll: "Reveal all responses",

  // Labels-unavailable notice. Body split around three styled inline runs: the
  // mono short ref (data, literal in JSX), the bold {@link labelsBodyAccurate},
  // and the italic {@link labelsBodyIndices}.
  labelsTitle: "Presentation labels unavailable",
  /** Prose before the mono ref; ends with "(" that hugs the ref. */
  labelsBody1: "The off-chain document (",
  /** Prose between the mono ref and the bold run; starts with ")". */
  labelsBody2:
    ") couldn't be fetched or failed its hash check, so titles and option labels can't be shown.",
  labelsBodyAccurate: "Results are still accurate",
  /** Prose between the bold run and the italic "indices". */
  labelsBody3:
    "— every question type, count and constraint is on-chain, and answers reference option",
  labelsBodyIndices: "indices",
  /** Prose after the italic "indices"; starts with ",". */
  labelsBody4: ", which are tallied normally.",

  // Empty / loading / error
  loading: "Loading…",
  notFound: "Survey not found.",
  loadError: "Couldn't load from the network — this may be a transient error.",
  retry: "Retry",
};

export type Messages = typeof survey;
export default survey;
