/**
 * Minimal one-off utility: build, sign and submit a Conway governance **Info
 * Action** proposal that advertises a CIP-179 survey, using the connected CIP-30
 * wallet. The proposal's anchor is a CIP-108 document (bundled at
 * {@link ANCHOR_JSON}) whose `body.cip179` carries the survey link.
 *
 * The anchor's on-chain hash must be computed over the *exact bytes* that get
 * hosted, so the page hashes the bundled document and offers it for download —
 * host those bytes verbatim, then paste the URL here.
 */

import { Show, createSignal, type Component, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { blake2b } from "@noble/hashes/blake2.js";

import ANCHOR_JSON from "~/data/test-info-action-anchor.jsonld?raw";
import { useApp } from "~/state";
import { bytesToHex } from "~/util/hex";
import { IPFS_PROVIDERS, type ProviderId } from "~/enrichment/providers";
import { TxLink } from "~/ui/components/TxLink";

// The anchor is static, so hash it once. The on-chain `anchor_data_hash` is the
// blake2b-256 of the document bytes exactly as served.
const ANCHOR_BYTES = new TextEncoder().encode(ANCHOR_JSON);
const ANCHOR_HASH = blake2b(ANCHOR_BYTES, { dkLen: 32 });
const ANCHOR_HASH_HEX = bytesToHex(ANCHOR_HASH);

// The survey ref the bundled anchor links to (for display only).
const SURVEY_REF = (() => {
  try {
    const link = (JSON.parse(ANCHOR_JSON) as Record<string, any>)?.body?.cip179;
    return link
      ? { txId: String(link.surveyTxId), index: Number(link.surveyIndex) }
      : null;
  } catch {
    return null;
  }
})();

export const ProposeInfoAction: Component = () => {
  const app = useApp();
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [pinning, setPinning] = createSignal(false);
  const [pinnedBy, setPinnedBy] = createSignal<ProviderId[] | null>(null);
  const [pinError, setPinError] = createSignal<string | null>(null);

  // Whether the user has at least one IPFS provider configured in Settings.
  const hasPinning = () =>
    IPFS_PROVIDERS.some((p) => app.ipfsTokens[p.id]?.trim());

  // Pin the *exact* anchor bytes to the configured providers and auto-fill the
  // URL with the returned ipfs:// URI. We pin ANCHOR_BYTES verbatim, so the
  // provider serves back the same bytes and pin.hash === ANCHOR_HASH — the
  // on-chain hash stays correct whether pinned here or hosted by hand.
  const pinToIpfs = async () => {
    setPinning(true);
    setPinError(null);
    try {
      const { pinBytes } = await import("~/enrichment/pin");
      const res = await pinBytes(
        ANCHOR_BYTES,
        "info-action-survey-link.jsonld",
        "application/ld+json",
        app.ipfsTokens,
      );
      setUrl(res.uri);
      setPinnedBy(res.pinnedBy);
    } catch (e) {
      setPinError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinning(false);
    }
  };

  const expectedNetworkId = () => (app.config.network === "mainnet" ? 1 : 0);
  const mismatch = () => {
    const w = app.wallet();
    return w ? w.identity.networkId !== expectedNetworkId() : false;
  };
  const canSubmit = () =>
    !!app.wallet() && !mismatch() && url().trim() !== "" && !busy();

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(ANCHOR_HASH_HEX);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the hash is on screen */
    }
  };

  const download = () => {
    const blob = new Blob([ANCHOR_BYTES], { type: "application/ld+json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "info-action-survey-link.jsonld";
    a.click();
    URL.revokeObjectURL(href);
  };

  const submit = async () => {
    if (!canSubmit()) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await app.submitInfoAction(url().trim(), ANCHOR_HASH);
      setTxHash(hash);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        "max-width": "780px",
        margin: "0 auto",
        padding: "22px 24px 90px",
      }}
    >
      <A href="/" style={backLinkStyle()}>
        <span style={{ "font-size": "15px" }}>←</span> All surveys
      </A>

      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          "margin-top": "10px",
        }}
      >
        <span style={govPillStyle()}>Governance</span>
        <h1 style={titleStyle()}>Propose a survey Info Action</h1>
      </div>
      <p style={leadStyle()}>
        Build and sign a Conway <b>Info Action</b> that advertises a CIP-179
        survey. The action carries no on-chain effect — it only points voters at
        the survey via its anchor. A refundable{" "}
        <span style={mono()}>gov_action_deposit</span> is taken from your wallet
        and returned to your stake address when the action is ratified or
        expires (your wallet shows the exact amount before you sign).
      </p>

      <Show when={SURVEY_REF}>
        {(ref) => (
          <div style={cardStyle()}>
            <div style={labelStyle()}>Links to survey</div>
            <div
              style={{
                ...mono(),
                "font-size": "12.5px",
                "word-break": "break-all",
                color: "var(--ink)",
              }}
            >
              {ref().txId}
              <span style={{ color: "var(--dim)" }}>
                {" "}
                · index {ref().index}
              </span>
            </div>
            <p style={hintStyle()}>
              Make sure this survey's <span style={mono()}>end_epoch</span>{" "}
              equals this action's voting deadline (the CIP-179 epoch-alignment
              rule), or tooling won't treat them as linked.
            </p>
          </div>
        )}
      </Show>

      {/* 1 · Publish the anchor */}
      <div style={stepHeadStyle()}>1 · Publish the anchor document</div>
      <div style={cardStyle()}>
        <Show
          when={hasPinning()}
          fallback={
            <p style={{ ...hintStyle(), "margin-top": "0" }}>
              Host these exact bytes at a public URL (a GitHub raw link, or add
              an IPFS provider in{" "}
              <A href="/settings" style={{ color: "var(--gov)" }}>
                Settings
              </A>{" "}
              to pin from here), then paste the URL in step 2. The on-chain hash
              is computed from this content — re-formatting after hosting breaks
              the match.
            </p>
          }
        >
          <p style={{ ...hintStyle(), "margin-top": "0" }}>
            Pin to the IPFS providers configured in your Settings, in one click.
            The exact bytes below are pinned, so the served document matches the
            on-chain hash.
          </p>
        </Show>

        <div
          style={{
            display: "flex",
            gap: "8px",
            "flex-wrap": "wrap",
            "margin-bottom": "10px",
          }}
        >
          <Show when={hasPinning()}>
            <button
              onClick={() => void pinToIpfs()}
              disabled={pinning()}
              style={btnStyle(true)}
            >
              {pinning() ? "Pinning…" : "Pin to IPFS"}
            </button>
          </Show>
          <button onClick={download} style={btnStyle(!hasPinning())}>
            Download .jsonld
          </button>
          <button onClick={() => void copyHash()} style={btnStyle(false)}>
            {copied() ? "Copied hash ✓" : "Copy anchor hash"}
          </button>
        </div>

        <Show when={pinnedBy()}>
          {(by) => (
            <div style={noteStyle("ok")}>
              Pinned to {by().join(", ")}. URL filled in below.
            </div>
          )}
        </Show>
        <Show when={pinError()}>
          <div style={noteStyle("danger")}>{pinError()}</div>
        </Show>

        <div style={labelStyle()}>Anchor hash (blake2b-256)</div>
        <div
          style={{
            ...mono(),
            "font-size": "11.5px",
            "word-break": "break-all",
            color: "var(--gov)",
            "margin-bottom": "12px",
          }}
        >
          {ANCHOR_HASH_HEX}
        </div>
        <pre style={codeStyle()}>{ANCHOR_JSON}</pre>
      </div>

      {/* 2 · Anchor URL */}
      <div style={stepHeadStyle()}>2 · Anchor URL</div>
      <div style={cardStyle()}>
        <input
          type="url"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          placeholder="ipfs://… or https://…/info-action-survey-link.jsonld"
          style={inputStyle()}
        />
        <p style={hintStyle()}>
          Auto-filled when you pin to IPFS above; otherwise paste where you
          hosted the document. Stored on-chain alongside its hash.
        </p>
      </div>

      {/* 3 · Sign & submit */}
      <div style={stepHeadStyle()}>3 · Sign &amp; submit</div>
      <div style={cardStyle()}>
        <Show
          when={app.wallet()}
          fallback={
            <div style={noteStyle("warn")}>
              Connect a CIP-30 wallet (top-right) to sign the proposal.
            </div>
          }
        >
          <Show when={mismatch()}>
            <div style={noteStyle("danger")}>
              Your wallet is on a different network than the app (
              {app.config.network}). Switch it before submitting.
            </div>
          </Show>
        </Show>

        <Show
          when={txHash()}
          fallback={
            <button
              onClick={() => void submit()}
              disabled={!canSubmit()}
              style={submitBtnStyle(canSubmit())}
            >
              {busy() ? "Building & signing…" : "Build, sign & submit"}
            </button>
          }
        >
          {(h) => (
            <div style={noteStyle("ok")}>
              <div style={{ "font-weight": "700", "margin-bottom": "5px" }}>
                Proposal submitted ✓
              </div>
              <div
                style={{
                  ...mono(),
                  "font-size": "11.5px",
                  "word-break": "break-all",
                }}
              >
                <TxLink hash={h()} color="var(--ok)" />
              </div>
              <p style={{ ...hintStyle(), "margin-bottom": "0" }}>
                Once it's in a block, the survey page will show it as “Linked to
                governance” after the indexer resolves the anchor.
              </p>
            </div>
          )}
        </Show>

        <Show when={error()}>
          <div style={noteStyle("danger")}>{error()}</div>
        </Show>
      </div>
    </main>
  );
};

