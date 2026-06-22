/**
 * Settings screen.
 *
 * Client-side preferences, stored in localStorage — nothing here touches the
 * on-chain payload:
 *  - **IPFS pinning provider tokens** (Pinata / Blockfrost / NMKR): enable
 *    in-app uploading of off-chain content (external-survey presentation docs,
 *    voter rationales). A document is pinned to every configured provider in
 *    parallel. Reading never needs these — it races public gateways.
 *  - **Koios token override**: use your own token instead of the app's
 *    pre-configured one (which may be rate-limited). Applies on save.
 *  - the Plain/Pro detail toggle (mirrors the header switch).
 */

import { For, Show, createSignal, type Component, type JSX } from "solid-js";

import { useApp } from "~/state";
import { envKoiosToken, storedKoiosToken } from "~/config";
import { IPFS_PROVIDERS } from "~/enrichment/providers";

export const Settings: Component = () => {
  return (
    <main
      style={{
        "max-width": "720px",
        margin: "0 auto",
        padding: "34px 24px 96px",
      }}
    >
      <h1
        style={{
          "font-size": "27px",
          "font-weight": "800",
          "letter-spacing": "-.02em",
          margin: "0",
          color: "var(--ink)",
        }}
      >
        Settings
      </h1>
      <p
        style={{
          "font-size": "14.5px",
          color: "var(--muted)",
          margin: "7px 0 0",
          "max-width": "540px",
          "line-height": "1.5",
        }}
      >
        Stored only in this browser. None of it touches the on-chain payload —
        surveys always validate and tally from chain data alone.
      </p>

      <ProvidersSection />
      <KoiosSection />
      <DisplaySection />
    </main>
  );
};

/**
 * A settings section: a mono kicker title sitting *above* the white card (like
 * the numbered heads on the Create page), then the card body.
 */
const Section: Component<{ head: string; children: JSX.Element }> = (props) => (
  <div style={{ "margin-top": "20px" }}>
    <div style={sectionHeadStyle()}>{props.head}</div>
    <div style={panelStyle()}>{props.children}</div>
  </div>
);

// --- IPFS pinning providers --------------------------------------------------

const ProvidersSection: Component = () => {
  const app = useApp();
  const enabledCount = () =>
    IPFS_PROVIDERS.filter((p) => app.ipfsTokens[p.id]?.trim()).length;

  return (
    <Section head="Off-chain content storage">
      <h2 style={headingStyle()}>IPFS pinning services</h2>
      <p style={proseStyle()}>
        Needed only to <b>author</b> content the app stores off-chain — an
        external survey's presentation document, or a voter rationale. Enable
        one or more; each document is pinned to <b>every</b> enabled service in
        parallel for wider availability (same content hash everywhere). Embedded
        surveys and reading never need these.
      </p>
      <div
        style={{
          "font-family": "var(--mono)",
          "font-size": "11px",
          color: "var(--dim)",
          "margin-top": "10px",
        }}
      >
        {enabledCount()} enabled
      </div>

      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "10px",
          "margin-top": "16px",
        }}
      >
        <For each={IPFS_PROVIDERS}>
          {(p) => {
            const token = () => app.ipfsTokens[p.id] ?? "";
            const on = () => !!token().trim();
            return (
              <div
                style={{
                  background: on() ? "#FBF4EE" : "#fff",
                  border: `1px solid ${on() ? "var(--accent-line)" : "var(--line)"}`,
                  "border-radius": "var(--r-md)",
                  padding: "14px 15px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "10px",
                  }}
                >
                  <span
                    style={{
                      "font-size": "14px",
                      "font-weight": "700",
                      color: on() ? "var(--accent)" : "var(--ink)",
                    }}
                  >
                    {p.label}
                  </span>
                  <span style={statusBadgeStyle(on())}>
                    {on() ? "Set" : "Not set"}
                  </span>
                </div>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={token()}
                  onInput={(e) => app.setIpfsToken(p.id, e.currentTarget.value)}
                  placeholder={p.tokenPlaceholder}
                  style={tokenInputStyle()}
                />
                <p
                  style={{
                    "font-size": "11.5px",
                    color: "var(--dim)",
                    "line-height": "1.4",
                    margin: "8px 0 0",
                  }}
                >
                  {p.hint}
                </p>
              </div>
            );
          }}
        </For>
      </div>

      <div style={infoNoteStyle()}>
        <span style={infoBadgeStyle()}>i</span>
        <p style={noteTextStyle()}>
          Pinning keeps a document reachable; if it ever drops, surveys still
          validate and tally from on-chain data — only the presentation labels
          can't be rendered. The anchor hash is computed locally (
          <b>blake2b-256</b>) from the exact bytes uploaded, so a provider can't
          alter what you anchor. Tokens stay in this browser only.
        </p>
      </div>
    </Section>
  );
};

