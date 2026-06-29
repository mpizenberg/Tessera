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
  pendingSlow: "Taking longer than usual — still pending.",
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
    "This wallet holds no claimable role (needs a stake key or a registered DRep key).",
  /** {network} is the app's expected network identifier (preview/mainnet). */
  networkMismatch:
    "Wallet is on a different network than the app ({network}). Switch networks in your wallet.",
  disconnect: "Disconnect",

  // Network switch.
  network: "Network",
  switchingReloads: "Switching reloads on Explore.",
};

export type Messages = typeof header;
export default header;
