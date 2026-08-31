/** "Propose a survey Info Action" screen — see ./index.ts for the convention. */

const proposeInfoAction = {
  // Header / lead
  backToSurveys: "All surveys",
  govPill: "Governance",
  title: "Propose a survey Info Action",
  /**
   * The lead wraps two inline-styled technical tokens (a bold "Info Action" and
   * a mono "gov_action_deposit"), so it's split into prose fragments around them
   * — the tokens themselves aren't translated.
   */
  leadPre: "Build and sign a Conway ",
  leadMid:
    " that advertises a CIP-179 survey. The action carries no on-chain effect — it only points voters at the survey via its anchor. A refundable ",
  leadPost:
    " is taken from your wallet and returned to your stake address when the action is ratified or expires (your wallet shows the exact amount before you sign).",

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

  // Section notes framing the generic vs Info-Action-specific halves.
  genericSectionNote:
    "These steps prepare the anchor and are the same for any governance action kind. Building a different action with your own tooling? Follow them to get a validated document, its hash, and a hosted URL to reference from your action.",
  submitSectionNote:
    "This last step is specific to Info Actions — the one action kind Tessera builds and submits for you.",

  // Step 1 · Load the anchor
  step1Head: "1 · Load the anchor document",
  /**
   * The hint wraps two inline mono tokens (".jsonld" and "body.cip179"), so it's
   * split into prose fragments around them — the tokens aren't translated.
   */
  loadHintPre: "Choose the CIP-108 anchor ",
  loadHintMid: " file (its ",
  loadHintPost:
    " carries the survey link). It's read locally — the on-chain hash is taken over the file's exact bytes, so they're never re-formatted.",

  // Step 1b · Loaded document
  loaded: "Loaded",
  problemsTitle: "Not a valid CIP-179 survey link:",
  linksToSurvey: "Links to survey",
  /** {index} is a raw index number (not translated). */
  refIndex: " · index {index}",
  /**
   * The on-chain line wraps the survey title in a styled <b>, so it's split into
   * prose fragments around it. {endEpoch} is a raw epoch number (not translated).
   */
  onchainPre: "On-chain: ",
  onchainPost: " · end_epoch {endEpoch}",
  untitledSurvey: "Untitled survey",
  /**
   * The no-pinning hint wraps a Settings link, so it's split into prose
   * fragments around it.
   */
  hostHintPre:
    "Host these exact bytes at a public URL (a GitHub raw link, or add an IPFS provider in ",
  hostHintPost: " to pin from here), then paste the URL in step 2.",
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

  // Step 2 · Anchor URL
  step2Head: "2 · Anchor URL",
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
  connectWallet: "Connect a CIP-30 wallet (top-right) to sign the proposal.",
  /** {network} is the configured network name, e.g. "mainnet" (not translated). */
  networkMismatch:
    "Your wallet is on a different network than the app ({network}). Switch it before submitting.",
  resolveIssues:
    "Resolve the validation issues in step 1 before submitting — the action wouldn't be a valid CIP-179 survey link.",
  building: "Building & signing…",
  submit: "Build, sign & submit",
  submittedTitle: "Proposal submitted ✓",
  submittedHint:
    "Once it's in a block, the survey page will show it as “Linked to governance” after the indexer resolves the anchor.",
};

export type Messages = typeof proposeInfoAction;
export default proposeInfoAction;
