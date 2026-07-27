/**
 * Dev-only reference host for the embeddable `<tessera-respond>` widget.
 * It embeds the custom element exactly as a third-party integrator
 * would — object-valued props set as DOM **properties**, `tessera:*` events
 * consumed with `addEventListener` — and closes the loop the widget deliberately
 * leaves to the host: mapping the emitted `proveCredentials` to
 * `required_signers` and signing + submitting through the connected wallet.
 *
 * It is the living copy-paste example (linked from the widget README) and the
 * sole owner of the **real-on-chain** end-to-end test: without a wallet it shows
 * everything up to the emitted payload (logged in the side panel); with a CIP-30
 * wallet on a live network it runs the full sign-and-submit leg via
 * `app.submitMetadata` (the same write path the built-in Respond screen uses).
 *
 * Registered only under `import.meta.env.DEV` (see App.tsx), so this second copy
 * of the answering UI never ships to production. The widget itself is consumed
 * from workspace source (a single shared Solid instance) — the offline
 * built-artifact smoke test lives in the widget package; this page
 * exercises the same source against real chain data.
 */

// Side-effect import: registers the `<tessera-respond>` custom element. Guarded
// against duplicate definition by component-register, so it is HMR-safe.
import "@tessera/respond-widget/element";

import {
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import type { SurveyDefinition, SurveyRef, SurveyResponse } from "cip-179";
import { dedupeResponses, findSurvey } from "cip-179/domain";
import { findExistingResponse } from "@tessera/respond-core";
import type {
  Responder,
  RespondChangeDetail,
  RespondInvalidDetail,
  RespondResult,
} from "@tessera/respond-widget";

import { useApp } from "~/state";
import {
  respondableRoles,
  roleCredential,
  walletResponder,
} from "~/domain/roles";
import { usePresentation } from "~/enrichment/usePresentation";
import { networkMismatch, shortRef } from "~/ui/format";
import { TxLink } from "~/ui/components/TxLink";
import { locale } from "~/i18n";
import css from "./DevWidgetHost.module.css";

// `<tessera-respond>` is a custom element, not a known intrinsic — declare it so
// JSX type-checks. Object props flow in via `el.*` assignment below, not JSX
// attributes, so a bare `HTMLAttributes` (which carries `ref`) is all we need.
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "tessera-respond": JSX.HTMLAttributes<HTMLElement>;
    }
  }
}

/** The subset of `<tessera-respond>` DOM properties this host writes. */
type RespondElement = HTMLElement & {
  definition?: SurveyDefinition | undefined;
  surveyRef?: SurveyRef | undefined;
  responder?: Responder | undefined;
  tipEpoch?: number | undefined;
  cancelled?: boolean | undefined;
  priorResponses?: readonly SurveyResponse[] | undefined;
  locale?: string | undefined;
  layout?: ("one-per-screen" | "list") | undefined;
};

