/**
 * React bindings for the `<tessera-respond>` custom element.
 *
 * Importing this module registers the element (a no-op without a DOM, so it is
 * SSR-safe). {@link TesseraRespond} closes the two gaps between React and
 * custom elements: React ≤18 writes unknown JSX props as HTML *attributes*
 * (the widget's object props must be DOM *properties*), and no React version
 * subscribes to `CustomEvent`s from JSX — so the component holds a ref and
 * does both itself, identically on React 18 and 19.
 */

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";

import "cardano-tessera-respond/artifact";
import { RESPOND_EVENTS } from "cardano-tessera-respond/artifact";
import type {
  RespondChangeDetail,
  RespondInvalidDetail,
  RespondResult,
  TesseraRespondElement,
  TesseraRespondElementProps,
  TesseraRespondProps as ElementProps,
} from "cardano-tessera-respond/artifact";

export type {
  CredentialProof,
  ProofKeyKind,
  Responder,
  RespondChangeDetail,
  RespondInvalidDetail,
  RespondResult,
  TesseraRespondElement,
} from "cardano-tessera-respond/artifact";

export interface TesseraRespondProps extends ElementProps {
  /** `tessera:response` — the user finalized a valid answer set; attach `detail.payload` at label 17 and submit. */
  onResponse?: (detail: RespondResult) => void;
  /** `tessera:change` — progress, for host-driven submit buttons. */
  onChange?: (detail: RespondChangeDetail) => void;
  /** `tessera:invalid` — a submit attempt failed validation. */
  onInvalid?: (detail: RespondInvalidDetail) => void;
  className?: string;
  id?: string;
  style?: CSSProperties;
}

// `satisfies` keeps this in lockstep with the element contract: a prop added
// to (or dropped from) the widget fails this package's type-check instead of
// silently never syncing.
const ELEMENT_PROPS = {
  definition: true,
  surveyRef: true,
  responder: true,
  tipEpoch: true,
  cancelled: true,
  priorResponses: true,
  rationaleAnchor: true,
  locale: true,
  messages: true,
  theme: true,
  layout: true,
  initialRole: true,
} as const satisfies Record<keyof ElementProps, true>;

const ELEMENT_PROP_KEYS = Object.keys(
  ELEMENT_PROPS,
) as readonly (keyof ElementProps)[];

function assign<K extends keyof ElementProps>(
  el: TesseraRespondElementProps,
  key: K,
  value: TesseraRespondElementProps[K],
): void {
  el[key] = value;
}

// Prop assignment must land before paint (or the widget flashes its empty
// pre-props state), but React warns on useLayoutEffect during server render.
const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type Callbacks = {
  [K in "onResponse" | "onChange" | "onInvalid"]:
    | TesseraRespondProps[K]
    | undefined;
};

/**
 * `<tessera-respond>` as a React component. The four required widget props
 * (`definition`, `surveyRef`, `responder`, `tipEpoch`) are required here too;
 * every prop is re-synced on each render (the widget ignores same-reference
 * writes). `ref` exposes the underlying {@link TesseraRespondElement}.
 */
export const TesseraRespond = forwardRef<
  TesseraRespondElement,
  TesseraRespondProps
>(function TesseraRespond(props, forwardedRef): ReactElement {
  const elRef = useRef<TesseraRespondElement>(null);
  useImperativeHandle(forwardedRef, () => elRef.current!, []);

  // Latest-callback refs: listeners attach once, yet always call the current
  // render's callbacks — swapping a callback never detaches mid-interaction.
  const callbacks = useRef<Callbacks>({
    onResponse: undefined,
    onChange: undefined,
    onInvalid: undefined,
  });
  useClientLayoutEffect(() => {
    callbacks.current = {
      onResponse: props.onResponse,
      onChange: props.onChange,
      onInvalid: props.onInvalid,
    };
  });

  useClientLayoutEffect(() => {
    const el = elRef.current;
    if (el === null) return;
    const listen = <D>(
      type: string,
      pick: (c: Callbacks) => ((detail: D) => void) | undefined,
    ): (() => void) => {
      const handler = (e: Event): void =>
        pick(callbacks.current)?.((e as CustomEvent<D>).detail);
      el.addEventListener(type, handler);
      return () => el.removeEventListener(type, handler);
    };
    const offs = [
      listen<RespondResult>(RESPOND_EVENTS.response, (c) => c.onResponse),
      listen<RespondChangeDetail>(RESPOND_EVENTS.change, (c) => c.onChange),
      listen<RespondInvalidDetail>(RESPOND_EVENTS.invalid, (c) => c.onInvalid),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useClientLayoutEffect(() => {
    const el = elRef.current;
    if (el === null) return;
    for (const key of ELEMENT_PROP_KEYS) assign(el, key, props[key]);
  });

  // `class`, not `className`: React 18 passes unknown props on custom
  // elements through as literal attributes (a `className="…"` attribute),
  // while both majors serialize `class` correctly.
  return createElement("tessera-respond", {
    ref: elRef,
    class: props.className,
    id: props.id,
    style: props.style,
  });
});
