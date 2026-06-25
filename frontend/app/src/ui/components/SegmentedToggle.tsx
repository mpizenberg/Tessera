import { For, type JSX } from "solid-js";

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
      style={{
        display: "inline-flex",
        "align-items": "center",
        background: "var(--toggle-bg)",
        border: "1px solid var(--toggle-line)",
        "border-radius": "9px",
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
              style={{
                "font-family": "inherit",
                "font-size": `${props.fontSize ?? 11.5}px`,
                "font-weight": on() ? "700" : "600",
                cursor: "pointer",
                border: "none",
                "border-radius": "7px",
                padding: props.buttonPadding ?? "5px 12px",
                background: on() ? "var(--accent)" : "transparent",
                color: on() ? "#fff" : "var(--toggle-text-off)",
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