const DevWidgetHost: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);

  // Survey lookup mirrors the built-in Respond/Survey screens: the indexed list
  // first, falling back to the optimistic set so a just-created survey works.
  const indexed = createMemo(() => {
    const snap = app.list.error ? undefined : app.list();
    return snap ? findSurvey(snap.surveys, key()) : undefined;
  });
  const survey = createMemo(
    () => indexed() ?? app.optimisticSurveys().find((a) => a.key === key()),
  );

  // The survey's own bundle carries the raw responses — needed only to prefill
  // an edit/replace flow (a prior public response). Best-effort, like Respond.
  const [bundle] = createResource(
    () => indexed()?.record.ref,
    (ref) => app.source.surveyBundle(ref),
  );

  // Host owns enrichment: pass the widget an already-enriched (display)
  // definition, falling back to the on-chain one — exactly what the app holds.
  const pres = usePresentation(() => survey()?.record.definition);
  const definition = (): SurveyDefinition | undefined => pres.def();

  const identity = () => app.wallet()?.identity ?? null;
  // Widget responder = the wallet's role→credential map. SPO/CC would be extra
  // entries a host with those cold keys adds; a browser wallet holds none, so
  // the wallet-derived map is all we have here.
  const responder = createMemo<Responder | null>(() => {
    const id = identity();
    return id ? walletResponder(id) : null;
  });

  const tipEpoch = (): number | undefined =>
    (app.list.error ? undefined : app.list())?.tip.epoch;

  const cancelled = (): boolean => Boolean(survey()?.cancelled);

  // Roles this wallet may claim here — the widget picks one internally, so the
  // host resolves a prior response for each of them.
  const respondable = createMemo(() => {
    const def = definition();
    const id = identity();
    return def && id ? respondableRoles(def, id) : [];
  });

  // The responder's prior public response for *each* role it can claim here, so
  // the widget re-prefills as the user switches roles. One deduped set, filtered
  // per role by the wallet's own credential (the built-in Respond screen does
  // the same, just for its single currently-selected role).
  const priorResponses = createMemo<SurveyResponse[]>(() => {
    const b = bundle.error ? undefined : bundle();
    const s = survey();
    const id = identity();
    if (!b || !s || !id) return [];
    const mine = dedupeResponses(b.responses).map((x) => x.response);
    return respondable().flatMap((r) => {
      const cred = roleCredential(id, r);
      const prior = cred
        ? findExistingResponse(mine, s.record.ref, r, cred)
        : undefined;
      return prior ? [prior] : [];
    });
  });

  // Network conformance is the host's job — the widget never sees a network id.
  const mismatch = (): boolean =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  const [layout, setLayout] = createSignal<"one-per-screen" | "list">(
    "one-per-screen",
  );

  // --- element wiring ------------------------------------------------------
  const [el, setEl] = createSignal<RespondElement | undefined>();

  // Reflect every prop onto the element as a DOM property — the same thing a
  // vanilla-JS host does (`el.definition = …`). Re-setting an unchanged object
  // reference is a no-op inside the widget (its signals dedupe by identity), so
  // one effect for all props is safe.
  createEffect(() => {
    const node = el();
    if (!node) return;
    node.definition = definition();
    node.surveyRef = survey()?.record.ref;
    node.responder = responder() ?? undefined;
    node.tipEpoch = tipEpoch();
    node.cancelled = cancelled();
    node.priorResponses = priorResponses();
    node.locale = locale();
    node.layout = layout();
  });

  // --- emitted-event handling ----------------------------------------------
  const [change, setChange] = createSignal<RespondChangeDetail | null>(null);
  const [invalid, setInvalid] = createSignal<RespondInvalidDetail | null>(null);
  const [result, setResult] = createSignal<RespondResult | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  createEffect(() => {
    const node = el();
    if (!node) return;
    const onResponse = (e: Event): void => {
      const detail = (e as CustomEvent<RespondResult>).detail;
      setResult(detail);
      void submit(detail);
    };
    const onChange = (e: Event): void => {
      setChange((e as CustomEvent<RespondChangeDetail>).detail);
    };
    const onInvalid = (e: Event): void => {
      setInvalid((e as CustomEvent<RespondInvalidDetail>).detail);
    };
    node.addEventListener("tessera:response", onResponse);
    node.addEventListener("tessera:change", onChange);
    node.addEventListener("tessera:invalid", onInvalid);
    onCleanup(() => {
      node.removeEventListener("tessera:response", onResponse);
      node.removeEventListener("tessera:change", onChange);
      node.removeEventListener("tessera:invalid", onInvalid);
    });
  });

  // The whole point of the host: turn an emitted payload into a signed tx. Map
  // `proveCredentials` → `required_signers` (their `.credential`), then sign and
  // submit via the wallet — the widget itself never touches a wallet or chain.
  const submit = async (r: RespondResult): Promise<void> => {
    if (mismatch()) {
      setSubmitError(
        `Wallet is on the wrong network — switch to ${app.config.network} before submitting.`,
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const creds = r.proveCredentials.map((p) => p.credential);
      const hash = await app.submitMetadata(r.payload, creds);
      setTxHash(hash);
      app.trackTx({ txHash: hash, kind: "response", surveyKey: key() });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class={css.page}>
      <A href={`/survey/${encodeURIComponent(key())}`} class={css.back}>
        <span class={css.backArrow}>←</span> Back to survey
      </A>

      <div class={css.devBanner}>
        <span class={css.devTag}>DEV</span>
        <div class={css.devBannerBody}>
          <strong>Reference host</strong> for the embeddable{" "}
          <code>&lt;tessera-respond&gt;</code> widget. This page embeds the
          custom element and wires it the way an integrator would: it sets the
          survey props, listens for <code>tessera:response</code>, maps{" "}
          <code>proveCredentials</code> to <code>required_signers</code>, and
          signs + submits through your wallet. The built-in{" "}
          <A href={`/survey/${encodeURIComponent(key())}/respond`}>
            Respond screen
          </A>{" "}
          answers the same survey without the widget.
        </div>
      </div>

      <Show
        when={survey()}
        fallback={
          <Empty
            loading={app.list.loading}
            error={app.list.error}
            onRetry={() => app.reload()}
          />
        }
      >
        <Show
          when={txHash() === null}
          fallback={<Submitted hash={txHash()!} surveyKey={key()} />}
        >
          <div class={css.controls}>
            <span class={css.controlsLabel}>Layout</span>
            <button
              class={css.controlBtn}
              classList={{ [css.controlBtnOn]: layout() === "one-per-screen" }}
              onClick={() => setLayout("one-per-screen")}
            >
              Stepper
            </button>
            <button
              class={css.controlBtn}
              classList={{ [css.controlBtnOn]: layout() === "list" }}
              onClick={() => setLayout("list")}
            >
              List
            </button>
          </div>

          <div class={css.split}>
            <div class={css.widgetFrame}>
              <Show
                when={responder()}
                fallback={
                  <div class={css.connectPrompt}>
                    Connect a wallet from the header to answer as your on-chain
                    identity — the host supplies the responder, the widget never
                    touches a wallet.
                  </div>
                }
              >
                {/* The embedded custom element. Props flow in via the effect
                    above (DOM properties); events out via addEventListener. */}
                <tessera-respond ref={setEl} />
              </Show>
            </div>

            <aside class={css.panel}>
              <h2 class={css.panelTitle}>Integration log</h2>

              <Show when={mismatch()}>
                <div class={css.panelWarn}>
                  Wallet network ≠ {app.config.network}. Submission is blocked
                  by the host (the widget never sees the network).
                </div>
              </Show>
              <Show when={submitError()}>
                <div class={css.panelError}>{submitError()}</div>
              </Show>
              <Show when={submitting()}>
                <div class={css.panelNote}>Signing &amp; submitting…</div>
              </Show>

              <LogBlock
                label="tessera:change"
                empty="(edit an answer)"
                value={change()}
              />
              <LogBlock
                label="tessera:invalid"
                empty="(none)"
                value={invalid()}
              />
              <LogBlock
                label="tessera:response"
                empty="(submit to emit)"
                value={result()}
              />
            </aside>
          </div>
        </Show>
      </Show>
    </main>
  );
};

export default DevWidgetHost;

// ----------------------------------------------------------------------------
// Small bits
// ----------------------------------------------------------------------------

/** One labelled, pretty-printed event payload in the integration log. */
const LogBlock: Component<{
  label: string;
  empty: string;
  value: unknown;
}> = (props) => (
  <div class={css.logBlock}>
    <div class={css.logLabel}>{props.label}</div>
    <pre class={css.logBody}>
      {props.value === null || props.value === undefined
        ? props.empty
        : stringify(props.value)}
    </pre>
  </div>
);

/** JSON with bigint / Uint8Array made readable (payloads carry both). */
function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return `${v}n`;
      if (v instanceof Uint8Array) {
        return `0x${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      }
      return v;
    },
    2,
  );
}

const Submitted: Component<{ hash: string; surveyKey: string }> = (props) => (
  <div class={css.submitted}>
    <span class={css.submittedCheck}>✓</span>
    <h3 class={css.submittedTitle}>Response submitted</h3>
    <p class={css.submittedText}>
      The host built, signed, and submitted the transaction the widget emitted.
    </p>
    <div class={css.submittedTx}>
      <TxLink hash={props.hash} />
    </div>
    <A
      href={`/survey/${encodeURIComponent(props.surveyKey)}`}
      class={css.submittedLink}
    >
      View survey ({shortRef(props.surveyKey)}) →
    </A>
  </div>
);

const Empty: Component<{
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
}> = (props): JSX.Element => (
  <div class={css.empty}>
    <Show
      when={props.error}
      fallback={props.loading ? "Loading survey…" : "Survey not found."}
    >
      <div class={css.emptyError}>Couldn't load the survey list.</div>
      <button type="button" onClick={() => props.onRetry?.()} class={css.retry}>
        Retry
      </button>
    </Show>
  </div>
);
