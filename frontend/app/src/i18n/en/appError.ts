const appError = {
  title: "Couldn't load on-chain data",
  /**
   * One body per read path, because the advice differs: {error} is the raw
   * failure message (e.g. "Indexer https://… → 503", "Koios GET /tip → 403")
   * and {url} the backend this build reads from.
   */
  bodyBackend:
    "The app couldn't read from the Tessera backend at {url}: {error}",
  bodyKoios: "The app couldn't read from Koios: {error}",
  backendHint:
    "The backend may be unreachable or mid-deploy. Retry; if it keeps failing, Settings offers emergency direct mode so you can keep participating via Koios.",
  tokenHint:
    "Your Koios API token may be invalid or rate-limited. Set your own in Settings, then retry.",
  retry: "Retry",
  openSettings: "Open Settings",
};

export type Messages = typeof appError;
export default appError;
