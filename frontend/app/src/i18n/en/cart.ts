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
    "Each transaction is signed in turn; nothing is submitted until all of them are.",
  connectWallet: "Connect a wallet to publish what you queued.",

  // What a screen shows once it queued an action instead of publishing it.
  addToCart: "Add to cart",
  queuedTitle: "Added to your cart",
  queuedBody:
    "It will be published with the rest of what you queued, batched into as few transactions as CIP-179 allows.",
  queuedOpen: "Open the cart",

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
