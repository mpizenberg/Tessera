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

import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { A } from "@solidjs/router";
import { blake2b } from "@noble/hashes/blake2.js";

import { useApp } from "~/state";
import { findSurvey } from "~/domain/survey";
import { parseCip179Link, type SurveyRefLite } from "~/domain/govLink";
import { bytesToHex } from "~/util/hex";
import { IPFS_PROVIDERS, type ProviderId } from "~/enrichment/providers";
import { TxLink } from "~/ui/components/TxLink";
import { Note, type NoteKind } from "~/ui/components/Note";
import { isSafeAnchorUri, networkMismatch } from "~/ui/format";
import { t, n } from "~/i18n";
import css from "./ProposeInfoAction.module.css";

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
      problems: [
        t("proposeInfoAction.problemNotJson", {
          message: (e as Error).message,
        }),
      ],
    };
  }
  // The survey-link shape itself is validated by the shared parser (single
  // source of truth with the discovery layer).
  const result = parseCip179Link(parsed);
  // UI-only nicety the discovery layer doesn't require: flag a missing JSON-LD
  // `@context`. It doesn't affect the extracted ref, so it's purely advisory.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (typeof (parsed as Record<string, unknown>)["@context"] !== "object" ||
      (parsed as Record<string, unknown>)["@context"] === null)
  ) {
    result.problems.unshift(t("proposeInfoAction.problemMissingContext"));
  }
  return result;
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
        text: t("proposeInfoAction.alignTipNotLoaded"),
      };
    const survey = linkedSurvey();
    if (!survey)
      return {
        level: "warn",
        text: t("proposeInfoAction.alignSurveyNotOnchain"),
      };
    const lifetime = tip.govActionLifetime;
    if (lifetime <= 0)
      return {
        level: "warn",
        text: t("proposeInfoAction.alignLifetimeUnknown"),
      };
    const surveyEnd = survey.record.definition.endEpoch;
    const deadlineIfNow = tip.epoch + lifetime;
    const submitEpoch = surveyEnd - lifetime;
    if (deadlineIfNow === surveyEnd)
      return {
        level: "ok",
        text: t("proposeInfoAction.alignAligned", {
          epoch: tip.epoch,
          end: surveyEnd,
        }),
      };
    if (tip.epoch < submitEpoch)
      return {
        level: "danger",
        text: t("proposeInfoAction.alignTooEarly", {
          submitEpoch,
          remaining: n(submitEpoch - tip.epoch),
          end: surveyEnd,
          deadline: deadlineIfNow,
        }),
      };
    return {
      level: "danger",
      text: t("proposeInfoAction.alignWindowPassed", {
        end: surveyEnd,
        submitEpoch,
        epoch: tip.epoch,
        deadline: deadlineIfNow,
      }),
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
      const ref = a.surveyRef;
      app.trackTx({
        txHash: hash,
        kind: "govAction",
        surveyKey: ref ? `${ref.txId}:${ref.index}` : undefined,
        title: linkedSurvey()?.record.definition.title,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class={css.main}>
      <A href="/" class={css.backLink}>
        <span class={css.backArrow}>←</span>{" "}
        {t("proposeInfoAction.backToSurveys")}
      </A>

      <div class={css.titleRow}>
        <span class={css.govPill}>{t("proposeInfoAction.govPill")}</span>
        <h1 class={css.title}>{t("proposeInfoAction.title")}</h1>
      </div>
      <p class={css.lead}>
        {t("proposeInfoAction.leadPre")}
        <b>Info Action</b>
        {t("proposeInfoAction.leadMid")}
        <span class={css.mono}>gov_action_deposit</span>
        {t("proposeInfoAction.leadPost")}
      </p>

      {/* 1 · Load the anchor */}
      <div class={css.stepHead}>{t("proposeInfoAction.step1Head")}</div>
      <div class={css.card}>
        <p class={css.hintFlush}>
          {t("proposeInfoAction.loadHintPre")}
          <span class={css.mono}>.jsonld</span>
          {t("proposeInfoAction.loadHintMid")}
          <span class={css.mono}>body.cip179</span>
          {t("proposeInfoAction.loadHintPost")}
        </p>
        <input
          type="file"
          accept=".jsonld,.json,application/ld+json,application/json"
          onChange={(e) => {
            void loadFile(e.currentTarget.files?.[0]);
            // Allow re-loading the same filename after an edit on disk.
            e.currentTarget.value = "";
          }}
          class={css.fileInput}
        />
        <Show when={loadError()}>
          <Note kind="danger" style={{ "margin-top": "12px" }}>
            {loadError()}
          </Note>
        </Show>
      </div>

      {/* 1b · Loaded document — survey ref, hash, publish */}
      <Show when={anchor()}>
        {(a) => (
          <div class={css.card}>
            <div class={css.label}>{t("proposeInfoAction.loaded")}</div>
            <div class={css.loadedName}>{a().fileName}</div>

            {/* Validation: shape problems block submission. */}
            <Show when={a().problems.length > 0}>
              <Note kind="danger">
                <div class={css.problemsTitle}>
                  {t("proposeInfoAction.problemsTitle")}
                </div>
                <ul class={css.problemsList}>
                  <For each={a().problems}>{(p) => <li>{p}</li>}</For>
                </ul>
              </Note>
            </Show>

            {/* Extracted survey ref + on-chain match + epoch alignment. */}
            <Show when={a().surveyRef}>
              {(ref) => (
                <>
                  <div class={css.label}>
                    {t("proposeInfoAction.linksToSurvey")}
                  </div>
                  <div class={css.surveyRef}>
                    {ref().txId}
                    <span class={css.refIndex}>
                      {t("proposeInfoAction.refIndex", { index: ref().index })}
                    </span>
                  </div>
                  <Show when={linkedSurvey()}>
                    {(survey) => (
                      <div class={css.hintTight}>
                        {t("proposeInfoAction.onchainPre")}
                        <b class={css.onchainTitle}>
                          {survey().record.definition.title ||
                            t("proposeInfoAction.untitledSurvey")}
                        </b>
                        {t("proposeInfoAction.onchainPost", {
                          endEpoch: survey().record.definition.endEpoch,
                        })}
                      </div>
                    )}
                  </Show>
                  <Show when={alignment()}>
                    {(c) => (
                      <Note kind={c().level} style={{ "margin-top": "12px" }}>
                        {c().text}
                      </Note>
                    )}
                  </Show>
                </>
              )}
            </Show>

            <Show
              when={hasPinning()}
              fallback={
                <p class={css.hint}>
                  {t("proposeInfoAction.hostHintPre")}
                  <A href="/settings" class={css.settingsLink}>
                    {t("proposeInfoAction.settingsLinkText")}
                  </A>
                  {t("proposeInfoAction.hostHintPost")}
                </p>
              }
            >
              <p class={css.hint}>{t("proposeInfoAction.pinHint")}</p>
            </Show>

            <div class={css.actionRow}>
              <Show when={hasPinning()}>
                <button
                  onClick={() => void pinToIpfs()}
                  disabled={pinning()}
                  class={css.btnPrimary}
                >
                  {pinning()
                    ? t("proposeInfoAction.pinning")
                    : t("proposeInfoAction.pinToIpfs")}
                </button>
              </Show>
              <button
                onClick={download}
                classList={{
                  [css.btn]: hasPinning(),
                  [css.btnPrimary]: !hasPinning(),
                }}
              >
                {t("proposeInfoAction.downloadJsonld")}
              </button>
              <button onClick={() => void copyHash()} class={css.btn}>
                {copied()
                  ? t("proposeInfoAction.copiedHash")
                  : t("proposeInfoAction.copyAnchorHash")}
              </button>
            </div>

            <Show when={pinnedBy()}>
              {(by) => (
                <Note kind="ok">
                  {t("proposeInfoAction.pinnedNote", {
                    providers: by().join(", "),
                  })}
                </Note>
              )}
            </Show>
            <Show when={pinError()}>
              <Note kind="danger">{pinError()}</Note>
            </Show>

            <div class={css.label}>
              {t("proposeInfoAction.anchorHashLabel")}
            </div>
            <div class={css.hashValue}>{a().hashHex}</div>
            <pre class={css.code}>{a().text}</pre>
          </div>
        )}
      </Show>

      {/* 2 · Anchor URL */}
      <div class={css.stepHead}>{t("proposeInfoAction.step2Head")}</div>
      <div class={css.card}>
        <input
          type="url"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          placeholder={t("proposeInfoAction.urlPlaceholder")}
          class={css.input}
        />
        <p class={css.hint}>{t("proposeInfoAction.urlHint")}</p>
        <Show when={url().trim() !== "" && !urlValid()}>
          <Note kind="danger">
            {t("proposeInfoAction.urlInvalidPre")}
            <span class={css.mono}>ipfs://</span>
            {t("proposeInfoAction.urlInvalidMid")}
            <span class={css.mono}>https://</span>
            {t("proposeInfoAction.urlInvalidPost")}
          </Note>
        </Show>
      </div>

      {/* 3 · Sign & submit */}
      <div class={css.stepHead}>{t("proposeInfoAction.step3Head")}</div>
      <div class={css.card}>
        <Show
          when={app.wallet()}
          fallback={
            <Note kind="warn">{t("proposeInfoAction.connectWallet")}</Note>
          }
        >
          <Show when={mismatch()}>
            <Note kind="danger">
              {t("proposeInfoAction.networkMismatch", {
                network: app.config.network,
              })}
            </Note>
          </Show>
        </Show>

        <Show when={anchor() && blocking() && !txHash()}>
          <Note kind="danger">{t("proposeInfoAction.resolveIssues")}</Note>
        </Show>

        <Show
          when={txHash()}
          fallback={
            <button
              onClick={() => void submit()}
              disabled={!canSubmit()}
              class={css.submitBtn}
              classList={{ [css.submitBtnEnabled]: canSubmit() }}
            >
              {busy()
                ? t("proposeInfoAction.building")
                : t("proposeInfoAction.submit")}
            </button>
          }
        >
          {(h) => (
            <Note kind="ok">
              <div class={css.submittedTitle}>
                {t("proposeInfoAction.submittedTitle")}
              </div>
              <div class={css.txLine}>
                <TxLink hash={h()} color="var(--ok)" />
              </div>
              <p class={css.hintNoBottom}>
                {t("proposeInfoAction.submittedHint")}
              </p>
            </Note>
          )}
        </Show>

        <Show when={error()}>
          <Note kind="danger">{error()}</Note>
        </Show>
      </div>
    </main>
  );
};
