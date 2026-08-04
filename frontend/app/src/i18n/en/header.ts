/** Sticky top header: nav, network tag, Plain/Pro toggle, wallet identity. */

const header = {
  // Primary navigation.
  navExplore: "Explore",
  navCreate: "Create",
  navSettings: "Settings",

  // Network tag in the bar.
  activeNetwork: "Active network",

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
  /** {network} is the app's expected network identifier. */
  networkMismatch:
    "Wallet is on a different network than the app ({network}). Switch networks in your wallet.",
  disconnect: "Disconnect",

  // Network section (one network per deployment; links open other apps).
  network: "Network",
  oneNetworkNote: "One network per deployment.",
};

export type Messages = typeof header;
export default header;
