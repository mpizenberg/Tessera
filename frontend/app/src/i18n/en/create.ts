/** Create-a-survey screen — see ./index.ts for the namespace convention. */

const create = {
  // --- Back link & page header ---
  backToSurveys: "All surveys",
  pageTitle: "Create a survey",
  pageSubtitle:
    "Define the questions, who may respond, when it closes, and whether answers are public or sealed, then sign to publish the definition on-chain under metadata label 17.",

  // --- Submit progress overlay ---
  progressTitle: "Publishing your survey",
  stepPin: "Pinning the presentation to IPFS",
  stepSubmit: "Signing & submitting the transaction",

  // --- Busy / step text (publish flow) ---
  busyPublishing: "Publishing…",
  busyPinning: "Pinning presentation…",
  busySubmitting: "Submitting…",

  // --- Basics section ---
  sectionBasics: "Basics",
  fieldTitle: "Title",
  titlePlaceholder: "e.g. Treasury priorities for next epoch",
  fieldDescription: "Description",
  descriptionPlaceholder: "Optional context for respondents.",

  // --- Who can cancel (owner) section ---
  sectionWhoCanCancel: "Who can cancel",
  ownerHeading: "Owned by your payment credential.",
  ownerBody:
    "You sign with it to publish, and only it can cancel this survey later.",

  // --- Who can respond (roles) section ---
  sectionWhoCanRespond: "Who can respond",
  rolesHint:
    "Eligibility is a claim, verified independently against ledger state. SPO and CC can be listed, but can't respond from a browser wallet (they need cold/hot keys).",

  // --- Timing section ---
  sectionTiming: "Timing",
  govToggleTitle: "Tie this survey to a governance Info Action",
  govToggleDesc:
    "An on-chain Info Action will advertise this survey and they close together.",
  endEpochLabel: "End epoch (inclusive)",
  autoLockedBadge: "auto · locked",
  /** {date} is a preformatted wall-clock date. */
  closesOn: "Closes ~{date}",
  loadingEpoch: "Loading current epoch…",
  /** {hint} is loadingEpoch or currentEpochIs, spliced mid-paragraph. */
  acceptedThroughEpoch: "Responses are accepted through this epoch. {hint}",
  /** {epoch} is a raw epoch identifier; spliced into acceptedThroughEpoch. */
  currentEpochIs: "Current epoch is {epoch}.",
  govLifetimeUnreadable:
    "Couldn't read gov_action_lifetime from the chain, so the deadline can't be computed. Enter the Info Action's voting end epoch manually — they must match exactly.",
  /** {epochParen} is e.g. " (5)" when the tip is known, otherwise empty. */
  govNoteIntro:
    "Locked to the Info Action's voting deadline. On {network}, a governance action submitted this epoch{epochParen} closes at epoch",
  govNoteOutro:
    ", so the survey's end epoch must equal that. If you'll submit the action in a later epoch, untoggle and set a matching epoch by hand.",
  /** {epoch} is a raw epoch identifier. */
  tooEarlyWarning:
    "End epoch must be later than the current epoch ({epoch}), or the survey is closed as soon as it's published.",

  // --- Visibility section ---
  sectionVisibility: "Visibility",
  visPublicTitle: "Public",
  visPublicDesc: "Answers are plaintext, tallied as they arrive.",
  visSealedTitle: "Sealed",
  visSealedDesc: "Timelock-encrypted; opens at a drand round.",
  drandChainLabel: "Drand chain",
  revealRoundLabel: "Reveal round",
  drandAuto: "Auto",
  drandManual: "Manual",
  drandAutoHint:
    "Derived from the end epoch — the first drand round after responses close.",
  drandRoundPlaceholder: "drand round number",
  /** {date} is a preformatted reveal date. */
  revealsOn: "Reveals {date}",
  /** {round} is the locale-formatted drand round number; {date} a reveal date. */
  revealsRoundOn: "round {round} · reveals {date}",
  paddingLabel: "Padding size (bytes)",
  /** {size} is the auto-resolved worst-case padding size. */
  paddingAutoPlaceholder: "auto · {size}",
  /** {size} is the worst-case padding size in bytes. */
  paddingHint:
    "Each response is zero-padded to this length before encryption, so ciphertext size doesn't leak how much was answered. Leave blank to auto-size to the worst-case answer ({size} bytes for these questions).",
  sealedNote:
    "Responses are encrypted as they come in and stay hidden until the reveal time — not even you can read them early.",

  // --- Content section ---
  sectionContent: "Content",
  contentEmbeddedTitle: "Embedded",
  contentEmbeddedDesc:
    "All text on-chain. No external dependency — recommended.",
  contentExternalTitle: "External",
  contentExternalDesc:
    "Prompts & labels live in a pinned IPFS document; chain carries a hash anchor.",
  contentExternalNote:
    "On publish, the title, description, prompts and option labels are written to a presentation document, pinned to your IPFS providers, and anchored on-chain by its blake2b-256 hash. Only counts, constraints, owner and timing stay on-chain — so the survey still validates and tallies even if the document later becomes unreachable (only labels go missing). Keeps the on-chain payload small for large surveys.",
  /** Wraps the inline Settings <A> link: pre + link + post. */
  contentNoPinningPre: "No IPFS provider is configured. ",
  contentNoPinningLink: "Add one in Settings",
  contentNoPinningPost: " to publish external content, or switch to Embedded.",

  // --- Questions section ---
  sectionQuestions: "Questions",
  addAQuestion: "Add a question",
  /** {n} is the 1-based question number. */
  questionChip: "Q{n}",
  required: "Required",
  optional: "Optional",
  removeQuestion: "Remove question",
  promptPlaceholder: "Question prompt",

  // --- Add-a-question buttons (short type names) ---
  addSingle: "Single",
  addMulti: "Multi",
  addRanking: "Ranking",
  addNumeric: "Numeric",
  addPoints: "Points",
  addRating: "Rating",
  addCustom: "Custom",

  // --- Options editor ---
  addOption: "+ Add option",
  addLevel: "+ Add level",
  scaleHint: "ordered worst → best · answers store the 0-based index",
  /** {n} is the 1-based option number. */
  optionPlaceholder: "Option {n}",
  endBadgeWorst: "worst",
  endBadgeBest: "best",
  /** {n} is the 1-based option number. */
  removeOption: "Remove option {n}",

  // --- Min/max & numeric rows ---
  /** {label} is e.g. "selections" or "ranked". */
  minOf: "min {label}",
  maxOf: "max {label}",
  selectionsLabel: "selections",
  rankedLabel: "ranked",
  min: "min",
  max: "max",
  stepOptional: "step (optional)",
  numericStepPlaceholder: "1",

  // --- Points allocation ---
  budget: "Budget",

  // --- Rating ---
  ratingNumericScale: "Numeric scale",
  ratingLabelledScale: "Labelled scale",

  // --- Custom question ---
  customUriLabel: "Method schema URI",
  customUriPlaceholder: "ipfs://… or https://…",
  customHashLabel: "Schema hash (blake2b-256, hex)",
  customHashPlaceholder: "64 hex characters",

  // --- Summary card ---
  summary: "Summary",
  untitledSurvey: "Untitled survey",
  summaryQuestions: "Questions",
  summaryWhoResponds: "Who responds",
  summaryEnds: "Ends",
  summaryVisibility: "Visibility",
  noRolesSelected: "No roles selected",
  endsNone: "—",
  /** {epoch} is the raw end-epoch identifier the creator typed. */
  endsEpoch: "epoch {epoch}",
  /** {date} is a preformatted reveal date. */
  summarySealedReveals: "Sealed · reveals {date}",
  summarySealed: "Sealed",
  summaryPublic: "Public",

  // --- Publish button & note ---
  publishBlockedNetwork: "Switch your wallet to {network} before publishing",
  publishBlockedNoIpfs:
    "Add an IPFS provider in Settings to publish external content",
  signAndPublish: "Sign & publish survey",
  /** Wraps the inline mono key span: pre + key + post. */
  publishNoteOkPre: "signs with your owner credential · ",
  publishNoteOkPost: " · authorizes cancellation",
  /** {count} problems remaining. Singular/plural via {plural}. */
  publishNoteProblems: "{count} thing{plural} to fix before publishing",
  problemPluralSuffix: "s",

  // --- Problem list & section heads ---
  fixBeforePublishing: "Fix before publishing",

  // --- Submitted receipt ---
  surveyPublished: "Survey published",
  submittedBody:
    "Your definition was submitted under metadata label 17. It may take a few moments to appear as the indexer catches up.",
  /** {ref} is the short survey ref id. */
  submittedRef: "ref {ref}",
  viewSurvey: "View survey →",
  allSurveysButton: "All surveys",

  // --- Connect prompt ---
  connectTitle: "Connect a wallet to create",
  connectBody:
    "The survey is owned by your wallet's credential, which signs to publish it and is the only key that can cancel it. Use the Connect wallet button in the header.",
};

export type Messages = typeof create;
export default create;
