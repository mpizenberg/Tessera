import { type Component, type JSX } from "solid-js";
import css from "./Note.module.css";

/** Semantic tone of a callout: success, caution, or error. */
export type NoteKind = "ok" | "warn" | "danger";

/**
 * A small toned callout box (used by the gov-action proposal flow for anchor
 * problems, epoch-alignment hints, and pin/submit results). Ink, background,
 * and border all derive from the matching semantic token set.
 */
export const Note: Component<{
  kind: NoteKind;
  /** Extra style for layout overrides (e.g. margin tweaks at a call site). */
  style?: JSX.CSSProperties;
  children: JSX.Element;
}> = (props) => (
  <div
    class={css.box}
    style={{
      color: `var(--${props.kind})`,
      background: `var(--${props.kind}-bg)`,
      border: `1px solid var(--${props.kind}-line)`,
      ...props.style,
    }}
  >
    {props.children}
  </div>
);
