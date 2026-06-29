/** Monospace transaction-hash link out to the Cardano Explorer. */

const txLink = {
  /** Tooltip on the link. */
  title: "View transaction on the Cardano Explorer",
  /** Visible label; {hash} is the raw tx hash, left untranslated. */
  label: "tx {hash}",
};

export type Messages = typeof txLink;
export default txLink;