// --- styles -----------------------------------------------------------------

const mono = (): JSX.CSSProperties => ({ "font-family": "var(--mono)" });

function backLinkStyle(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    "font-size": "13.5px",
    "font-weight": "600",
    color: "var(--muted)",
    "text-decoration": "none",
    padding: "6px 0",
  };
}
function govPillStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10px",
    "font-weight": "700",
    "letter-spacing": ".04em",
    "text-transform": "uppercase",
    color: "var(--gov)",
    background: "var(--gov-bg)",
    border: "1px solid var(--gov-line)",
    "border-radius": "var(--r-2xs)",
    padding: "4px 8px",
  };
}
function titleStyle(): JSX.CSSProperties {
  return {
    "font-size": "24px",
    "font-weight": "700",
    "letter-spacing": "-.018em",
    margin: "0",
    color: "var(--ink)",
  };
}
function leadStyle(): JSX.CSSProperties {
  return {
    "font-size": "14px",
    color: "var(--muted)",
    "line-height": "1.55",
    margin: "12px 0 0",
  };
}
function stepHeadStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "11px",
    "font-weight": "700",
    "letter-spacing": ".06em",
    "text-transform": "uppercase",
    color: "var(--dim)",
    margin: "24px 2px 0",
  };
}
function cardStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-md)",
    padding: "16px 18px",
    "margin-top": "10px",
  };
}
function labelStyle(): JSX.CSSProperties {
  return {
    "font-size": "12px",
    "font-weight": "700",
    color: "var(--muted)",
    "margin-bottom": "6px",
  };
}
function hintStyle(): JSX.CSSProperties {
  return {
    "font-size": "12px",
    color: "var(--dim)",
    "line-height": "1.5",
    margin: "10px 0 0",
  };
}
function codeStyle(): JSX.CSSProperties {
  return {
    margin: "0",
    background: "#0B0E14",
    "border-radius": "var(--r-control)",
    padding: "13px 14px",
    "font-family": "var(--mono)",
    "font-size": "11px",
    "line-height": "1.6",
    color: "#9FE7C0",
    "white-space": "pre-wrap",
    "word-break": "break-word",
    "max-height": "320px",
    overflow: "auto",
  };
}
function inputStyle(): JSX.CSSProperties {
  return {
    width: "100%",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-control)",
    padding: "11px 13px",
    "font-family": "var(--mono)",
    "font-size": "13px",
    color: "var(--ink)",
    outline: "none",
    "box-sizing": "border-box",
  };
}
function btnStyle(primary: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": "700",
    cursor: "pointer",
    "border-radius": "var(--r-input)",
    padding: "8px 13px",
    color: primary ? "#fff" : "var(--gov)",
    background: primary ? "var(--gov)" : "#fff",
    border: `1px solid ${primary ? "var(--gov)" : "var(--gov-line)"}`,
  };
}
function submitBtnStyle(enabled: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "14px",
    "font-weight": "700",
    cursor: enabled ? "pointer" : "not-allowed",
    color: "#fff",
    background: enabled ? "var(--gov)" : "var(--dim)",
    border: "none",
    "border-radius": "var(--r-md)",
    padding: "12px 20px",
    opacity: enabled ? "1" : ".7",
  };
}
function noteStyle(kind: "ok" | "warn" | "danger"): JSX.CSSProperties {
  const c = `var(--${kind})`;
  return {
    "font-size": "12.5px",
    color: c,
    background: `var(--${kind}-bg)`,
    border: `1px solid var(--${kind}-line)`,
    "border-radius": "var(--r-control)",
    padding: "11px 13px",
    "line-height": "1.5",
    "margin-bottom": "12px",
    "word-break": "break-word",
  };
}
