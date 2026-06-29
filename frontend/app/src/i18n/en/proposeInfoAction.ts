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

  // Epoch-alignment notes
  alignTipNotLoaded: "Chain tip not loaded yet — can't verify epoch alignment.",
  alignSurveyNotOnchain:
    "Linked survey isn't on-chain yet — can't verify its end_epoch. Make sure it's published and indexed.",
  alignLifetimeUnknown:
    "gov_action_lifetime is unknown — can't compute the voting deadline.",
  /** {epoch}/{end} are raw epoch numbers (not translated). */
  alignAligned:
    "Aligned — submitting now (epoch {epoch}) gives a voting deadline of epoch {end}, matching the survey's end_epoch.",
  alignTooEarly:
    "Too early — submit in epoch {submitEpoch} (in {remaining} more) to match the survey's end_epoch {end}. Submitting now would set the deadline to {deadline}.",
  alignWindowPassed:
    "Window passed — the survey ends at epoch {end}, so this action had to be submitted in epoch {submitEpoch}. Submitted now (epoch {epoch}) it would expire at {deadline} and can no longer link to that survey.",

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
