/**
 * Minimal one-off utility: build, sign and submit a Conway governance **Info
 * Action** proposal that advertises a CIP-179 survey, using the connected CIP-30
 * wallet. The proposal's anchor is a CIP-108 document the user loads from disk
 * (see {@link LoadedAnchor}) whose `body.cip179` carries the survey link.
 *
 * The anchor's on-chain hash must be computed over the *exact bytes* that get
 * hosted, so the page hashes the file bytes verbatim — the same bytes are
 * pinned/offered for download, so the served document always matches the hash.
 */

import {
  For,
  Show,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { blake2b } from "@noble/hashes/blake2.js";

import { useApp } from "~/state";
import { findSurvey } from "~/domain/survey";
import { bytesToHex } from "~/util/hex";
import { IPFS_PROVIDERS, type ProviderId } from "~/enrichment/providers";
import { TxLink } from "~/ui/components/TxLink";
import { isSafeAnchorUri, networkMismatch } from "~/ui/format";

/** The survey a well-formed anchor links to (tx id lower-cased, output index). */
interface SurveyRefLite {
  readonly txId: string;
  readonly index: number;
}

/**
 * An anchor document loaded from disk: the *exact* bytes (what the on-chain hash
 * commits to and what gets served), their blake2b-256 hash, the decoded text for
 * display, the survey ref pulled from `body.cip179`, and any shape problems
 * found while validating it.
 */
interface LoadedAnchor {
  readonly fileName: string;
  // Backed by a plain ArrayBuffer (from File.arrayBuffer), so it's a valid
  // BlobPart for the download below — not a SharedArrayBuffer-backed view.
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly text: string;
  readonly hash: Uint8Array;
  readonly hashHex: string;
  readonly surveyRef: SurveyRefLite | null;
  /** Human-readable shape problems; empty means a well-formed survey link. */
  readonly problems: readonly string[];
}

/**
 * Validate a loaded document against the CIP-108 + CIP-179 shape the discovery
 * layer (`parseGovLink` in {@link "~/data/koios"}) requires, and pull out the
 * survey ref. The rules mirror `parseGovLink`, so what passes here is exactly
 * what tooling will later treat as a link — but with per-issue messages for the
 * UI. Returns the ref (only when the link is well-formed) plus any problems.
 */
function validateAnchorShape(text: string): {
  surveyRef: SurveyRefLite | null;
  problems: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      surveyRef: null,
      problems: [`Not valid JSON: ${(e as Error).message}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { surveyRef: null, problems: ["Top level must be a JSON object."] };
  }
  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof obj["@context"] !== "object" || obj["@context"] === null) {
    problems.push('Missing JSON-LD "@context" (CIP-100/108 terms).');
  }
  const body = obj["body"];
  if (typeof body !== "object" || body === null) {
    problems.push('Missing CIP-108 "body" object.');
    return { surveyRef: null, problems };
  }
  const cip = (body as Record<string, unknown>)["cip179"];
  if (typeof cip !== "object" || cip === null) {
    problems.push('Missing "body.cip179" survey link.');
    return { surveyRef: null, problems };
  }
  const link = cip as Record<string, unknown>;
  if (link["kind"] !== "survey-link") {
    problems.push(
      `"body.cip179.kind" must be "survey-link" (got ${JSON.stringify(link["kind"])}).`,
    );
  }
  const txId = link["surveyTxId"];
  const txOk = typeof txId === "string" && /^[0-9a-fA-F]{64}$/.test(txId);
  if (!txOk) {
    problems.push(
      '"body.cip179.surveyTxId" must be a 64-char hex transaction id.',
    );
  }
  const index = link["surveyIndex"];
  const indexOk =
    typeof index === "number" && Number.isInteger(index) && index >= 0;
  if (!indexOk) {
    problems.push('"body.cip179.surveyIndex" must be a non-negative integer.');
  }
  const surveyRef =
    txOk && indexOk
      ? { txId: (txId as string).toLowerCase(), index: index as number }
      : null;
  return { surveyRef, problems };
}

export const ProposeInfoAction: Component = () => {
  const app = useApp();
  const [anchor, setAnchor] = createSignal<LoadedAnchor | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
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

  // The on-chain survey this anchor points at, once it's been indexed (or its
  // optimistic twin, for a survey just published this session).
  const linkedSurvey = createMemo(() => {
    const ref = anchor()?.surveyRef;
    const snap = app.snapshot();
    if (!ref || !snap) return undefined;
    const key = `${ref.txId}:${ref.index}`;
    return (
      findSurvey(snap.surveys, key) ??
      app.optimisticSurveys().find((s) => s.key === key)
    );
  });

  // Epoch-alignment check. An action submitted in the current epoch gets a
  // voting deadline of `tip.epoch + gov_action_lifetime`, and the discovery
  // layer links a survey only when its `end_epoch` equals that deadline. So the
  // two align exactly when this action is submitted in epoch
  // `survey.end_epoch − gov_action_lifetime`. Reactive on the tip and snapshot.
  const alignment = createMemo<{ level: NoteKind; text: string } | null>(() => {
    const a = anchor();
    if (!a || !a.surveyRef) return null; // no link → nothing to align
    const tip = app.snapshot()?.tip;
    if (!tip)
      return {
        level: "warn",
        text: "Chain tip not loaded yet — can't verify epoch alignment.",
      };
    const survey = linkedSurvey();
    if (!survey)
      return {
        level: "warn",
        text: "Linked survey isn't on-chain yet — can't verify its end_epoch. Make sure it's published and indexed.",
      };
    const lifetime = tip.govActionLifetime;
    if (lifetime <= 0)
      return {
        level: "warn",
        text: "gov_action_lifetime is unknown — can't compute the voting deadline.",
      };
    const surveyEnd = survey.record.definition.endEpoch;
    const deadlineIfNow = tip.epoch + lifetime;
    const submitEpoch = surveyEnd - lifetime;
    if (deadlineIfNow === surveyEnd)
      return {
        level: "ok",
        text: `Aligned — submitting now (epoch ${tip.epoch}) gives a voting deadline of epoch ${surveyEnd}, matching the survey's end_epoch.`,
      };
    if (tip.epoch < submitEpoch)
      return {
        level: "danger",
        text: `Too early — submit in epoch ${submitEpoch} (in ${submitEpoch - tip.epoch} more) to match the survey's end_epoch ${surveyEnd}. Submitting now would set the deadline to ${deadlineIfNow}.`,
      };
    return {
      level: "danger",
      text: `Window passed — the survey ends at epoch ${surveyEnd}, so this action had to be submitted in epoch ${submitEpoch}. Submitted now (epoch ${tip.epoch}) it would expire at ${deadlineIfNow} and can no longer link to that survey.`,
    };
  });

  // Submission is blocked while the document is malformed or won't align — both
  // mean the resulting action wouldn't be a valid CIP-179 survey link.
  const blocking = () =>
    (anchor()?.problems.length ?? 0) > 0 || alignment()?.level === "danger";

  // Read a chosen file as raw bytes (never re-encoded), hash it, and parse the
  // survey ref. Reading the bytes verbatim is what keeps the on-chain hash valid
  // against the document that later gets pinned/hosted.
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setLoadError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      const hash = blake2b(bytes, { dkLen: 32 });
      const { surveyRef, problems } = validateAnchorShape(text);
      setAnchor({
        fileName: file.name,
        bytes,
        text,
        hash,
        hashHex: bytesToHex(hash),
        surveyRef,
        problems,
      });
      // A fresh document invalidates anything tied to the previous one.
      setUrl("");
      setPinnedBy(null);
      setPinError(null);
      setTxHash(null);
      setError(null);
    } catch (e) {
      setAnchor(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  // Pin the *exact* loaded bytes to the configured providers and auto-fill the
  // URL with the returned ipfs:// URI. We pin the bytes verbatim, so the provider
  // serves back the same document and pin.hash === the anchor hash — the on-chain
  // hash stays correct whether pinned here or hosted by hand.
  const pinToIpfs = async () => {
    const a = anchor();
    if (!a) return;
    setPinning(true);
    setPinError(null);
    try {
      const { pinBytes } = await import("~/enrichment/pin");
      const res = await pinBytes(
        a.bytes,
        a.fileName,
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

  const mismatch = () =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);
  // The anchor URL is written verbatim into on-chain governance metadata and is
  // later rendered as a clickable link by explorers and this app. Restrict it to
  // the same ipfs/https allow-list the read path enforces, so a `javascript:`,
  // `data:`, or plain-`http:` URL can never be committed to the chain.
  const urlValid = () => isSafeAnchorUri(url().trim());
  const canSubmit = () =>
    !!anchor() &&
    !blocking() &&
    !!app.wallet() &&
    !mismatch() &&
    urlValid() &&
    !busy();

  const copyHash = async () => {
    const a = anchor();
    if (!a) return;
    try {
      await navigator.clipboard.writeText(a.hashHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the hash is on screen */
    }
  };

  const download = () => {
    const a = anchor();
    if (!a) return;
    const blob = new Blob([a.bytes], { type: "application/ld+json" });
    const href = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = href;
    el.download = a.fileName;
    el.click();
    URL.revokeObjectURL(href);
  };

  const submit = async () => {
    const a = anchor();
    if (!a || !canSubmit()) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await app.submitInfoAction(url().trim(), a.hash);
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

      {/* 1 · Load the anchor */}
      <div style={stepHeadStyle()}>1 · Load the anchor document</div>
      <div style={cardStyle()}>
        <p style={{ ...hintStyle(), "margin-top": "0" }}>
          Choose the CIP-108 anchor <span style={mono()}>.jsonld</span> file
          (its <span style={mono()}>body.cip179</span> carries the survey link).
          It's read locally — the on-chain hash is taken over the file's exact
          bytes, so they're never re-formatted.
        </p>
        <input
          type="file"
          accept=".jsonld,.json,application/ld+json,application/json"
          onChange={(e) => {
            void loadFile(e.currentTarget.files?.[0]);
            // Allow re-loading the same filename after an edit on disk.
            e.currentTarget.value = "";
          }}
          style={{ "font-size": "13px", "margin-top": "4px" }}
        />
        <Show when={loadError()}>
          <div style={{ ...noteStyle("danger"), "margin-top": "12px" }}>
            {loadError()}
          </div>
        </Show>
      </div>

      {/* 1b · Loaded document — survey ref, hash, publish */}
      <Show when={anchor()}>
        {(a) => (
          <div style={cardStyle()}>
            <div style={labelStyle()}>Loaded</div>
            <div
              style={{
                ...mono(),
                "font-size": "12.5px",
                color: "var(--ink)",
                "margin-bottom": "12px",
              }}
            >
              {a().fileName}
            </div>

            {/* Validation: shape problems block submission. */}
            <Show when={a().problems.length > 0}>
              <div style={noteStyle("danger")}>
                <div style={{ "font-weight": "700", "margin-bottom": "6px" }}>
                  Not a valid CIP-179 survey link:
                </div>
                <ul style={{ margin: "0", "padding-left": "18px" }}>
                  <For each={a().problems}>{(p) => <li>{p}</li>}</For>
                </ul>
              </div>
            </Show>

            {/* Extracted survey ref + on-chain match + epoch alignment. */}
            <Show when={a().surveyRef}>
              {(ref) => (
                <>
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
                  <Show when={linkedSurvey()}>
                    {(s) => (
                      <div style={{ ...hintStyle(), "margin-top": "6px" }}>
                        On-chain:{" "}
                        <b style={{ color: "var(--ink)" }}>
                          {s().record.definition.title || "Untitled survey"}
                        </b>{" "}
                        · end_epoch {s().record.definition.endEpoch}
                      </div>
                    )}
                  </Show>
                  <Show when={alignment()}>
                    {(c) => (
                      <div
                        style={{
                          ...noteStyle(c().level),
                          "margin-top": "12px",
                        }}
                      >
                        {c().text}
                      </div>
                    )}
                  </Show>
                </>
              )}
            </Show>

            <Show
              when={hasPinning()}
              fallback={
                <p style={hintStyle()}>
                  Host these exact bytes at a public URL (a GitHub raw link, or
                  add an IPFS provider in{" "}
                  <A href="/settings" style={{ color: "var(--gov)" }}>
                    Settings
                  </A>{" "}
                  to pin from here), then paste the URL in step 2.
                </p>
              }
            >
              <p style={hintStyle()}>
                Pin to the IPFS providers configured in your Settings, in one
                click. The exact bytes below are pinned, so the served document
                matches the on-chain hash.
              </p>
            </Show>

            <div
              style={{
                display: "flex",
                gap: "8px",
                "flex-wrap": "wrap",
                margin: "10px 0",
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
              {a().hashHex}
            </div>
            <pre style={codeStyle()}>{a().text}</pre>
          </div>
        )}
      </Show>

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
        <Show when={url().trim() !== "" && !urlValid()}>
          <div style={noteStyle("danger")}>
            The anchor URL must be an <span style={mono()}>ipfs://</span> or{" "}
            <span style={mono()}>https://</span> address — this one will be
            rejected before signing.
          </div>
        </Show>
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

        <Show when={anchor() && blocking() && !txHash()}>
          <div style={noteStyle("danger")}>
            Resolve the validation issues in step 1 before submitting — the
            action wouldn't be a valid CIP-179 survey link.
          </div>
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
type NoteKind = "ok" | "warn" | "danger";
function noteStyle(kind: NoteKind): JSX.CSSProperties {
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
