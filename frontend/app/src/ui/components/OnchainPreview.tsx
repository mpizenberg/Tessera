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
} from "solid-js";
import type { Metadatum } from "cip-179";

import { bytesToHex } from "~/util/hex";
import { metadatumToDiagnostic } from "~/util/cbor-diagnostic";
import { MAX_TX_BYTES, estimateMinFee, lovelaceToAda } from "~/domain/fee";
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { t, n } from "~/i18n";
import css from "./OnchainPreview.module.css";

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
    <div class={css.card}>
      <div class={css.head}>
        <span class={css.label}>
          {props.sealed
            ? t("onchainPreview.titleSealed")
            : t("onchainPreview.titlePublic")}
        </span>
        <Show when={props.sealed}>
          <span class={css.encBadge}>{t("onchainPreview.encBadge")}</span>
        </Show>
        <Show when={ready()}>
          {/* statLead carries margin-left:auto, so no spacer node is needed. */}
          <span class={css.statLead}>
            {t("onchainPreview.bytes", { size: n(size()) })}
          </span>
          <Show when={!props.sealed}>
            <span class={css.stat}>
              {t("onchainPreview.feeApprox", {
                ada: lovelaceToAda(estimateMinFee(size())),
              })}
            </span>
          </Show>
        </Show>
      </div>

      <Show
        when={ready()}
        fallback={
          <div class={css.empty}>
            {props.payload
              ? t("onchainPreview.encoding")
              : t("onchainPreview.emptyForm")}
          </div>
        }
      >
        <div class={css.controls}>
          <SegmentedToggle
            ariaLabel={t("onchainPreview.formatLabel")}
            value={view()}
            onChange={setView}
            options={[
              { value: "diag", label: t("onchainPreview.formatDiagnostic") },
              { value: "hex", label: t("onchainPreview.formatHex") },
            ]}
          />
          <button class={css.copy} onClick={copy}>
            {copied() ? t("onchainPreview.copied") : t("onchainPreview.copy")}
          </button>
        </div>

        <pre class={css.code}>{text()}</pre>

        <Show
          when={props.sealed}
          fallback={
            <p class={css.note}>
              {t("onchainPreview.notePublic", {
                size: n(size()),
                max: n(MAX_TX_BYTES),
              })}
            </p>
          }
        >
          <p class={css.note}>
            {t("onchainPreview.noteSealed", {
              padding:
                props.paddingSize != null
                  ? t("onchainPreview.noteSealedPadding", {
                      size: n(props.paddingSize),
                    })
                  : "",
            })}
          </p>
        </Show>
      </Show>
    </div>
  );
};
