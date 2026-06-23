/**
 * Pro-mode "on-chain preview": shows exactly what a Create/Respond action will
 * write under metadata label 17 — the serialized byte size, an estimated min
 * fee, and the CBOR itself, copyable as raw hex or as diagnostic notation.
 *
 * The CBOR encoder lives in the wallet seam (evolution-sdk), so it's pulled in
 * lazily via dynamic import — this component and its callers stay out of that
 * dependency's static graph, keeping it off the main bundle. For a public
 * payload this is exactly what goes on-chain; for a sealed survey it's the
 * plaintext answers that get timelock-encrypted at submit time (we never
 * encrypt for the preview), and the note spells out the difference.
 */

import {
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";
import type { Metadatum } from "cip-179";

import { bytesToHex } from "~/util/hex";
import { metadatumToDiagnostic } from "~/util/cbor-diagnostic";
import { MAX_TX_BYTES, estimateMinFee, lovelaceToAda } from "~/domain/fee";

type View = "hex" | "diag";

export const OnchainPreview: Component<{
  /** The label-17 metadatum to preview, or undefined while the form is incomplete. */
  payload: Metadatum | undefined;
  /**
   * Sealed survey: `payload` is the *plaintext answers* that will be
   * timelock-encrypted on submit, not the final on-chain ciphertext. We never
   * encrypt for the preview, so we show the plaintext and explain the rest.
   */
  sealed?: boolean;
  /** Sealed: the byte size the ciphertext is zero-padded to (for the note). */
  paddingSize?: number | undefined;
}> = (props) => {
  // The CBOR encoder is in the wallet seam; load it once, lazily.
  const [cborMod] = createResource(() => import("~/wallet/cbor"));

  const bytes = createMemo<Uint8Array | undefined>(() => {
    const mod = cborMod();
    const p = props.payload;
    if (!mod || !p) return undefined;
    try {
      return mod.metadatumToCbor(p);
    } catch {
      return undefined;
    }
  });

  const hex = createMemo(() => {
    const b = bytes();
    return b ? bytesToHex(b) : "";
  });
  const diag = createMemo(() => {
    const p = props.payload;
    return p ? metadatumToDiagnostic(p) : "";
  });
  const size = () => bytes()?.length ?? 0;

  const [view, setView] = createSignal<View>("diag");
  const text = () => (view() === "hex" ? hex() : diag());

  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyTimer));
  const copy = () => {
    void navigator.clipboard?.writeText(text()).then(() => {
      setCopied(true);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(false), 1200);
    });
  };

  const ready = () => bytes() !== undefined;

  return (
    <div style={cardStyle()}>
      <div style={headStyle()}>
        <span style={labelStyle()}>
          {props.sealed ? "Plaintext to seal" : "On-chain preview"}
        </span>
        <Show when={props.sealed}>
          <span style={encBadgeStyle()}>encrypted on submit</span>
        </Show>
        <span style={{ "margin-left": "auto" }} />
        <Show when={ready()}>
          <span style={statStyle()}>{size().toLocaleString()} B</span>
          <Show when={!props.sealed}>
            <span style={statStyle()}>
              ≈ {lovelaceToAda(estimateMinFee(size()))} ₳
            </span>
          </Show>
        </Show>
      </div>

      <Show
        when={ready()}
        fallback={
          <div style={emptyStyle()}>
            {props.payload
              ? "Encoding…"
              : "Complete the form to preview the label-17 payload."}
          </div>
        }
      >
        <div style={controlsStyle()}>
          <div style={segWrapStyle()}>
            <button
              style={segStyle(view() === "diag")}
              onClick={() => setView("diag")}
            >
              Diagnostic
            </button>
            <button
              style={segStyle(view() === "hex")}
              onClick={() => setView("hex")}
            >
              Hex
            </button>
          </div>
          <button style={copyStyle()} onClick={copy}>
            {copied() ? "Copied ✓" : "Copy"}
          </button>
        </div>

        <pre style={codeStyle()}>{text()}</pre>

        <Show
          when={props.sealed}
          fallback={
            <p style={noteStyle()}>
              Estimated min fee for a simple transaction — the real fee depends
              on coin selection and witnesses. Payload is{" "}
              {size().toLocaleString()} of {MAX_TX_BYTES.toLocaleString()} max
              tx bytes.
            </p>
          }
        >
          <p style={noteStyle()}>
            These are the answers as they'll be timelock-encrypted when you
            submit — nothing is encrypted yet. The on-chain payload will be the
            resulting ciphertext, zero-padded
            <Show when={props.paddingSize}>
              {" "}
              to {props.paddingSize!.toLocaleString()} B
            </Show>{" "}
            so its size never reveals how much you answered. The fee is computed
            at submit time.
          </p>
        </Show>
      </Show>
    </div>
  );
};

// --- styles -----------------------------------------------------------------

function cardStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-sm)",
    padding: "16px 18px",
    "margin-top": "12px",
  };
}
function headStyle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "8px",
    "flex-wrap": "wrap",
  };
}
function labelStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10px",
    "letter-spacing": ".08em",
    "text-transform": "uppercase",
    color: "var(--dim)",
    "font-weight": "600",
  };
}
function encBadgeStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "9.5px",
    "font-weight": "700",
    "letter-spacing": ".04em",
    "text-transform": "uppercase",
    color: "var(--warn)",
    background: "var(--warn-bg)",
    border: "1px solid var(--warn-line)",
    "border-radius": "var(--r-3xs)",
    padding: "2px 6px",
  };
}
function statStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "11.5px",
    "font-weight": "700",
    color: "var(--body)",
  };
}
function emptyStyle(): JSX.CSSProperties {
  return {
    "font-size": "12.5px",
    color: "var(--dim)",
    "line-height": "1.5",
    "margin-top": "10px",
  };
}
function controlsStyle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "10px",
    "margin-top": "12px",
  };
}
function segWrapStyle(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    background: "#F1EADC",
    border: "1px solid #E3DBC9",
    "border-radius": "9px",
    padding: "3px",
  };
}
function segStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "11.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    border: "none",
    "border-radius": "7px",
    padding: "5px 12px",
    background: on ? "var(--accent)" : "transparent",
    color: on ? "#fff" : "#857B6B",
  };
}
function copyStyle(): JSX.CSSProperties {
  return {
    "margin-left": "auto",
    "font-family": "inherit",
    "font-size": "12px",
    "font-weight": "700",
    cursor: "pointer",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-chip)",
    padding: "6px 12px",
    background: "#fff",
    color: "var(--accent)",
  };
}
function codeStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "11.5px",
    "line-height": "1.5",
    color: "#C4CCDA",
    background: "var(--ink)",
    "border-radius": "var(--r-control)",
    padding: "13px 14px",
    margin: "11px 0 0",
    "max-height": "260px",
    overflow: "auto",
    "white-space": "pre-wrap",
    "word-break": "break-all",
  };
}
function noteStyle(): JSX.CSSProperties {
  return {
    "font-size": "11px",
    color: "var(--dim)",
    "line-height": "1.5",
    margin: "10px 0 0",
  };
}
