/**
 * Registers the `<tessera-respond>` custom element: `solid-element`
 * turns the prop-defaults map below into reactive DOM properties (each with a
 * hyphenated attribute alias, so `locale`/`layout`/`tip-epoch` also work as
 * plain attributes), renders {@link RespondRoot} into an open shadow root, and
 * this wrapper adopts the widget stylesheet into that root.
 *
 * Object-valued props (`definition`, `responder`, `surveyRef`, …) must be set
 * as element *properties*. Until the required ones are all present the element
 * renders nothing — a `<tessera-respond>` written in HTML upgrades (and
 * connects) before the host's script assigns its data.
 *
 * This module is the lib-build entry and the published package's whole
 * surface: importing it registers the element; the exports are the prop/event
 * contract plus {@link RESPOND_EVENTS}. The Solid composables (`RespondRoot`,
 * `adoptWidgetStyles`, …) stay on the workspace-internal root entry — exposing
 * them here would put `solid-js` types in the published d.ts and saddle
 * artifact consumers with a peer they don't have.
 */

import { customElement } from "solid-element";
import { Show } from "solid-js";

import { RespondRoot } from "./Respond";
import { adoptWidgetStyles } from "./styles";
import type { TesseraRespondElementProps, TesseraRespondProps } from "./types";

export { RESPOND_EVENTS } from "./types";
export type {
  ConditionOption,
  CredentialProof,
  DisplayCondition,
  DisplayConditions,
  DraftStash,
  NoneLabels,
  ProofKeyKind,
  QuestionTranslation,
  Responder,
  RespondChangeDetail,
  RespondInvalidDetail,
  RespondResult,
  SurveyTranslation,
  SurveyTranslations,
  TesseraRespondElement,
  TesseraRespondElementProps,
  TesseraRespondProps,
} from "./types";
export type {
  ContentAnchor,
  Credential,
  Metadatum,
  Role,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
  ValidationProblem,
} from "cip-179";
export type {
  DeepPartial,
  RespondMessages,
} from "cardano-tessera-respond-core";

/**
 * Every public prop, declared up-front with its pre-initialization value —
 * solid-element only wires reactivity (and attribute observation) for keys
 * present in this map.
 */
const defaults: TesseraRespondElementProps = {
  definition: undefined,
  surveyRef: undefined,
  responder: undefined,
  tipEpoch: undefined,
  cancelled: false,
  priorResponses: undefined,
  rationaleAnchor: undefined,
  locale: "en",
  messages: undefined,
  theme: undefined,
  layout: "one-per-screen",
  initialRole: undefined,
  showRole: true,
  maxTextBytes: undefined,
  hiddenSchemas: undefined,
  stash: undefined,
  translations: undefined,
  noneLabels: undefined,
  conditions: undefined,
  keyboardShortcuts: true,
};

// Registration reaches for `window.customElements`; guarded so an SSR host
// (SvelteKit, Next) can import this module server-side as a no-op and let the
// client-side pass register. (The Solid compile keeps the rest of the module
// window-free: see the delegateEvents note in vite.config.ts.)
if (typeof window !== "undefined") {
  customElement<TesseraRespondElementProps>(
    "tessera-respond",
    defaults,
    (props, { element }) => {
      adoptWidgetStyles(element.renderRoot as ShadowRoot);
      const ready = () =>
        props.definition !== undefined &&
        props.surveyRef !== undefined &&
        props.responder !== undefined &&
        props.tipEpoch !== undefined;
      // component-register parses a valueless attribute ("") to `undefined`,
      // so idiomatic HTML `<tessera-respond cancelled>` would silently fail
      // *open*. Normalize: when the prop is unset, attribute presence means
      // cancelled.
      const cancelled = () =>
        props.cancelled ?? element.hasAttribute("cancelled");
      return (
        <Show when={ready()}>
          <RespondRoot
            {...(props as unknown as TesseraRespondProps)}
            cancelled={cancelled()}
          />
        </Show>
      );
    },
  );
}
