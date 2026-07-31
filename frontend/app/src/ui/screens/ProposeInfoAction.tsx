/**
 * Build, sign and submit a Conway governance **Info Action** proposal that
 * advertises a CIP-179 survey, using the connected CIP-30 wallet.
 *
 * The page is two halves. The first — {@link LinkAnchorSection} — is entirely
 * action-kind-independent: load a CIP-108 anchor whose `body.cip179` carries the
 * survey link, validate its shape and `@context`, hash the *exact bytes* that
 * get hosted, and check epoch alignment. Any survey can be linked from any
 * governance action kind (CIP-179 v5), so that half is a reusable widget: a user
 * building a different action with their own tooling walks away with a validated
 * document, its anchor hash, and a hosted URL to drop into their action.
 *
 * The second half is the only Info-Action-specific part: sign and submit the
 * Info Action (the one kind Tessera builds itself) with that anchor.
 */

import { Show, createSignal, type Component } from "solid-js";
import { A } from "@solidjs/router";

import { useApp } from "~/state";
import {
  LinkAnchorSection,
  type PreparedAnchor,
} from "~/ui/components/LinkAnchorSection";
import linkCss from "~/ui/components/LinkAnchorSection.module.css";
import { TxLink } from "~/ui/components/TxLink";
import { Note } from "~/ui/components/Note";
import { QueuedNote } from "~/ui/components/CartDrawer";
import { networkMismatch } from "~/ui/format";
import type { Action } from "~/wallet/action";
import { t } from "~/i18n";
import css from "./ProposeInfoAction.module.css";

export const ProposeInfoAction: Component = () => {
  const app = useApp();
  const [prepared, setPrepared] = createSignal<PreparedAnchor | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [queued, setQueued] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // A different anchor document invalidates a previous submission's outcome —
  // clear the stale success/error notes (url/pin edits keep the same document).
  const onPrepared = (p: PreparedAnchor | null) => {
    if (p?.anchor.hashHex !== prepared()?.anchor.hashHex) {
      setTxHash(null);
      setQueued(false);
      setError(null);
    }
    setPrepared(p);
  };

  const mismatch = () =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  const blocking = () => {
    const p = prepared();
    return !p || p.blocking || !p.urlValid;
  };

  // Queuing needs no wallet — only publishing does.
  const canQueue = () => !!prepared() && !blocking() && !busy();
  const canSubmit = () => canQueue() && !!app.wallet() && !mismatch();
  // With something already waiting, publishing would publish that too — so the
  // button queues instead, and the cart is where it all goes out.
  const queueing = () => app.cart().length > 0;

  const proposal = (p: PreparedAnchor): Action => {
    const ref = p.surveyRef;
    return {
      kind: "govAction",
      anchorUrl: p.url,
      anchorDataHash: p.anchor.hash,
      surveyKey: ref ? `${ref.txId}:${ref.index}` : undefined,
      title: p.linkedSurveyTitle,
      proveCredentials: [],
    };
  };

  const queue = () => {
    const p = prepared();
    if (!p || !canQueue()) return;
    app.enqueue([proposal(p)]);
    setQueued(true);
  };

  const submit = async () => {
    const p = prepared();
    if (!p || !canSubmit()) return;
    setBusy(true);
    setError(null);
    try {
      const hashes = await app.submitOrQueue([proposal(p)]);
      if (hashes) setTxHash(hashes[0] ?? null);
      else setQueued(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class={css.main}>
      <A href="/" class={css.backLink}>
        <span class={css.backArrow}>←</span>{" "}
        {t("proposeInfoAction.backToSurveys")}
      </A>

      <div class={css.titleRow}>
        <span class={css.govPill}>{t("proposeInfoAction.govPill")}</span>
        <h1 class={css.title}>{t("proposeInfoAction.title")}</h1>
      </div>
      <p class={css.lead}>
        {t("proposeInfoAction.leadPre")}
        <b>Info Action</b>
        {t("proposeInfoAction.leadMid")}
        <span class={linkCss.mono}>gov_action_deposit</span>
        {t("proposeInfoAction.leadPost")}
      </p>

      {/* Generic, action-kind-independent: prepare and validate the anchor. */}
      <p class={css.sectionNote}>{t("proposeInfoAction.genericSectionNote")}</p>
      <LinkAnchorSection onChange={onPrepared} />

      {/* Info-Action-specific: sign & submit the one kind Tessera builds. */}
      <div class={linkCss.stepHead}>{t("proposeInfoAction.step3Head")}</div>
      <p class={css.sectionNote}>{t("proposeInfoAction.submitSectionNote")}</p>
      <div class={linkCss.card}>
        <Show
          when={app.wallet()}
          fallback={
            <Note kind="warn">{t("proposeInfoAction.connectWallet")}</Note>
          }
        >
          <Show when={mismatch()}>
            <Note kind="danger">
              {t("proposeInfoAction.networkMismatch", {
                network: app.config.network,
              })}
            </Note>
          </Show>
        </Show>

        <Show when={prepared() && blocking() && !txHash()}>
          <Note kind="danger">{t("proposeInfoAction.resolveIssues")}</Note>
        </Show>

        <Show when={queued()}>
          <QueuedNote />
        </Show>

        <Show
          when={txHash()}
          fallback={
            <Show when={!queued()}>
              <button
                onClick={() => (queueing() ? queue() : void submit())}
                disabled={queueing() ? !canQueue() : !canSubmit()}
                class={css.submitBtn}
                classList={{
                  [css.submitBtnEnabled]: queueing() ? canQueue() : canSubmit(),
                }}
              >
                {busy()
                  ? t("proposeInfoAction.building")
                  : queueing()
                    ? t("cart.addToCart")
                    : t("proposeInfoAction.submit")}
              </button>
              <Show when={!queueing()}>
                <button
                  onClick={() => queue()}
                  disabled={!canQueue()}
                  class={css.queueBtn}
                >
                  {t("cart.addToCart")}
                </button>
              </Show>
            </Show>
          }
        >
          {(h) => (
            <Note kind="ok">
              <div class={css.submittedTitle}>
                {t("proposeInfoAction.submittedTitle")}
              </div>
              <div class={css.txLine}>
                <TxLink hash={h()} color="var(--ok)" />
              </div>
              <p class={css.hintNoBottom}>
                {t("proposeInfoAction.submittedHint")}
              </p>
            </Note>
          )}
        </Show>

        <Show when={error()}>
          <Note kind="danger">{error()}</Note>
        </Show>
      </div>
    </main>
  );
};
