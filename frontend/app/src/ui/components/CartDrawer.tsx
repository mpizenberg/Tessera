/**
 * The cart: what the user queued, how it partitions into transactions, and the
 * transactions already on their way. Queued drafts and in-flight chains are one
 * lifecycle — an action is queued, then rides a transaction, then either the
 * chain shows it or it comes back here — so one badge in the header opens both.
 *
 * The partition is computed, never chosen: CIP-179 allows one event kind per
 * transaction, so the drawer shows the grouping the planner derived rather than
 * letting the user drag actions between transactions.
 */

import {
  For,
  Show,
  createResource,
  createSignal,
  type Component,
} from "solid-js";
import { A } from "@solidjs/router";

import { credentialKey } from "cip-179/domain";
import { bytesToHex } from "cip-179/domain";

import { useApp } from "~/state";
import type { Action, ActionKind } from "~/wallet/action";
import {
  pendingKind,
  pendingSurveyKey,
  pendingTitle,
  type PendingTx,
} from "~/wallet/pending";
import type { PlannedTx } from "~/wallet/plan";
import type { ConnectedWallet } from "~/wallet/types";
import { TxLink } from "~/ui/components/TxLink";
import { Spinner } from "~/ui/components/Spinner";
import { t, type MsgKey } from "~/i18n";
import css from "./CartDrawer.module.css";

const QUEUED_TEXT: Record<ActionKind, MsgKey> = {
  survey: "cart.queuedSurvey",
  response: "cart.queuedResponse",
  cancel: "cart.queuedCancel",
  govAction: "cart.queuedGovAction",
};
const PENDING_TEXT: Record<ActionKind, MsgKey> = {
  survey: "cart.pendingSurvey",
  response: "cart.pendingResponse",
  cancel: "cart.pendingCancel",
  govAction: "cart.pendingGovAction",
};
const CONFIRMED_TEXT: Record<ActionKind, MsgKey> = {
  survey: "cart.confirmedSurvey",
  response: "cart.confirmedResponse",
  cancel: "cart.confirmedCancel",
  govAction: "cart.confirmedGovAction",
};

