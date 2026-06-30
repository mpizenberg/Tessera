const appError = {
  title: "Couldn't load on-chain data",
  /** {error} is the raw failure message (e.g. "Koios GET /tip → 403"). */
  body: "The app couldn't read from Koios: {error}",
  tokenHint:
    "Your Koios API token may be invalid or rate-limited. Set your own in Settings, then retry.",
  retry: "Retry",
  openSettings: "Open Settings",
};

export type Messages = typeof appError;
export default appError;
