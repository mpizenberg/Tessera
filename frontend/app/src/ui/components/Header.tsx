import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";

import { useApp, type PendingKind, type PendingTx } from "~/state";
import type { Network } from "~/config";
import { networkMismatch, roleDescription, roleLabel } from "~/ui/format";
import { TxLink } from "~/ui/components/TxLink";
import { Spinner } from "~/ui/components/Spinner";
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { t, type MsgKey } from "~/i18n";
import css from "./Header.module.css";

const NETWORKS: readonly Network[] = ["preview", "mainnet"];

const NAV: ReadonlyArray<{ href: string; labelKey: MsgKey }> = [
  { href: "/", labelKey: "header.navExplore" },
  { href: "/create", labelKey: "header.navCreate" },
  { href: "/settings", labelKey: "header.navSettings" },
];

function truncAddr(a: string): string {
  return a.length > 16 ? `${a.slice(0, 9)}…${a.slice(-4)}` : a;
}

/** Sticky top header — mosaic logo, nav, Plain/Pro toggle, wallet identity. */
export const Header: Component = () => {
  const app = useApp();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [pendingOpen, setPendingOpen] = createSignal(false);
  const anyPending = () => app.pendingTxs.some((p) => p.status === "pending");
  const active = (href: string) =>
    href === "/" ? loc.pathname === "/" : loc.pathname.startsWith(href);

  const mismatch = () =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  // Close the open dropdown(s) on an outside click or Escape. Both menus live
  // inside `actionsRef`, so a pointerdown outside it dismisses them; listeners
  // are registered only while something is open and torn down on cleanup.
  let actionsRef: HTMLDivElement | undefined;
  const closeMenus = () => {
    setMenuOpen(false);
    setPendingOpen(false);
  };
  createEffect(() => {
    if (!menuOpen() && !pendingOpen()) return;
    const onPointerDown = (e: PointerEvent) => {
      if (actionsRef && !actionsRef.contains(e.target as Node)) closeMenus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <header class={css.header}>
      <div class={`header-bar ${css.bar}`}>
        <A href="/" class={css.brand}>
          <span class={css.logo}>
            <span class={css.tileAccent} />
            <span class={css.tileGov} />
            <span class={css.tileGov} />
            <span class={css.tileAccent} />
          </span>
          <span class={css.wordmark}>Tessera</span>
          <span class={css.cipTag}>CIP-179</span>
        </A>

        <span
          class={css.networkTag}
          classList={{ [css.mainnet]: app.config.network === "mainnet" }}
          title={t("header.activeNetwork")}
        >
          <span
            class={css.networkDot}
            classList={{ [css.mainnet]: app.config.network === "mainnet" }}
          />
          {app.config.network}
        </span>

        <nav class={`header-nav ${css.nav}`}>
          <For each={NAV}>
            {(item) => (
              <A
                href={item.href}
                class={css.navLink}
                classList={{ [css.on]: active(item.href) }}
              >
                {t(item.labelKey)}
              </A>
            )}
          </For>
        </nav>

        <div ref={actionsRef} class={`header-actions ${css.actions}`}>
          <Show when={app.pendingTxs.length > 0}>
            <div class={css.pendingAnchor}>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setPendingOpen((o) => !o);
                }}
                title={t("header.pendingTransactions")}
                aria-label={t("header.pendingTransactions")}
                aria-expanded={pendingOpen()}
                class={css.pendingBtn}
              >
                <Show
                  when={anyPending()}
                  fallback={<span class={css.pendingDone}>✓</span>}
                >
                  <Spinner size={13} />
                </Show>
                <Show when={app.pendingTxs.length > 1}>
                  <span class={css.pendingCount}>{app.pendingTxs.length}</span>
                </Show>
              </button>
              <Show when={pendingOpen()}>
                <div class={css.pendingMenu}>
                  <div class={css.menuHeading}>
                    {t("header.pendingTransactions")}
                  </div>
                  <For each={app.pendingTxs}>
                    {(p) => (
                      <PendingRow
                        p={p}
                        onDismiss={() => app.dismissTx(p.txHash)}
                        onNavigate={() => setPendingOpen(false)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <SegmentedToggle
            ariaLabel={t("header.displayMode")}
            trackPadding="2px"
            buttonPadding="5px 13px"
            value={app.ui.pro ? "pro" : "plain"}
            onChange={(v) => app.setPro(v === "pro")}
            options={[
              { value: "plain", label: t("header.displayPlain") },
              { value: "pro", label: t("header.displayPro") },
            ]}
          />

          <Show
            when={app.wallet()}
            fallback={
              <button
                type="button"
                aria-expanded={menuOpen()}
                onClick={() => {
                  setPendingOpen(false);
                  setMenuOpen((o) => !o);
                }}
                class={css.connectBtn}
              >
                {app.connecting()
                  ? t("header.connecting")
                  : t("header.connectWallet")}
              </button>
            }
          >
            {(w) => (
              <button
                type="button"
                aria-expanded={menuOpen()}
                onClick={() => {
                  setPendingOpen(false);
                  setMenuOpen((o) => !o);
                }}
                class={css.identityBtn}
                classList={{ [css.mismatch]: mismatch() }}
              >
                <span
                  class={css.identityDot}
                  classList={{ [css.mismatch]: mismatch() }}
                />
                <span class={css.identityText}>
                  <span class={css.identityRole}>
                    {(() => {
                      const r = app.activeRole();
                      return r != null ? roleLabel(r) : t("header.noRole");
                    })()}
                  </span>
                  <span class={css.identityAddr}>
                    {truncAddr(w().identity.changeAddressBech32)}
                  </span>
                </span>
                <span class={css.identityCaret}>▾</span>
              </button>
            )}
          </Show>

          <Show when={menuOpen()}>
            <div class={css.menu}>
              <NetworkSwitch />
              <div class={css.menuDivider} />
              <Show
                when={app.wallet()}
                fallback={
                  <WalletPicker
                    onPick={(k) => {
                      void app.connect(k).then(() => setMenuOpen(false));
                    }}
                  />
                }
              >
                {(w) => (
                  <RoleMenu
                    addr={w().identity.changeAddressBech32}
                    roles={app.claimableRoles()}
                    activeRole={app.activeRole()}
                    onPick={(r) => {
                      app.setActiveRole(r);
                      setMenuOpen(false);
                    }}
                    mismatch={mismatch()}
                    expectedNetwork={app.config.network}
                    onDisconnect={() => {
                      app.disconnect();
                      setMenuOpen(false);
                    }}
                  />
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </header>
  );
};

const WalletPicker: Component<{ onPick: (key: string) => void }> = (props) => {
  const app = useApp();
  // Read reactively: wallets inject asynchronously, so the list can grow after
  // the menu first opens (see `installedWallets` in state.tsx).
  const wallets = () => app.installedWallets();
  return (
    <>
      <div class={css.menuHeading}>{t("header.connectCip30")}</div>
      <Show
        when={wallets().length > 0}
        fallback={
          <div class={css.menuNote}>{t("header.noWalletDetected")}</div>
        }
      >
        <For each={wallets()}>
          {(wl) => (
            <button
              type="button"
              class={css.menuRow}
              onClick={() => props.onPick(wl.key)}
            >
              <Show
                when={wl.icon}
                fallback={<span class={css.walletIconFallback} />}
              >
                <img src={wl.icon} alt="" class={css.walletIcon} />
              </Show>
              <span class={css.walletName}>{wl.name}</span>
            </button>
          )}
        </For>
      </Show>
      <Show when={app.connectError()}>
        <div class={css.menuNoteDanger}>{app.connectError()}</div>
      </Show>
    </>
  );
};

const RoleMenu: Component<{
  addr: string;
  roles: number[];
  activeRole: number | null;
  onPick: (role: number) => void;
  mismatch: boolean;
  expectedNetwork: string;
  onDisconnect: () => void;
}> = (props) => (
  <>
    <div class={css.menuHeading}>{t("header.respondAs")}</div>
    <Show
      when={props.roles.length > 0}
      fallback={<div class={css.menuNote}>{t("header.noClaimableRole")}</div>}
    >
      <For each={props.roles}>
        {(r) => (
          <button
            type="button"
            class={css.menuRow}
            classList={{ [css.on]: r === props.activeRole }}
            onClick={() => props.onPick(r)}
            title={roleDescription(r)}
          >
            <span class={css.roleDot} />
            <span class={css.roleLabel}>{roleLabel(r)}</span>
            <Show when={r === props.activeRole}>
              <span class={css.roleCheck}>✓</span>
            </Show>
          </button>
        )}
      </For>
    </Show>
    <Show when={props.mismatch}>
      <div class={css.menuNoteDanger}>
        {t("header.networkMismatch", { network: props.expectedNetwork })}
      </div>
    </Show>
    <div class={css.roleAddr}>{truncAddr(props.addr)}</div>
    <button
      type="button"
      class={css.menuRowDanger}
      onClick={() => props.onDisconnect()}
    >
      <span class={css.disconnectLabel}>{t("header.disconnect")}</span>
    </button>
  </>
);

const PENDING_TEXT: Record<PendingKind, MsgKey> = {
  survey: "header.pendingSurvey",
  response: "header.pendingResponse",
  cancel: "header.pendingCancel",
  govAction: "header.pendingGovAction",
};
const CONFIRMED_TEXT: Record<PendingKind, MsgKey> = {
  survey: "header.confirmedSurvey",
  response: "header.confirmedResponse",
  cancel: "header.confirmedCancel",
  govAction: "header.confirmedGovAction",
};

/** One row in the pending-transactions dropdown. */
const PendingRow: Component<{
  p: PendingTx;
  onDismiss: () => void;
  onNavigate: () => void;
}> = (props) => {
  const confirmed = () => props.p.status === "confirmed";
  const headline = () =>
    confirmed()
      ? t(CONFIRMED_TEXT[props.p.kind])
      : t("header.pendingHeadline", { label: t(PENDING_TEXT[props.p.kind]) });
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
        <button
          type="button"
          onClick={() => props.onDismiss()}
          title={t("header.dismiss")}
          aria-label={t("header.dismiss")}
          class={css.dismiss}
        >
          ×
        </button>
      </div>
      <Show when={props.p.title}>
        <div class={css.pendingRowSub}>{props.p.title}</div>
      </Show>
      <div class={css.pendingRowHash}>
        <TxLink hash={props.p.txHash} />
      </div>
      <Show when={!confirmed() && props.p.slow}>
        <div class={css.pendingRowSlow}>{t("header.pendingSlow")}</div>
      </Show>
      <Show when={props.p.surveyKey}>
        <div class={css.pendingRowLinkWrap}>
          <A
            href={`/survey/${encodeURIComponent(props.p.surveyKey!)}`}
            onClick={() => props.onNavigate()}
            class={css.pendingRowLink}
          >
            {t("header.viewSurvey")}
          </A>
        </div>
      </Show>
    </div>
  );
};

/**
 * Network picker shown at the top of the identity menu (connected or not, since
 * you may want to choose a network before connecting). Switching persists the
 * choice and reloads — see `setNetwork`.
 */
const NetworkSwitch: Component = () => {
  const app = useApp();
  return (
    <>
      <div class={css.menuHeading}>{t("header.network")}</div>
      <For each={NETWORKS}>
        {(n) => {
          const on = () => n === app.config.network;
          return (
            <button
              type="button"
              class={css.menuRow}
              classList={{ [css.on]: on() }}
              onClick={() => app.setNetwork(n)}
            >
              <span
                class={css.networkSwitchDot}
                classList={{ [css.mainnet]: n === "mainnet" }}
              />
              <span class={css.networkSwitchLabel}>{n}</span>
              <Show when={on()}>
                <span class={css.networkSwitchCheck}>✓</span>
              </Show>
            </button>
          );
        }}
      </For>
      <div class={css.menuNote}>{t("header.switchingReloads")}</div>
    </>
  );
};