/** Badge in the header bar, opening the cart. Absent when there is nothing to show. */
export const CartBadge: Component = () => {
  const app = useApp();
  // Entries stay projected after the user has been told about them; the badge
  // counts only what is still news.
  const announced = () => app.pendingTxs().filter((p) => p.status !== "done");
  const count = () => app.cart().length + announced().length;
  const anyPending = () => announced().some((p) => p.status === "pending");

  return (
    <Show when={count() > 0}>
      <div class={css.anchor}>
        <button
          type="button"
          onClick={() => app.setCartOpen(!app.cartOpen())}
          title={t("cart.open")}
          aria-label={t("cart.open")}
          aria-expanded={app.cartOpen()}
          class={css.badge}
        >
          <Show
            when={anyPending()}
            fallback={
              <Show
                when={app.cart().length > 0}
                fallback={<span class={css.badgeDone}>✓</span>}
              >
                <span class={css.badgeQueued}>▤</span>
              </Show>
            }
          >
            <Spinner size={13} />
          </Show>
          <Show when={count() > 1}>
            <span class={css.badgeCount}>{count()}</span>
          </Show>
        </button>
        <Show when={app.cartOpen()}>
          <div class={css.panel}>
            <Show when={app.cart().length > 0}>
              <div class={css.heading}>{t("cart.queuedHeading")}</div>
              <QueuedSection />
            </Show>
            <Show when={announced().length > 0}>
              <div class={css.heading}>{t("cart.inFlightHeading")}</div>
              <For each={announced()}>
                {(p) => (
                  <PendingRow p={p} onNavigate={() => app.setCartOpen(false)} />
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

/**
 * The queue, grouped into the transactions that will publish it. Until the
 * partition is known — computing it loads the CBOR encoder the planner measures
 * payloads with — the actions are listed as they were queued.
 */
const QueuedSection: Component = () => {
  const app = useApp();
  const [plan] = createResource(
    () => app.cart(),
    () => app.planCart(),
  );

  return (
    <>
      <Show
        when={!plan.loading && !plan.error && plan()}
        fallback={
          <>
            <For each={app.cart()}>{(a) => <QueuedRow action={a} />}</For>
            <div class={css.note}>{t("cart.planPending")}</div>
          </>
        }
      >
        {(txs) => (
          <For each={txs()}>
            {(tx, i) => <PlannedTxCard tx={tx} index={i() + 1} />}
          </For>
        )}
      </Show>
      <div class={css.note}>{t("cart.planNote")}</div>
      <SubmitBar />
    </>
  );
};

/** One planned transaction: what it publishes, and what it waits on. */
const PlannedTxCard: Component<{ tx: PlannedTx; index: number }> = (props) => {
  const app = useApp();
  const missing = () => {
    const w = app.wallet();
    if (!w) return []; // the connect prompt below already says what's needed
    const held = heldCredentials(w);
    return props.tx.proveCredentials.filter((c) => !held.has(credentialKey(c)));
  };

  return (
    <div class={css.txCard}>
      <div class={css.txHead}>{t("cart.planTx", { n: props.index })}</div>
      <For each={props.tx.actions}>{(a) => <QueuedRow action={a} />}</For>
      <Show when={props.tx.dependsOn.length > 0}>
        <div class={css.txChained}>{t("cart.planChained")}</div>
      </Show>
      <For each={missing()}>
        {(c) => (
          <div class={css.txWarn}>
            {t("cart.planMissingSignature", {
              credential: shortHash(
                c.type === "key"
                  ? bytesToHex(c.keyHash)
                  : bytesToHex(c.scriptHash),
              ),
            })}
          </div>
        )}
      </For>
    </div>
  );
};

/** One queued action, with the only edit the cart offers: remove it. */
const QueuedRow: Component<{ action: Action }> = (props) => {
  const app = useApp();
  return (
    <div class={css.queuedRow}>
      <div class={css.queuedText}>
        <div class={css.queuedLabel}>{t(QUEUED_TEXT[props.action.kind])}</div>
        <Show when={props.action.title}>
          {(title) => <div class={css.queuedSub}>{title()}</div>}
        </Show>
      </div>
      <button
        type="button"
        onClick={() => app.removeFromCart(props.action)}
        title={t("cart.remove")}
        aria-label={t("cart.remove")}
        class={css.remove}
      >
        ×
      </button>
    </div>
  );
};

/** Sign every planned transaction, then submit them all. */
const SubmitBar: Component = () => {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const publish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await app.submitCart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={css.submitBar}>
      <Show
        when={app.wallet()}
        fallback={<div class={css.note}>{t("cart.connectWallet")}</div>}
      >
        <button
          type="button"
          class={css.submitBtn}
          disabled={busy()}
          onClick={() => void publish()}
        >
          {busy() ? t("cart.submitting") : t("cart.submit")}
        </button>
        <div class={css.note}>{t("cart.submitHint")}</div>
      </Show>
      <Show when={error()}>
        <div class={css.error}>{error()}</div>
      </Show>
    </div>
  );
};

/** One in-flight transaction: what it publishes, and how to unstick it. */
const PendingRow: Component<{
  p: PendingTx;
  onNavigate: () => void;
}> = (props) => {
  const app = useApp();
  const [resubmitting, setResubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const confirmed = () => props.p.status === "confirmed";
  const kind = () => pendingKind(props.p);
  const headline = () =>
    confirmed()
      ? t(CONFIRMED_TEXT[kind()])
      : t("cart.pendingHeadline", { label: t(PENDING_TEXT[kind()]) });

  const resubmit = async (): Promise<void> => {
    setResubmitting(true);
    setError(null);
    try {
      await app.resubmitTx(props.p.txHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResubmitting(false);
    }
  };

  return (
    <div class={css.pendingRow}>
      <div class={css.pendingRowHead}>
        <Show when={confirmed()} fallback={<Spinner size={13} />}>
          <span class={css.pendingRowDone}>✓</span>
        </Show>
        <span
          class={css.pendingRowTitle}
          classList={{ [css.done]: confirmed() }}
        >
          {headline()}
        </span>
        {/* A pending tx holds real inputs, so it can only be rebroadcast or
            explicitly forgotten below — never quietly waved away. */}
        <Show when={confirmed()}>
          <button
            type="button"
            onClick={() => app.dismissTx(props.p.txHash)}
            title={t("cart.dismiss")}
            aria-label={t("cart.dismiss")}
            class={css.remove}
          >
            ×
          </button>
        </Show>
      </div>
      <Show when={pendingTitle(props.p)}>
        {(title) => <div class={css.pendingRowSub}>{title()}</div>}
      </Show>
      <div class={css.pendingRowHash}>
        <TxLink hash={props.p.txHash} />
      </div>
      <Show when={!confirmed() && props.p.stalled}>
        <div class={css.pendingRowSlow}>
          {t("cart.stalled")} {t("cart.stalledChoice")}
        </div>
        <div class={css.pendingRowActions}>
          <button
            type="button"
            class={css.pendingAction}
            disabled={resubmitting() || !app.wallet()}
            onClick={() => void resubmit()}
          >
            {resubmitting() ? t("cart.rebroadcasting") : t("cart.rebroadcast")}
          </button>
          <button
            type="button"
            class={css.pendingActionDanger}
            onClick={() => app.dropTx(props.p.txHash)}
          >
            {t("cart.forget")}
          </button>
        </div>
        <Show when={error()}>
          <div class={css.error}>{error()}</div>
        </Show>
      </Show>
      <Show when={pendingSurveyKey(props.p)}>
        {(key) => (
          <div class={css.pendingRowLinkWrap}>
            <A
              href={`/survey/${encodeURIComponent(key())}`}
              onClick={() => props.onNavigate()}
              class={css.pendingRowLink}
            >
              {t("cart.viewSurvey")}
            </A>
          </div>
        )}
      </Show>
    </div>
  );
};

/**
 * Shown by a screen that queued an action instead of publishing it — which only
 * happens when the cart already held something the user hasn't published yet.
 */
export const QueuedNote: Component = () => {
  const app = useApp();
  return (
    <div class={css.queuedNote}>
      <div class={css.queuedNoteTitle}>{t("cart.queuedTitle")}</div>
      <p class={css.queuedNoteBody}>{t("cart.queuedBody")}</p>
      <button
        type="button"
        class={css.queuedNoteBtn}
        onClick={() => app.setCartOpen(true)}
      >
        {t("cart.queuedOpen")}
      </button>
    </div>
  );
};

/** Credentials the connected wallet can produce a witness for. */
function heldCredentials(w: ConnectedWallet): ReadonlySet<string> {
  const { payment, stake, drep } = w.identity;
  return new Set(
    [payment, stake, drep]
      .filter((c) => c !== undefined)
      .map((c) => `${c.kind}:${c.hashHex}`),
  );
}

function shortHash(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}
