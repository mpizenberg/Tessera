import { For, type JSX } from "solid-js";
import css from "./SegmentedToggle.module.css";

export interface SegOption<T extends string> {
  readonly value: T;
  readonly label: JSX.Element;
}

/**
 * The warm pill-track segmented toggle used across the app (Plain/Pro, network,
 * on-chain preview view, rationale mode). One selected segment is clay-filled;
 * the rest are transparent. Renders as a `role="group"` of `aria-pressed`
 * toggle buttons. Sizing (font/padding) and wrapper layout differ slightly per
 * site, so those are knobs; the colors/shape/semantics are shared.
 */
export function SegmentedToggle<T extends string>(props: {
  readonly options: readonly SegOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Per-button font-size in px (default 11.5). */
  readonly fontSize?: number;
  /** Per-button padding (default "5px 12px"). */
  readonly buttonPadding?: string;
  /** Padding of the track around the buttons (default "3px"). */
  readonly trackPadding?: string;
  /** Extra wrapper style for layout (margin, align-self, …). */
  readonly wrapStyle?: JSX.CSSProperties;
  readonly ariaLabel?: string;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={props.ariaLabel}
      class={css.track}
      style={{
        padding: props.trackPadding ?? "3px",
        ...props.wrapStyle,
      }}
    >
      <For each={props.options}>
        {(opt) => {
          const on = (): boolean => props.value === opt.value;
          return (
            <button
              type="button"
              aria-pressed={on()}
              onClick={() => props.onChange(opt.value)}
              class={css.btn}
              classList={{ [css.on]: on() }}
              style={{
                "font-size": `${props.fontSize ?? 11.5}px`,
                padding: props.buttonPadding ?? "5px 12px",
              }}
            >
              {opt.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
