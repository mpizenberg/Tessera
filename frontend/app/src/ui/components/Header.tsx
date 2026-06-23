import { For, Show, createSignal, type Component, type JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";

import { useApp } from "~/state";
import type { Network } from "~/config";
import { roleLabel } from "~/ui/format";

const NETWORKS: readonly Network[] = ["preview", "mainnet"];

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Explore" },
  { href: "/create", label: "Create" },
  { href: "/settings", label: "Settings" },
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

  const expectedNetwork = () => (app.config.network === "mainnet" ? 1 : 0);
  const networkMismatch = () => {
    const w = app.wallet();
    return w ? w.identity.networkId !== expectedNetwork() : false;
  };

  return (
    <header
      style={{
        position: "sticky",
        top: "0",
        "z-index": "40",
        background: "rgba(255,255,255,.86)",
        "backdrop-filter": "blur(10px)",
        "border-bottom": "1px solid #E7E0D0",
      }}
    >
      <div
        class="header-bar"
        style={{
          "max-width": "1160px",
          margin: "0 auto",
          display: "flex",
          "align-items": "center",
        }}
      >
        <A
          href="/"
          style={{
            display: "flex",
            "align-items": "center",
            gap: "11px",
            "text-decoration": "none",
          }}
        >
          <span
            style={{
              display: "grid",
              "grid-template-columns": "repeat(2,1fr)",
              gap: "2px",
              width: "20px",
              height: "20px",
            }}
          >
            <span
              style={{ background: "var(--accent)", "border-radius": "1.5px" }}
            />
            <span
              style={{ background: "var(--gov)", "border-radius": "1.5px" }}
            />
            <span
              style={{ background: "var(--gov)", "border-radius": "1.5px" }}
            />
            <span
              style={{ background: "var(--accent)", "border-radius": "1.5px" }}
            />
          </span>
          <span
            style={{
              "font-family": "var(--serif)",
              "font-size": "20px",
              "font-weight": "700",
              "letter-spacing": "-.01em",
              color: "var(--ink)",
            }}
          >
            Tessera
          </span>
          <span
            style={{
              "font-family": "var(--mono)",
              "font-size": "10px",
              "font-weight": "500",
              color: "var(--faint)",
              border: "1px solid var(--line)",
              "border-radius": "var(--r-3xs)",
              padding: "2px 5px",
              "letter-spacing": ".02em",
              "white-space": "nowrap",
            }}
          >
            CIP-179
          </span>
        </A>

        <span
          style={networkTagStyle(app.config.network)}
          title="Active network"
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              "border-radius": "50%",
              background:
                app.config.network === "mainnet" ? "var(--gov)" : "var(--warn)",
            }}
          />
          {app.config.network}
        </span>

        <nav
          class="header-nav"
          style={{
            "align-items": "center",
            gap: "4px",
            "margin-left": "8px",
          }}
        >
          <For each={NAV}>
            {(item) => (
              <A href={item.href} style={navStyle(active(item.href))}>
                {item.label}
              </A>
            )}
          </For>
        </nav>

        <div
          class="header-actions"
          style={{
            display: "flex",
            "align-items": "center",
            gap: "10px",
            position: "relative",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              background: "#F1EADC",
              border: "1px solid #E3DBC9",
              "border-radius": "9px",
              padding: "2px",
            }}
          >
            <button
              style={proStyle(!app.ui.pro)}
              onClick={() => app.setPro(false)}
            >
              Plain
            </button>
            <button
              style={proStyle(app.ui.pro)}
              onClick={() => app.setPro(true)}
            >
              Pro
            </button>
          </div>

          <Show
            when={app.wallet()}
            fallback={
              <button
                onClick={() => setMenuOpen((o) => !o)}
                style={connectBtnStyle()}
              >
                {app.connecting() ? "Connecting…" : "Connect wallet"}
              </button>
            }
          >
            {(w) => (
              <button
                onClick={() => setMenuOpen((o) => !o)}
                style={identityBtnStyle(networkMismatch())}
              >
                <span
                  style={{
                    width: "7px",
                    height: "7px",
                    "border-radius": "50%",
                    background: networkMismatch()
                      ? "var(--danger)"
                      : "var(--ok)",
                  }}
                />
                <span
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    "line-height": "1.15",
                    "text-align": "left",
                  }}
                >
                  <span
                    style={{
                      "font-size": "11px",
                      "font-weight": "700",
                      color: "var(--ink)",
                    }}
                  >
                    {(() => {
                      const r = app.activeRole();
                      return r != null ? roleLabel(r) : "No role";
                    })()}
                  </span>
                  <span
                    style={{
                      "font-family": "var(--mono)",
                      "font-size": "10.5px",
                      color: "var(--faint)",
                    }}
                  >
                    {truncAddr(w().identity.changeAddressBech32)}
                  </span>
                </span>
                <span style={{ color: "var(--dim)", "font-size": "10px" }}>
                  ▾
                </span>
              </button>
            )}
          </Show>

          <Show when={menuOpen()}>
            <div style={menuStyle()}>
              <NetworkSwitch />
              <div style={menuDividerStyle()} />
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
                    mismatch={networkMismatch()}
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
  const wallets = app.installedWallets();
  return (
    <>
      <div style={menuHeadingStyle()}>Connect a CIP-30 wallet</div>
      <Show
        when={wallets.length > 0}
        fallback={
          <div style={menuNoteStyle()}>
            No CIP-30 wallet detected in this browser.
          </div>
        }
      >
        <For each={wallets}>
          {(wl) => (
            <button
              style={menuRowStyle(false)}
              onClick={() => props.onPick(wl.key)}
            >
              <Show
                when={wl.icon}
                fallback={<span style={{ width: "18px", height: "18px" }} />}
              >
                <img
                  src={wl.icon}
                  alt=""
                  style={{
                    width: "18px",
                    height: "18px",
                    "border-radius": "4px",
                  }}
                />
              </Show>
              <span
                style={{
                  "font-size": "13px",
                  "font-weight": "700",
                  color: "var(--ink)",
                }}
              >
                {wl.name}
              </span>
            </button>
          )}
        </For>
      </Show>
      <Show when={app.connectError()}>
        <div style={{ ...menuNoteStyle(), color: "var(--danger)" }}>
          {app.connectError()}
        </div>
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
    <div style={menuHeadingStyle()}>Respond as · 1 wallet</div>
    <Show
      when={props.roles.length > 0}
      fallback={
        <div style={menuNoteStyle()}>
          This wallet holds no claimable role (needs a stake key or a registered
          DRep key).
        </div>
      }
    >
      <For each={props.roles}>
        {(r) => (
          <button
            style={menuRowStyle(r === props.activeRole)}
            onClick={() => props.onPick(r)}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                "border-radius": "50%",
                background: "var(--ok)",
              }}
            />
            <span
              style={{
                "font-size": "13px",
                "font-weight": "700",
                color: "var(--ink)",
                flex: "1",
                "text-align": "left",
              }}
            >
              {roleLabel(r)}
            </span>
            <Show when={r === props.activeRole}>
              <span style={{ color: "var(--accent)", "font-size": "12px" }}>
                ✓
              </span>
            </Show>
          </button>
        )}
      </For>
    </Show>
    <Show when={props.mismatch}>
      <div style={{ ...menuNoteStyle(), color: "var(--danger)" }}>
        Wallet is on a different network than the app ({props.expectedNetwork}).
        Switch networks in your wallet.
      </div>
    </Show>
    <div
      style={{
        "font-family": "var(--mono)",
        "font-size": "10.5px",
        color: "var(--faint)",
        padding: "6px 10px 2px",
      }}
    >
      {truncAddr(props.addr)}
    </div>
    <button
      style={{ ...menuRowStyle(false), color: "var(--danger)" }}
      onClick={() => props.onDisconnect()}
    >
      <span
        style={{
          "font-size": "13px",
          "font-weight": "700",
          color: "var(--danger)",
        }}
      >
        Disconnect
      </span>
    </button>
  </>
);

