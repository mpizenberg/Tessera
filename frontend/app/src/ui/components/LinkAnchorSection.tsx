/**
 * The hosting half of linking a survey to a governance action: given the ready
 * document (already linked, already serialized), show its exact bytes and
 * hash, offer IPFS pinning and download, and collect the anchor URL. The
 * boundary it draws — document vs. submission — is what survives when action
 * kinds beyond the Info Action get their own submit flows.
 *
 * State lives here; the parent learns the prepared result through {@link
 * LinkAnchorSectionProps.onChange} and adds whatever submit flow (if any) fits
 * the action kind it targets.
 */

import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  untrack,
  type Component,
} from "solid-js";
import { A } from "@solidjs/router";

import type { SurveyRefLite } from "cip-179/domain";

import { useApp } from "~/state";
import type { LoadedAnchor } from "~/domain/anchorLink";
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
  /** The emitted, already-linked document whose bytes are being hosted. */
  readonly anchor: LoadedAnchor;
  /** The linked survey's on-chain title (labels the queued action). */
  readonly surveyTitle: string | undefined;
  /** Hard epoch misalignment — blocks submission alongside shape problems. */
  readonly misaligned: boolean;
  /** Called whenever the prepared anchor changes. */
  readonly onChange: (prepared: PreparedAnchor) => void;
}

export const LinkAnchorSection: Component<LinkAnchorSectionProps> = (props) => {
  const app = useApp();
  const [url, setUrl] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [pinning, setPinning] = createSignal(false);
  const [pinnedBy, setPinnedBy] = createSignal<ProviderId[] | null>(null);
  const [pinError, setPinError] = createSignal<string | null>(null);

  // A different document invalidates anything tied to the previous one.
  createEffect(
    on(
      () => props.anchor.hashHex,
      () => {
        setUrl("");
        setPinnedBy(null);
        setPinError(null);
      },
      { defer: true },
    ),
  );

  // Whether the user has at least one IPFS provider configured in Settings.
  const hasPinning = () =>
    IPFS_PROVIDERS.some((p) => app.ipfsTokens[p.id]?.trim());

  // Submission is blocked while the document is malformed or won't align — both
  // mean the resulting action wouldn't be a valid CIP-179 survey link.
  const blocking = () => props.anchor.problems.length > 0 || props.misaligned;

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
    const payload: PreparedAnchor = {
      anchor: props.anchor,
      url: url().trim(),
      urlValid: urlValid(),
      blocking: blocking(),
      surveyRef: props.anchor.surveyRef,
      linkedSurveyTitle: props.surveyTitle,
    };
    untrack(() => props.onChange(payload));
  });

  // Pin the *exact* emitted bytes to the configured providers and auto-fill the
  // URL with the returned ipfs:// URI. We pin the bytes verbatim, so the
  // provider serves back the same document and pin.hash === the anchor hash.
  const pinToIpfs = async () => {
    const a = props.anchor;
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
    try {
      await navigator.clipboard.writeText(props.anchor.hashHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the hash is on screen */
    }
  };

  const download = () => {
    const a = props.anchor;
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
      <div class={css.stepHead}>{t("linkSurvey.step2Head")}</div>
      <div class={css.card}>
        <div class={css.label}>{t("linkSurvey.ready")}</div>
        <div class={css.loadedName}>{props.anchor.fileName}</div>

        {/* Belt: emitted documents should always validate clean, but a shape
            problem here means the generator drifted from the validators. */}
        <Show when={props.anchor.problems.length > 0}>
          <Note kind="danger">
            <div class={css.problemsTitle}>{t("linkSurvey.problemsTitle")}</div>
            <ul class={css.problemsList}>
              <For each={props.anchor.problems}>{(p) => <li>{p}</li>}</For>
            </ul>
          </Note>
        </Show>

        <Show when={props.anchor.surveyRef}>
          {(ref) => (
            <>
              <div class={css.label}>{t("linkSurvey.linksToSurvey")}</div>
              <div class={css.surveyRef}>
                {ref().txId}
                <span class={css.refIndex}>
                  {t("linkSurvey.refIndex", { index: ref().index })}
                </span>
              </div>
            </>
          )}
        </Show>

        <Show
          when={hasPinning()}
          fallback={
            <p class={css.hint}>
              {t("linkSurvey.hostHintPre")}
              <A href="/settings" class={css.settingsLink}>
                {t("linkSurvey.settingsLinkText")}
              </A>
              {t("linkSurvey.hostHintPost")}
            </p>
          }
        >
          <p class={css.hint}>{t("linkSurvey.pinHint")}</p>
        </Show>

        <div class={css.actionRow}>
          <Show when={hasPinning()}>
            <button
              onClick={() => void pinToIpfs()}
              disabled={pinning()}
              class={css.btnPrimary}
            >
              {pinning() ? t("linkSurvey.pinning") : t("linkSurvey.pinToIpfs")}
            </button>
          </Show>
          <button
            onClick={download}
            classList={{
              [css.btn]: hasPinning(),
              [css.btnPrimary]: !hasPinning(),
            }}
          >
            {t("linkSurvey.downloadJsonld")}
          </button>
          <button onClick={() => void copyHash()} class={css.btn}>
            {copied()
              ? t("linkSurvey.copiedHash")
              : t("linkSurvey.copyAnchorHash")}
          </button>
        </div>

        <Show when={pinnedBy()}>
          {(by) => (
            <Note kind="ok">
              {t("linkSurvey.pinnedNote", { providers: by().join(", ") })}
            </Note>
          )}
        </Show>
        <Show when={pinError()}>
          <Note kind="danger">{pinError()}</Note>
        </Show>

        <div class={css.label}>{t("linkSurvey.anchorHashLabel")}</div>
        <div class={css.hashValue}>{props.anchor.hashHex}</div>
        <pre class={css.code}>{props.anchor.text}</pre>

        <input
          type="url"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          placeholder={t("linkSurvey.urlPlaceholder")}
          class={css.inputSpaced}
        />
        <p class={css.hint}>{t("linkSurvey.urlHint")}</p>
        <Show when={url().trim() !== "" && !urlValid()}>
          <Note kind="danger">
            {t("linkSurvey.urlInvalidPre")}
            <span class={css.mono}>ipfs://</span>
            {t("linkSurvey.urlInvalidMid")}
            <span class={css.mono}>https://</span>
            {t("linkSurvey.urlInvalidPost")}
          </Note>
        </Show>
      </div>
    </>
  );
};
