import { For, Show, type Component } from "solid-js";

import { roleAbbr, roleColors, type ViewStatus } from "~/ui/format";
import css from "./glyphs.module.css";

/** 3×3 "Form" mosaic — one filled tile per question, capped at 9. */
export const FormMosaic: Component<{ count: number; size?: number }> = (
  props,
) => {
  const on = () => Math.max(0, Math.min(props.count, 9));
  return (
    <span
      class={css.mosaic}
      style={
        props.size !== undefined ? { "--size": `${props.size}px` } : undefined
      }
    >
      <For each={Array.from({ length: 9 }, (_, i) => i)}>
        {(i) => <span class={i < on() ? css.tileOn : css.tile} />}
      </For>
    </span>
  );
};

/** Visibility glyph: lock = sealed, ring = public/ended, dash = cancelled. */
export const VisGlyph: Component<{ status: ViewStatus }> = (props) => (
  <Show
    when={props.status === "sealed"}
    fallback={<RingOrDash status={props.status} />}
  >
    <span class={css.lock}>
      <span class={css.lockShackle} />
      <span class={css.lockBody} />
    </span>
  </Show>
);

const RingOrDash: Component<{ status: ViewStatus }> = (props) => (
  <Show
    when={props.status !== "cancelled"}
    fallback={<span class={css.dash} />}
  >
    <span
      class={css.ring}
      classList={{ [css.ringEnded]: props.status === "ended" }}
    />
  </Show>
);

/** Up to three colored role chips, with a "+N" overflow chip. */
export const RoleChips: Component<{ roles: readonly number[] }> = (props) => {
  const shown = () => props.roles.slice(0, 3);
  const overflow = () => props.roles.length - 3;
  return (
    <div class={css.chips}>
      <For each={shown()}>
        {(r) => {
          const [color, bg] = roleColors(r);
          return (
            <span
              class={css.chip}
              style={{ "--chip-color": color, "--chip-bg": bg }}
            >
              {roleAbbr(r)}
            </span>
          );
        }}
      </For>
      <Show when={overflow() > 0}>
        <span class={css.overflow}>+{overflow()}</span>
      </Show>
    </div>
  );
};
