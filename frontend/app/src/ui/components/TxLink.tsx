/** A monospace transaction hash that links out to the Cardano Explorer. */

import type { Component } from "solid-js";
import { useApp } from "~/state";
import { explorerTxUrl } from "~/ui/format";
import css from "./TxLink.module.css";

export const TxLink: Component<{
  hash: string;
  /** Link colour; defaults to inheriting the surrounding text colour. */
  color?: string;
}> = (props) => {
  const app = useApp();
  return (
    <a
      href={explorerTxUrl(app.config.network, props.hash)}
      target="_blank"
      rel="noopener noreferrer"
      title="View transaction on the Cardano Explorer"
      class={css.link}
      style={props.color ? { "--tx-color": props.color } : undefined}
    >
      tx {props.hash}
    </a>
  );
};
