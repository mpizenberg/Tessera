import { type Component, type JSX } from "solid-js";
import css from "./Spinner.module.css";

/**
 * A small spinning ring — the shared pending/loading glyph. Reuses the global
 * `spin` keyframe (theme.css). Sized in px; renders as an inline-block so it
 * sits inline with text and as a flex item in button rows.
 */
export const Spinner: Component<{
  size?: number;
  style?: JSX.CSSProperties;
}> = (props) => (
  <span
    class={css.ring}
    style={{
      width: `${props.size ?? 16}px`,
      height: `${props.size ?? 16}px`,
      ...props.style,
    }}
  />
);
