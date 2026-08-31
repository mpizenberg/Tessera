/** "Link this survey to a governance action" screen — see ./index.ts for the convention. */

const linkSurvey = {
  // Header / lead
  backToSurvey: "Back to the survey",
  govPill: "Governance",
  title: "Link to a governance action",
  /**
   * The lead wraps a bold inline "Info Action" token, so it's split into prose
   * fragments around it — the token itself isn't translated.
   */
  leadPre:
    "Produce the CIP-108 metadata document that advertises this survey, host it, then build and sign the Conway ",
  leadPost:
    " carrying it. The action has no on-chain effect — it only points voters at the survey — and its refundable deposit returns to your stake address when it is ratified or expires.",

  // The survey being linked (loaded from its bundle)
  linkingLabel: "Linking survey",
  untitledSurvey: "Untitled survey",
  /** {endEpoch} is a raw epoch number (not translated). */
  endEpochLine: "end_epoch {endEpoch}",
  loadingSurvey: "Loading the survey…",
  surveyNotFound: "No such survey.",
  surveyLoadFailed: "Couldn't load the survey. It may not be indexed yet.",
  retry: "Retry",
  badKey: "This isn't a survey reference.",

  // Validation problems (from the JSON shape check)
  /** {message} is the raw JSON parse error (not translated). */
  problemNotJson: "Not valid JSON: {message}",
  problemMissingContext: 'Missing JSON-LD "@context" (CIP-100/108 terms).',
  problemContextMissingCip179Terms:
    'The "@context" must define the CIP179 namespace and map "cip179" (with its specVersion, kind, surveyTxId and surveyIndex sub-terms) inside the body context, or the link is dropped during JSON-LD canonicalization and falls outside the author witness. See the CIP-179 worked example.',

  // Epoch-alignment notes
  alignTipNotLoaded: "Chain tip not loaded yet — can't verify epoch alignment.",
  alignSurveyNotOnchain:
    "Linked survey isn't on-chain yet — can't verify its end_epoch. Make sure it's published and indexed.",
  alignLifetimeUnknown:
    "gov_action_lifetime is unknown — can't compute the voting deadline.",
  /**
   * {epoch}/{end}/{submitEpoch}/{deadline} are raw epoch numbers and
   * {windowStart}/{windowEnd} locale-formatted dates (none translated).
   */
  alignAligned:
    "Aligned — the current epoch {epoch} is the submission epoch: proposing now gives a voting deadline of epoch {end}, matching the survey's end_epoch. This window closes {windowEnd}.",
  alignTooEarly:
    "Too early — propose during epoch {submitEpoch} ({windowStart} → {windowEnd}) so the action's deadline matches the survey's end_epoch {end}. The current epoch is {epoch}; proposing now would set the deadline to epoch {deadline}.",
  alignWindowPassed:
    "Window passed — the survey ends at epoch {end}, so the action had to be proposed during epoch {submitEpoch} ({windowStart} → {windowEnd}). The current epoch is {epoch}, and a link to that survey can no longer form.",

  // Step 1 · The document
  step1Head: "1 · The document",
  entryQuestion:
    "Create the governance action metadata from scratch, or start from a CIP-108 JSON document you already have?",
  entryFromScratch: "Create from scratch",
  entryFromScratchHint:
    "A minimal form producing a valid CIP-108 base for the Info Action, survey link included.",
  entryUpload: "I have a document",
  entryUploadHint:
    "Produced by your governance tooling and not yet linked — the survey link is inserted for you.",
  entryChange: "Start over",

  // From-scratch form
  formTitle: "Title",
  formTitleHint: "Shown on the survey page as “Advertised by …”.",
  formAbstract: "Abstract",
  formMotivation: "Motivation",
  formRationale: "Rationale",
  formGenerate: "Generate the linked document",

  // Upload branch
  /**
   * The hint wraps two inline mono tokens (".jsonld" and "body.cip179"), so
   * it's split into prose fragments around them — the tokens aren't translated.
   */
  uploadHintPre: "Choose the CIP-108 ",
  uploadHintMid:
    " file your governance tooling produced, without any survey link. It's read locally; the ",
  uploadHintPost:
    " link and its @context terms are inserted, and the document re-emitted.",
  refusalNotJson: "Not valid JSON: {message}",
  refusalNotObject:
    "Not a CIP-108 document — the top level isn't a JSON object.",
  refusalNoBody: 'Not a CIP-108 document — it has no "body" object.',
  refusalNoContext:
    'Not a JSON-LD document — it has no "@context" object to merge the CIP-179 terms into.',
  /** {ref} is the raw "txHash:index" the input already links (not translated). */
  refusalAlreadyLinkedTo:
    "This document already links survey {ref}. Governance tooling never writes body.cip179 — start from the unlinked document, or link that survey from its own page.",
  refusalAlreadyLinked:
    "This document already carries a body.cip179 entry (malformed). Governance tooling never writes that field — start from the unlinked document.",
  strippedAuthors:
    "The document's authors section was emptied: its witness signed the unlinked body, so it can't survive this edit. Have every author re-sign the emitted document if you need the witness back.",

  // Step 2 · Host the document
  step2Head: "2 · Host the document",
  ready: "Document ready",
  problemsTitle: "Not a valid CIP-179 survey link:",
  linksToSurvey: "Links to survey",
  /** {index} is a raw index number (not translated). */
  refIndex: " · index {index}",
  /**
   * The no-pinning hint wraps a Settings link, so it's split into prose
   * fragments around it.
   */
  hostHintPre:
    "Host these exact bytes at a public URL (a GitHub raw link, or add an IPFS provider in ",
  hostHintPost: " to pin from here), then paste the URL below.",
  settingsLinkText: "Settings",
  pinHint:
    "Pin to the IPFS providers configured in your Settings, in one click. The exact bytes below are pinned, so the served document matches the on-chain hash.",
  pinning: "Pinning…",
  pinToIpfs: "Pin to IPFS",
  downloadJsonld: "Download .jsonld",
  copiedHash: "Copied hash ✓",
  copyAnchorHash: "Copy anchor hash",
  /** {providers} is a comma-joined list of provider names (not translated). */
  pinnedNote: "Pinned to {providers}. URL filled in below.",
  anchorHashLabel: "Anchor hash (blake2b-256)",
  urlPlaceholder: "ipfs://… or https://…/info-action-survey-link.jsonld",
  urlHint:
    "Auto-filled when you pin to IPFS above; otherwise paste where you hosted the document. Stored on-chain alongside its hash.",
  /**
   * Wraps two inline mono scheme tokens ("ipfs://" and "https://"), so it's
   * split into prose fragments around them — the tokens aren't translated.
   */
  urlInvalidPre: "The anchor URL must be an ",
  urlInvalidMid: " or ",
  urlInvalidPost: " address — this one will be rejected before signing.",

  // Step 3 · Sign & submit
  step3Head: "3 · Sign & submit",
  submitSectionNote:
    "Tessera builds and submits an Info Action. For any other action kind, download the document and attach its URL and hash with your own tooling.",
  connectWallet: "Connect a CIP-30 wallet (top-right) to sign the proposal.",
  /** {network} is the configured network name, e.g. "mainnet" (not translated). */
  networkMismatch:
    "Your wallet is on a different network than the app ({network}). Switch it before submitting.",
  resolveIssues:
    "Resolve the issues above before submitting — the action wouldn't be a valid CIP-179 survey link.",
  building: "Building & signing…",
  submit: "Build, sign & submit",
  submittedTitle: "Proposal submitted ✓",
  submittedHint:
    "Once it's in a block, the survey page will show it as “Linked to governance” after the indexer resolves the anchor.",
};

export type Messages = typeof linkSurvey;
export default linkSurvey;