// --- Koios token override ----------------------------------------------------

const KoiosSection: Component = () => {
  const app = useApp();
  const [draft, setDraft] = createSignal(storedKoiosToken() ?? "");
  const [saved, setSaved] = createSignal(false);

  const overridden = () => app.koiosToken() !== envKoiosToken();
  const dirty = () => draft().trim() !== (storedKoiosToken() ?? "");

  const save = () => {
    app.setKoiosToken(draft());
    setSaved(true);
  };
  const reset = () => {
    setDraft("");
    app.setKoiosToken("");
    setSaved(true);
  };

  return (
    <Section head="Network & data source">
      <h2 style={headingStyle()}>Reading from Koios</h2>
      <p style={proseStyle()}>
        The app ships with a pre-configured Koios token that may get
        rate-limited under load. Paste your own to use it instead — it overrides
        the default and applies on save (the snapshot reloads). Network and
        endpoint are set at build time.
      </p>

      <dl
        style={{
          margin: "16px 0 4px",
          display: "grid",
          "grid-template-columns": "auto 1fr",
          "row-gap": "10px",
          "column-gap": "18px",
        }}
      >
        <FactRow label="Network">
          <span
            style={{
              "font-weight": "700",
              color: "var(--ink)",
              "text-transform": "capitalize",
            }}
          >
            {app.config.network}
          </span>
        </FactRow>
        <FactRow label="Endpoint">
          <span
            style={{
              "font-family": "var(--mono)",
              "font-size": "12.5px",
              color: "var(--muted)",
            }}
          >
            {app.config.koiosUrl}
          </span>
        </FactRow>
        <FactRow label="Active token">
          <span style={statusBadgeStyle(!!app.koiosToken())}>
            {app.koiosToken()
              ? overridden()
                ? "your token"
                : "app default"
              : "none"}
          </span>
        </FactRow>
      </dl>

      <label
        style={{
          ...kickerStyle(),
          color: "var(--dim)",
          display: "block",
          "margin-top": "14px",
        }}
      >
        Your Koios token
      </label>
      <div
        style={{
          display: "flex",
          gap: "9px",
          "margin-top": "8px",
          "align-items": "center",
          "flex-wrap": "wrap",
        }}
      >
        <input
          type="password"
          autocomplete="off"
          spellcheck={false}
          value={draft()}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            setSaved(false);
          }}
          placeholder="paste a Koios bearer token"
          style={{
            ...tokenInputStyle(),
            "margin-top": "0",
            flex: "1",
            "min-width": "220px",
          }}
        />
        <button
          style={btnPrimaryStyle(dirty())}
          disabled={!dirty()}
          onClick={save}
        >
          Save
        </button>
        <button
          style={btnGhostStyle()}
          disabled={!storedKoiosToken()}
          onClick={reset}
        >
          Use app default
        </button>
      </div>
      <Show when={saved()}>
        <div
          style={{
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "var(--ok)",
            "margin-top": "9px",
          }}
        >
          ✓ saved · snapshot reloaded
        </div>
      </Show>
    </Section>
  );
};

const FactRow: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <>
    <dt
      style={{
        "font-family": "var(--mono)",
        "font-size": "10.5px",
        "letter-spacing": ".05em",
        "text-transform": "uppercase",
        color: "var(--dim)",
        "align-self": "center",
      }}
    >
      {props.label}
    </dt>
    <dd style={{ margin: "0", "align-self": "center" }}>{props.children}</dd>
  </>
);

// --- display preferences -----------------------------------------------------

