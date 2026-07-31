/** The cart: queued actions, their transaction plan, and in-flight transactions. */

const cart = {
  // Header badge + drawer chrome.
  open: "Queued and in-flight actions",
  queuedHeading: "Waiting to be published",
  inFlightHeading: "On its way",

  // A queued action, by kind; the survey it concerns is shown beneath it.
  queuedSurvey: "Publish a survey",
  queuedResponse: "Answer a survey",
  queuedCancel: "Cancel a survey",
  queuedGovAction: "Advertise a survey on-chain",
  remove: "Remove",

  // Partition preview: how the queue becomes transactions.
  planPending: "Working out the transactions…",
  /** {n} is the 1-based transaction number. */
  planTx: "Transaction {n}",
  planChained:
    "Spends an output of the transaction publishing its survey, so the two land together or not at all.",
  planNote:
    "CIP-179 allows one kind of event per transaction; the rest is batched to save fees.",
  /** {credential} is a key hash the connected wallet does not hold. */
  planMissingSignature:
    "Needs a signature from {credential} — connect that wallet before publishing.",

  // Publishing.
  submit: "Sign & publish",
  submitting: "Publishing…",
  submitHint:
    "Each transaction is signed and sent in turn, so the next one can build on it.",
  connectWallet: "Connect a wallet to publish what you queued.",

  // Gathering signatures: the chain is built and waits for the keys it needs.
  signingHeading: "Being published",
  /** {credential} is a key hash no witness has been produced for yet. */
  signMissing: "Waiting for a signature from {credential}.",
  signHeldHere: "The connected wallet holds this key.",
  signComplete: "Signed.",
  signSwitchWallet:
    "Connect the wallet holding each key and sign again — disconnecting keeps the signatures already gathered. Each transaction is sent as soon as it holds every signature it needs, and the ones behind it wait for it.",
  signWithWallet: "Sign with this wallet",
  signingNow: "Signing…",
  publish: "Publish",
  discard: "Discard",
  discardHint:
    "Discarding throws away the transactions still waiting and the signatures gathered for them; what they publish stays in your cart.",

  // What a screen shows once it queued an action instead of publishing it.
  addToCart: "Add to cart",
  queuedTitle: "Added to your cart",
  queuedBody:
    "It will be published with the rest of what you queued, batched into as few transactions as CIP-179 allows.",
  queuedSurveyBody:
    "It will be published with the rest of what you queued, batched into as few transactions as CIP-179 allows. A survey has no identity until its transaction is built, so this one cannot be found or answered before you publish it — and once you do, you can answer it straight away, without waiting for it to be confirmed.",
  queuedOpen: "Open the cart",
  signingTitle: "Your cart is being published",
  signingBody:
    "Its transactions are built and waiting to go out, so the cart can't take anything else until they do — or you discard them. Open it to see what is left to do.",

  // In-flight rows (transactions submitted, chain not yet showing them).
  /** Appended to an in-flight headline; {label} is the action description. */
  pendingHeadline: "{label}…",
  pendingSurvey: "Publishing survey",
  pendingResponse: "Submitting response",
  pendingCancel: "Cancelling survey",
  pendingGovAction: "Submitting governance action",
  confirmedSurvey: "Survey published",
  confirmedResponse: "Response confirmed",
  confirmedCancel: "Survey cancelled",
  confirmedGovAction: "Governance action submitted",
  dismiss: "Dismiss",
  stalled: "No block has included this transaction in the last 10 minutes.",
  stalledChoice:
    "Broadcast it again, or forget it — forgetting returns what it publishes to your cart, but the transaction itself can still be included later.",
  rebroadcast: "Broadcast again",
  rebroadcasting: "Broadcasting…",
  forget: "Forget",
  viewSurvey: "View survey →",
};

export type Messages = typeof cart;
export default cart;
