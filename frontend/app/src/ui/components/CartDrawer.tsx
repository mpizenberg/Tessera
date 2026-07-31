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

import type { Credential } from "cip-179";
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
import type { BuiltTx } from "~/wallet/submit";
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
  const glyph = () => {
    if (anyPending()) return <Spinner size={13} />;
    if (app.cartLocked()) return <span class={css.badgeSigning}>✎</span>;
    if (app.cart().length > 0) return <span class={css.badgeQueued}>▤</span>;
    return <span class={css.badgeDone}>✓</span>;
  };

  return (
    <Show when={count() > 0}>
      <>
        <button
          type="button"
          onClick={() => app.setCartOpen(!app.cartOpen())}
          title={t("cart.open")}
          aria-label={t("cart.open")}
          aria-expanded={app.cartOpen()}
          class={css.badge}
        >
          {glyph()}
          <Show when={count() > 1}>
            <span class={css.badgeCount}>{count()}</span>
          </Show>
        </button>
        <Show when={app.cartOpen()}>
          <div class={css.panel}>
            <Show when={app.cart().length > 0}>
              <Show
                when={app.signing().length > 0}
                fallback={
                  <>
                    <div class={css.heading}>{t("cart.queuedHeading")}</div>
                    <QueuedSection />
                  </>
                }
              >
                <div class={css.heading}>{t("cart.signingHeading")}</div>
                <SigningSection />
              </Show>
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
      </>
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
    const held = heldKeyHashes(w);
    return props.tx.proveCredentials
      .map(credentialHash)
      .filter((hex) => !held.has(hex));
  };

  return (
    <div class={css.txCard}>
      <div class={css.txHead}>{t("cart.planTx", { n: props.index })}</div>
      <For each={props.tx.actions}>{(a) => <QueuedRow action={a} />}</For>
      <Show when={props.tx.dependsOn.length > 0}>
        <div class={css.txChained}>{t("cart.planChained")}</div>
      </Show>
      <For each={missing()}>
        {(hex) => (
          <div class={css.txWarn}>
            {t("cart.planMissingSignature", { credential: shortHash(hex) })}
          </div>
        )}
      </For>
    </div>
  );
};

/**
 * The chain as it is being signed: one card per transaction, each naming the
 * signatures it still waits for. Wallets sign one after another — connect one,
 * sign what it holds, disconnect, connect the next — so the panel is the same
 * whichever wallet is connected, and what has been gathered survives the switch.
 */
const SigningSection: Component = () => {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const complete = () => app.signing().every((tx) => tx.missing.length === 0);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      await app.signWithWallet();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <For each={app.signing()}>
        {(tx, i) => <SigningTxCard tx={tx} index={i() + 1} />}
      </For>
      <Show when={!complete()}>
        <div class={css.note}>{t("cart.signSwitchWallet")}</div>
      </Show>
      <Show when={app.signError()}>
        <div class={css.error}>{app.signError()}</div>
      </Show>
      <div class={css.submitBar}>
        <Show
          when={app.wallet()}
          fallback={<div class={css.note}>{t("cart.connectWallet")}</div>}
        >
          <button
            type="button"
            class={css.submitBtn}
            disabled={busy()}
            onClick={() => void run()}
          >
            {busy()
              ? t(complete() ? "cart.submitting" : "cart.signingNow")
              : t(complete() ? "cart.publish" : "cart.signWithWallet")}
          </button>
        </Show>
        <button
          type="button"
          class={css.discardBtn}
          onClick={() => app.discardSigning()}
        >
          {t("cart.discard")}
        </button>
        <div class={css.note}>{t("cart.discardHint")}</div>
      </div>
    </>
  );
};

/** One built transaction: what it publishes, and whose signature it still needs. */
const SigningTxCard: Component<{ tx: BuiltTx; index: number }> = (props) => {
  const app = useApp();
  const held = () => {
    const w = app.wallet();
    return w ? heldKeyHashes(w) : new Set<string>();
  };

  return (
    <div class={css.txCard}>
      <div class={css.txHead}>{t("cart.planTx", { n: props.index })}</div>
      <For each={props.tx.planned.actions}>
        {(a) => <QueuedRow action={a} locked />}
      </For>
      <Show
        when={props.tx.missing.length > 0}
        fallback={<div class={css.txSigned}>{t("cart.signComplete")}</div>}
      >
        <For each={props.tx.missing}>
          {(hex) => (
            <div class={css.txWarn}>
              {t("cart.signMissing", { credential: shortHash(hex) })}
              <Show when={held().has(hex)}> {t("cart.signHeldHere")}</Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};

/** One queued action; removing it is the only edit, and only before it is built. */
const QueuedRow: Component<{ action: Action; locked?: boolean }> = (props) => {
  const app = useApp();
  return (
    <div class={css.queuedRow}>
      <div class={css.queuedText}>
        <div class={css.queuedLabel}>{t(QUEUED_TEXT[props.action.kind])}</div>
        <Show when={props.action.title}>
          {(title) => <div class={css.queuedSub}>{title()}</div>}
        </Show>
      </div>
      <Show when={!props.locked}>
        <button
          type="button"
          onClick={() => app.removeFromCart(props.action)}
          title={t("cart.remove")}
          aria-label={t("cart.remove")}
          class={css.remove}
        >
          ×
        </button>
      </Show>
    </div>
  );
};

/** Build the queue into a chain and take it as far as this wallet can. */
const SubmitBar: Component = () => {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);

  const publish = async (): Promise<void> => {
    setBusy(true);
    try {
      await app.submitCart();
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
      <Show when={app.signError()}>
        <div class={css.error}>{app.signError()}</div>
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

/** A screen-side panel pointing at the cart, for the two states that need it. */
const CartNote: Component<{ title: MsgKey; body: MsgKey }> = (props) => {
  const app = useApp();
  return (
    <div class={css.queuedNote}>
      <div class={css.queuedNoteTitle}>{t(props.title)}</div>
      <p class={css.queuedNoteBody}>{t(props.body)}</p>
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

/**
 * Shown in place of a screen's publish controls while a chain is being signed:
 * the cart is what was built, so it cannot take anything else until that chain
 * is published or discarded.
 */
export const PublishLocked: Component = () => (
  <CartNote title="cart.signingTitle" body="cart.signingBody" />
);

/**
 * Shown by a screen that queued an action instead of publishing it — because
 * the cart already held something, or because the chain it built is still
 * waiting for a signature. A screen whose queued action needs saying more than
 * that passes its own `body`.
 */
export const QueuedNote: Component<{ body?: MsgKey }> = (props) => {
  const app = useApp();
  return (
    <Show when={!app.cartLocked()} fallback={<PublishLocked />}>
      <CartNote
        title="cart.queuedTitle"
        body={props.body ?? "cart.queuedBody"}
      />
    </Show>
  );
};

/**
 * Hashes the connected wallet can produce a witness for. The payment key is the
 * change address's; a wallet spreading its funds over many addresses holds more
 * than this, so a hash absent here is not proof that the wallet cannot sign it.
 */
function heldKeyHashes(w: ConnectedWallet): ReadonlySet<string> {
  const { payment, stake, drep } = w.identity;
  return new Set(
    [payment, stake, drep].filter((c) => c !== undefined).map((c) => c.hashHex),
  );
}

/** A credential's hash as hex — how a required witness is named. */
function credentialHash(c: Credential): string {
  return bytesToHex(c.type === "key" ? c.keyHash : c.scriptHash);
}

function shortHash(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}