const DisplaySection: Component = () => {
  const app = useApp();
  return (
    <Section head="Display">
      <h2 style={headingStyle()}>Detail level</h2>
      <p style={proseStyle()}>
        <b>Pro</b> mode surfaces technical detail across the app — survey refs,
        epochs, drand rounds, padding sizes, and extra authoring fields.{" "}
        <b>Plain</b> hides them. Also toggleable from the header.
      </p>
      <div
        style={{
          display: "inline-flex",
          "align-items": "center",
          background: "#F1EADC",
          border: "1px solid #E3DBC9",
          "border-radius": "9px",
          padding: "3px",
          "margin-top": "14px",
        }}
      >
        <button style={segStyle(!app.ui.pro)} onClick={() => app.setPro(false)}>
          Plain
        </button>
        <button style={segStyle(app.ui.pro)} onClick={() => app.setPro(true)}>
          Pro
        </button>
      </div>
    </Section>
  );
};

// --- styles ------------------------------------------------------------------

function panelStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-panel)",
    padding: "22px",
  };
}
function kickerStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10.5px",
    "letter-spacing": ".1em",
    "text-transform": "uppercase",
    color: "var(--accent)",
    "font-weight": "600",
  };
}
function sectionHeadStyle(): JSX.CSSProperties {
  return { ...kickerStyle(), margin: "0 2px 11px" };
}
function headingStyle(): JSX.CSSProperties {
  return {
    "font-size": "17px",
    "font-weight": "800",
    "letter-spacing": "-.01em",
    margin: "11px 0 0",
    color: "var(--ink)",
  };
}
function proseStyle(): JSX.CSSProperties {
  return {
    "font-size": "13.5px",
    color: "var(--muted)",
    "line-height": "1.55",
    margin: "7px 0 0",
  };
}
function noteTextStyle(): JSX.CSSProperties {
  return {
    "font-size": "12.5px",
    color: "var(--muted)",
    "line-height": "1.5",
    margin: "0",
  };
}
function tokenInputStyle(): JSX.CSSProperties {
  return {
    width: "100%",
    "box-sizing": "border-box",
    "margin-top": "11px",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-input)",
    padding: "9px 11px",
    "font-family": "var(--mono)",
    "font-size": "12.5px",
    outline: "none",
    background: "#fff",
    color: "var(--ink)",
  };
}
function statusBadgeStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-size": "10px",
    "font-weight": "700",
    "font-family": "var(--mono)",
    "letter-spacing": ".04em",
    "text-transform": "uppercase",
    color: on ? "var(--ok)" : "var(--dim)",
    background: on ? "var(--ok-bg)" : "var(--surface3)",
    border: `1px solid ${on ? "var(--ok-line)" : "var(--line)"}`,
    "border-radius": "var(--r-2xs)",
    padding: "4px 8px",
    flex: "none",
  };
}
function btnPrimaryStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "700",
    cursor: on ? "pointer" : "default",
    background: on ? "var(--accent)" : "var(--accent-tint)",
    color: "#fff",
    border: "none",
    "border-radius": "var(--r-input)",
    padding: "10px 16px",
    opacity: on ? "1" : ".6",
  };
}
function btnGhostStyle(): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "600",
    cursor: "pointer",
    background: "#fff",
    color: "var(--muted)",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-input)",
    padding: "10px 14px",
  };
}
function segStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "12px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    border: "none",
    "border-radius": "7px",
    padding: "6px 16px",
    background: on ? "var(--accent)" : "transparent",
    color: on ? "#fff" : "#857B6B",
  };
}
function infoNoteStyle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "flex-start",
    gap: "9px",
    background: "#FBF6EC",
    border: "1px solid #ECE3D2",
    "border-radius": "var(--r-control)",
    padding: "12px 14px",
    "margin-top": "16px",
  };
}
function infoBadgeStyle(): JSX.CSSProperties {
  return {
    width: "18px",
    height: "18px",
    "border-radius": "var(--r-3xs)",
    background: "var(--accent-bg)",
    border: "1px solid var(--accent-line)",
    color: "var(--accent)",
    "font-size": "11px",
    "font-weight": "700",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    flex: "none",
    "margin-top": "1px",
  };
}
