import type { Component, JSX } from "solid-js";

import { TxLink } from "./TxLink";
import css from "./TxNotice.module.css";

/**
 * A cancellation outcome, headed by the transaction that carried it: the
 * owner's just-submitted withdrawal, and the withdrawal a finalized artifact
 * records.
 */
export const TxNotice: Component<{
  title: string;
  hash: string;
  body: JSX.Element;
}> = (props) => (
  <div class={css.notice}>
    <div class={css.title}>{props.title}</div>
    <div class={css.hash}>
      <TxLink hash={props.hash} color="var(--danger-ink)" />
    </div>
    <div class={css.body}>{props.body}</div>
  </div>
);
