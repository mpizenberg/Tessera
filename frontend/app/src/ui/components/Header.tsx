import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";

import { useApp } from "~/state";
import { otherNetwork, otherNetworkUrl } from "~/config";
import { networkMismatch, roleDescription, roleLabel } from "~/ui/format";
import { CartBadge } from "~/ui/components/CartDrawer";
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { t, type MsgKey } from "~/i18n";
import css from "./Header.module.css";

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
    app.setCartOpen(false);
  };
  createEffect(() => {
    if (!menuOpen() && !app.cartOpen()) return;
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
          <CartBadge />

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
                  app.setCartOpen(false);
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
                  app.setCartOpen(false);
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
                      // connect() never rejects — it stashes failures in
                      // connectError, which only renders inside this menu. Close
                      // just on success, so a failure stays visible to the user.
                      void app.connect(k).then(() => {
                        if (app.wallet()) setMenuOpen(false);
                      });
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

/**
 * Network section at the top of the identity menu. One deployment serves one
 * network (see `envNetwork` in `config.ts`), so this shows the active network
 * and — when `VITE_OTHER_NETWORK_URL` is configured — links to the counterpart
 * deployment instead of switching in place.
 */
const NetworkSwitch: Component = () => {
  const app = useApp();
  return (
    <>
      <div class={css.menuHeading}>{t("header.network")}</div>
      <div class={`${css.menuRow} ${css.on}`}>
        <span
          class={css.networkSwitchDot}
          classList={{ [css.mainnet]: app.config.network === "mainnet" }}
        />
        <span class={css.networkSwitchLabel}>{app.config.network}</span>
        <span class={css.networkSwitchCheck}>✓</span>
      </div>
      <Show when={otherNetworkUrl()}>
        {(url) => (
          <a class={css.menuRow} href={url()}>
            <span
              class={css.networkSwitchDot}
              classList={{ [css.mainnet]: otherNetwork() === "mainnet" }}
            />
            <span class={css.networkSwitchLabel}>{otherNetwork()}</span>
            <span class={css.networkSwitchCheck}>↗</span>
          </a>
        )}
      </Show>
      <div class={css.menuNote}>{t("header.oneNetworkNote")}</div>
    </>
  );
};
