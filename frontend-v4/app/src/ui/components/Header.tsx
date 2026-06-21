import { For, type Component, type JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";

import { useApp } from "~/state";

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Explore" },
  { href: "/create", label: "Create" },
  { href: "/settings", label: "Settings" },
];

/** Sticky top header — mosaic logo, nav, Plain/Pro toggle, identity. */
export const Header: Component = () => {
  const app = useApp();
  const loc = useLocation();
  const active = (href: string) =>
    href === "/" ? loc.pathname === "/" : loc.pathname.startsWith(href);

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
        style={{
          "max-width": "1160px",
          margin: "0 auto",
          padding: "0 24px",
          height: "62px",
          display: "flex",
          "align-items": "center",
          gap: "24px",
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

        <nav
          style={{
            display: "flex",
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
          style={{
            "margin-left": "auto",
            display: "flex",
            "align-items": "center",
            gap: "10px",
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
          <span
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              background: "#fff",
              border: "1px solid var(--line)",
              "border-radius": "var(--r-input)",
              padding: "7px 11px",
              "box-shadow": "var(--shadow-card)",
              "font-size": "11px",
              "font-weight": "700",
              color: "var(--muted)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                "border-radius": "50%",
                background: "var(--dim)",
              }}
            />
            Not connected
          </span>
        </div>
      </div>
    </header>
  );
};

function navStyle(active: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "14px",
    "font-weight": "600",
    "text-decoration": "none",
    "border-radius": "9px",
    padding: "8px 13px",
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--muted)",
  };
}

function proStyle(active: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "11.5px",
    "font-weight": active ? "700" : "600",
    cursor: "pointer",
    border: "none",
    "border-radius": "7px",
    padding: "5px 13px",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "#857B6B",
  };
}