/**
 * Network picker shown at the top of the identity menu (connected or not, since
 * you may want to choose a network before connecting). Switching persists the
 * choice and reloads — see `setNetwork`.
 */
const NetworkSwitch: Component = () => {
  const app = useApp();
  return (
    <>
      <div style={menuHeadingStyle()}>Network</div>
      <For each={NETWORKS}>
        {(n) => {
          const on = () => n === app.config.network;
          return (
            <button
              style={menuRowStyle(on())}
              onClick={() => app.setNetwork(n)}
            >
              <span
                style={{
                  width: "7px",
                  height: "7px",
                  "border-radius": "50%",
                  background: n === "mainnet" ? "var(--gov)" : "var(--warn)",
                }}
              />
              <span
                style={{
                  "font-size": "13px",
                  "font-weight": "700",
                  color: "var(--ink)",
                  flex: "1",
                  "text-align": "left",
                  "text-transform": "capitalize",
                }}
              >
                {n}
              </span>
              <Show when={on()}>
                <span style={{ color: "var(--accent)", "font-size": "12px" }}>
                  ✓
                </span>
              </Show>
            </button>
          );
        }}
      </For>
      <div style={menuNoteStyle()}>Switching reloads on Explore.</div>
    </>
  );
};

// --- styles -----------------------------------------------------------------

