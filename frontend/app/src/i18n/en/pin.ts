/** Failures pinning a document to the IPFS providers set in Settings. */

const pin = {
  noProvider: "No IPFS provider configured — add a token in Settings.",
  /**
   * {detail} lists each provider's raw failure, untranslated
   * (e.g. "pinata: Pinata HTTP 503; nmkr: no CID in response").
   */
  allFailed: "Pinning to IPFS failed on every provider — {detail}",
  /** A provider's failure when its token lacks the separator; userId:apiKey is literal. */
  nmkrToken: "the token must read userId:apiKey",
};

export type Messages = typeof pin;
export default pin;
