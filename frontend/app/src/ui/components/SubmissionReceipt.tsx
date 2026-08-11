/**
 * The panel a flow ends on once its transaction is away — a survey published, a
 * response submitted. Wording and follow-on actions differ per flow; the shape
 * does not.
 */

import { For, Show, type Component } from "solid-js";

import { TxLink } from "./TxLink";
import css from "./SubmissionReceipt.module.css";

export interface ReceiptAction {
  readonly label: string;
  readonly onClick: () => void;
}

export const SubmissionReceipt: Component<{
  title: string;
  body: string;
  hash: string;
  /** Trailing text on the mono line, after the transaction link. */
  detail?: string;
  /** The first is the call to action; the rest render beside it, muted. */
  actions: readonly ReceiptAction[];
}> = (props) => (
  <div class={css.card}>
    <span class={css.tick}>✓</span>
    <h3 class={css.title}>{props.title}</h3>
    <p class={css.body}>{props.body}</p>
    <div class={css.ref}>
      <TxLink hash={props.hash} />
      <Show when={props.detail}>{(d) => <> · {d()}</>}</Show>
    </div>
    <div class={css.actions}>
      <For each={props.actions}>
        {(a, i) => (
          <button
            type="button"
            onClick={() => a.onClick()}
            class={i() === 0 ? css.primary : css.secondary}
          >
            {a.label}
          </button>
        )}
      </For>
    </div>
  </div>
);
