/**
 * The kind-independent half of linking a survey to a governance action: load a
 * CIP-108 anchor document, validate its `body.cip179` link and `@context`, get
 * its blake2b-256 hash and a hosted URL, and check epoch alignment. Everything
 * here is the same whatever action kind will carry the anchor (CIP-179 v5), so
 * it is a reusable widget: Tessera's Info-Action helper embeds it, and a user
 * building any other action with their own tooling gets a validated document,
 * its hash, and a URL to drop into their action's anchor.
 *
 * State lives here; the parent learns the prepared result through {@link
 * LinkAnchorSectionProps.onChange} and adds whatever submit flow (if any) fits
 * the action kind it targets.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  type Component,
} from "solid-js";
import { A } from "@solidjs/router";

import { findSurvey, type SurveyRefLite } from "cip-179/domain";

import { useApp } from "~/state";
import {
  computeAlignment,
  loadAnchorFile,
  type LoadedAnchor,
} from "~/domain/anchorLink";
import { IPFS_PROVIDERS, type ProviderId } from "~/enrichment/providers";
import { Note } from "~/ui/components/Note";
import { isSafeAnchorUri } from "~/ui/format";
import { t } from "~/i18n";
import css from "./LinkAnchorSection.module.css";

/** The prepared anchor a parent needs to submit it (or `null` until ready). */
export interface PreparedAnchor {
  readonly anchor: LoadedAnchor;
  /** Trimmed anchor URL (may be empty). */
  readonly url: string;
  /** Whether `url` is a safe ipfs/https anchor URI. */
  readonly urlValid: boolean;
  /** True when shape problems or a hard misalignment should block submission. */
  readonly blocking: boolean;
  readonly surveyRef: SurveyRefLite | null;
  /** The linked survey's on-chain title, if it is indexed. */
  readonly linkedSurveyTitle: string | undefined;
}

export interface LinkAnchorSectionProps {
  /** Called whenever the prepared anchor changes (`null` = not ready). */
  readonly onChange: (prepared: PreparedAnchor | null) => void;
}

export const LinkAnchorSection: Component<LinkAnchorSectionProps> = (props) => {
  const app = useApp();
  const [anchor, setAnchor] = createSignal<LoadedAnchor | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [url, setUrl] = createSignal("");
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
    // Guard the resource read: a Solid resource throws on read in its error
    // state, which would replace this whole page with the LoadError fallback.
    const snap = app.list.error ? undefined : app.list();
    if (!ref || !snap) return undefined;
    const key = `${ref.txId}:${ref.index}`;
    return (
      findSurvey(snap.surveys, key) ??
      app.optimisticSurveys().find((s) => s.key === key)
    );
  });

  const alignment = createMemo(() => {
    const a = anchor();
    const tip = (app.list.error ? undefined : app.list())?.tip;
    return computeAlignment({
      hasLink: !!a?.surveyRef,
      tip: tip
        ? { epoch: tip.epoch, govActionLifetime: tip.govActionLifetime }
        : undefined,
      surveyEndEpoch: linkedSurvey()?.record.definition.endEpoch,
    });
  });

  // Submission is blocked while the document is malformed or won't align — both
  // mean the resulting action wouldn't be a valid CIP-179 survey link.
  const blocking = () =>
    (anchor()?.problems.length ?? 0) > 0 || alignment()?.level === "danger";

  // The anchor URL is written verbatim into on-chain governance metadata and is
  // later rendered as a clickable link. Restrict it to the same ipfs/https
  // allow-list the read path enforces, so a `javascript:`, `data:`, or plain
  // `http:` URL can never be committed to the chain.
  const urlValid = () => isSafeAnchorUri(url().trim());

  // Publish the prepared state upward reactively. The callback runs untracked:
  // a parent handler that reads its own signals (e.g. to diff against the
  // previous prepared state) must not become a dependency of this effect, or
  // its own set-calls re-trigger the effect in an infinite loop.
  createEffect(() => {
    const a = anchor();
    if (!a) {
      untrack(() => props.onChange(null));
      return;
    }
    const payload: PreparedAnchor = {
      anchor: a,
      url: url().trim(),
      urlValid: urlValid(),
      blocking: blocking(),
      surveyRef: a.surveyRef,
      linkedSurveyTitle: linkedSurvey()?.record.definition.title,
    };
    untrack(() => props.onChange(payload));
  });

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setLoadError(null);
    try {
      const loaded = await loadAnchorFile(file);
      setAnchor(loaded);
      // A fresh document invalidates anything tied to the previous one.
      setUrl("");
      setPinnedBy(null);
      setPinError(null);
    } catch (e) {
      setAnchor(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  // Pin the *exact* loaded bytes to the configured providers and auto-fill the
  // URL with the returned ipfs:// URI. We pin the bytes verbatim, so the
  // provider serves back the same document and pin.hash === the anchor hash.
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

  return (
    <>
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
    </>
  );
};
