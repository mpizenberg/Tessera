/** A button that puts a value on the clipboard and says so for a moment. */

import { Show, createSignal, onCleanup, type Component } from "solid-js";
import { t } from "~/i18n";
import css from "./CopyButton.module.css";

export const CopyButton: Component<{
  /** Read at the click. */
  text: string;
  label?: string;
  copiedLabel?: string;
  /** Replaces the default chip style. */
  class?: string;
}> = (props) => {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), 1500);
  };

  // Outside a secure context there is no clipboard; the value is on screen.
  return (
    <Show when={navigator.clipboard}>
      <button
        type="button"
        class={props.class ?? css.copy}
        onClick={() => void copy()}
      >
        {copied()
          ? (props.copiedLabel ?? t("copyButton.copied"))
          : (props.label ?? t("copyButton.copy"))}
      </button>
    </Show>
  );
};
