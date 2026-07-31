/** Sticky top header: nav, network tag, Plain/Pro toggle, wallet identity, pending txs. */

const header = {
  // Primary navigation.
  navExplore: "Explore",
  navCreate: "Create",
  navSettings: "Settings",

  // Network tag in the bar.
  activeNetwork: "Active network",

  // Pending-transactions dropdown.
  pendingTransactions: "Pending transactions",
  dismiss: "Dismiss",
  /** Appended to an in-flight pending headline; {label} is the action description. */
  pendingHeadline: "{label}…",
  pendingSurvey: "Publishing survey",
  pendingResponse: "Submitting response",
  pendingCancel: "Cancelling survey",
  pendingGovAction: "Submitting governance action",
  confirmedSurvey: "Survey published",
  confirmedResponse: "Response confirmed",
  confirmedCancel: "Survey cancelled",
  confirmedGovAction: "Governance action submitted",
  stalled: "No block has included this transaction in the last 10 minutes.",
  stalledChoice:
    "Broadcast it again, or forget it — forgetting only stops this app from tracking it, and the transaction can still be included later.",
  rebroadcast: "Broadcast again",
  rebroadcasting: "Broadcasting…",
  forget: "Forget",
  viewSurvey: "View survey →",

  // Plain/Pro display-mode toggle.
  displayMode: "Display mode",
  displayPlain: "Plain",
  displayPro: "Pro",

  // Connect / identity button.
  connecting: "Connecting…",
  connectWallet: "Connect wallet",
  noRole: "No role",

  // Wallet picker.
  connectCip30: "Connect a CIP-30 wallet",
  noWalletDetected: "No CIP-30 wallet detected in this browser.",

  // Role menu.
  respondAs: "Respond as · 1 wallet",
  noClaimableRole:
    "This wallet holds no claimable role: responding in the browser needs a key-based credential, and this wallet's are script-based.",
  /** {network} is the app's expected network identifier (preview/mainnet). */
  networkMismatch:
    "Wallet is on a different network than the app ({network}). Switch networks in your wallet.",
  disconnect: "Disconnect",

  // Network section (one network per deployment; a link opens the other app).
  network: "Network",
  oneNetworkNote: "One network per deployment.",
};

export type Messages = typeof header;
export default header;