function networkTagStyle(network: Network): JSX.CSSProperties {
  const mainnet = network === "mainnet";
  return {
    display: "flex",
    "align-items": "center",
    gap: "5px",
    "font-family": "var(--mono)",
    "font-size": "10px",
    "font-weight": "600",
    "letter-spacing": ".02em",
    "text-transform": "capitalize",
    "white-space": "nowrap",
    color: mainnet ? "var(--gov)" : "var(--warn)",
    background: mainnet ? "var(--gov-bg)" : "var(--warn-bg)",
    border: `1px solid ${mainnet ? "var(--gov-line)" : "var(--warn-line)"}`,
    "border-radius": "var(--r-3xs)",
    padding: "2px 6px 2px 5px",
  };
}
function menuDividerStyle(): JSX.CSSProperties {
  return {
    height: "1px",
    background: "var(--line)",
    margin: "5px 4px",
  };
}

function navStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "14px",
    "font-weight": "600",
    "text-decoration": "none",
    "border-radius": "9px",
    padding: "8px 13px",
    background: on ? "var(--accent-bg)" : "transparent",
    color: on ? "var(--accent)" : "var(--muted)",
  };
}
function proStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "11.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    border: "none",
    "border-radius": "7px",
    padding: "5px 13px",
    background: on ? "var(--accent)" : "transparent",
    color: on ? "#fff" : "#857B6B",
  };
}
function connectBtnStyle(): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "700",
    cursor: "pointer",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    "border-radius": "var(--r-input)",
    padding: "8px 14px",
  };
}
function identityBtnStyle(mismatch: boolean): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "9px",
    background: "#fff",
    border: `1px solid ${mismatch ? "var(--danger-line)" : "var(--line)"}`,
    "border-radius": "var(--r-input)",
    padding: "6px 10px 6px 9px",
    "box-shadow": "var(--shadow-card)",
    cursor: "pointer",
    "font-family": "inherit",
  };
}
function menuStyle(): JSX.CSSProperties {
  return {
    position: "absolute",
    top: "calc(100% + 8px)",
    right: "0",
    "min-width": "240px",
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-md)",
    "box-shadow": "0 16px 40px -16px rgba(70,55,30,.35)",
    padding: "5px",
    "z-index": "50",
  };
}
function menuHeadingStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "9.5px",
    "letter-spacing": ".08em",
    "text-transform": "uppercase",
    color: "var(--dim)",
    "font-weight": "600",
    padding: "7px 10px 6px",
  };
}
function menuNoteStyle(): JSX.CSSProperties {
  return {
    "font-size": "11px",
    color: "var(--dim)",
    "line-height": "1.45",
    padding: "6px 10px",
  };
}
function menuRowStyle(on: boolean): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "10px",
    width: "100%",
    "text-align": "left",
    cursor: "pointer",
    border: "none",
    "border-radius": "10px",
    padding: "9px 10px",
    background: on ? "var(--accent-bg)" : "transparent",
    "font-family": "inherit",
  };
}
