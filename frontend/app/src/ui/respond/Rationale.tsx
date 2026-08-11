import {
  Show,
  createSignal,
  type Accessor,
  type Component,
  type Setter,
} from "solid-js";
import { A } from "@solidjs/router";
import { SPEC_VERSION, type ContentAnchor } from "cip-179";
import { hexToBytes } from "cip-179/domain";

import { useApp } from "~/state";
import { IPFS_PROVIDERS } from "~/enrichment/providers";
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { t } from "~/i18n";
import css from "./respond.module.css";

/** How the voter supplies the document: write it here, or paste one already hosted. */
export type RationaleMode = "write" | "manual";

/** A parsed pasted anchor, or every reason it could not be parsed. */
export type ManualAnchor =
  | { readonly ok: true; readonly anchor: ContentAnchor | undefined }
  | { readonly ok: false; readonly problems: readonly string[] };

export type Rationale = {
  readonly on: Accessor<boolean>;
  readonly setOn: Setter<boolean>;
  readonly mode: Accessor<RationaleMode>;
  readonly setMode: Setter<RationaleMode>;
  readonly text: Accessor<string>;
  readonly setText: Setter<string>;
  readonly uri: Accessor<string>;
  readonly setUri: Setter<string>;
  readonly hash: Accessor<string>;
  readonly setHash: Setter<string>;
  /** Whether any IPFS provider is configured, so writing can actually pin. */
  readonly hasPinning: Accessor<boolean>;
  /** Whether submitting will pin — an extra, network-bound step before signing. */
  readonly willPin: Accessor<boolean>;
  /**
   * The pasted anchor as the submit path needs it: validated, with its problems
   * reported rather than thrown. Pure — {@link preview} is the same read for a
   * memo, but silent, and a caller must not need both.
   */
  readonly parseManual: () => ManualAnchor;
  /** The anchor to show in the Pro preview: only a fully valid pasted one. */
  readonly preview: Accessor<ContentAnchor | undefined>;
  /**
   * The anchor to submit: pins the written text (uploading it), or passes the
   * already-parsed pasted one through. Throws if pinning fails.
   */
  readonly resolve: (
    manual: ContentAnchor | undefined,
  ) => Promise<ContentAnchor | undefined>;
};

/**
 * Optional voter rationale (Pro): an off-chain document, hash-anchored on the
 * response (CIP-179 key 5). Purely informational — no effect on validation or
 * tallies. Either *write* it, and the app pins it to your IPFS providers and
 * fills the anchor, or *paste* an already-hosted URI and its hash.
 *
 * Off entirely outside Pro mode, so every read below folds `app.ui.pro` in and
 * callers never have to.
 */
export function createRationale(): Rationale {
  const app = useApp();

  const [on, setOn] = createSignal(false);
  const hasPinning = (): boolean =>
    IPFS_PROVIDERS.some((p) => app.ipfsTokens[p.id]?.trim());
  const [mode, setMode] = createSignal<RationaleMode>(
    hasPinning() ? "write" : "manual",
  );
  const [text, setText] = createSignal("");
  const [uri, setUri] = createSignal("");
  const [hash, setHash] = createSignal("");

  /** Whether a pasted anchor is what this submission would carry. */
  const pasting = (): boolean => app.ui.pro && on() && mode() === "manual";

  return {
    on,
    setOn,
    mode,
    setMode,
    text,
    setText,
    uri,
    setUri,
    hash,
    setHash,
    hasPinning,
    willPin: () =>
      app.ui.pro && on() && mode() === "write" && text().trim() !== "",

    parseManual: () => {
      if (!pasting()) return { ok: true, anchor: undefined };
      const u = uri().trim();
      const problems: string[] = [];
      if (u === "") problems.push(t("respond.ratProblemUriRequired"));
      let bytes: Uint8Array | null = null;
      try {
        const b = hexToBytes(hash().trim());
        if (b.length !== 32) problems.push(t("respond.ratProblemHashBytes"));
        else bytes = b;
      } catch {
        problems.push(t("respond.ratProblemHashHex"));
      }
      return problems.length > 0 || !bytes
        ? { ok: false, problems }
        : { ok: true, anchor: { uri: u, hash: bytes } };
    },

    preview: () => {
      if (!pasting()) return undefined;
      const u = uri().trim();
      if (u === "") return undefined;
      try {
        const bytes = hexToBytes(hash().trim());
        return bytes.length === 32 ? { uri: u, hash: bytes } : undefined;
      } catch {
        return undefined;
      }
    },

    resolve: async (manual) => {
      if (!app.ui.pro || !on()) return undefined;
      if (mode() === "manual") return manual;
      const body = text().trim();
      if (body === "") return undefined;
      const { pinJson } = await import("~/enrichment/pin");
      const doc = {
        specVersion: SPEC_VERSION,
        kind: "cardano-survey-rationale",
        body: { comment: body },
      };
      const pinned = await pinJson(doc, "rationale.json", app.ipfsTokens);
      return { uri: pinned.uri, hash: pinned.hash };
    },
  };
}

/**
 * The section that drives it. One call site, so it takes the state whole rather
 * than restating all eleven of its fields as props.
 */
export const RationaleSection: Component<{ r: Rationale }> = (props) => (
  <div class={css.card}>
    <label class={css.ratToggleLabel}>
      <input
        type="checkbox"
        checked={props.r.on()}
        onChange={(e) => props.r.setOn(e.currentTarget.checked)}
        class={css.ratCheckbox}
      />
      <span class={css.ratToggleText}>
        {t("respond.ratToggle")}{" "}
        <span class={css.ratToggleHint}>{t("respond.ratToggleHint")}</span>
      </span>
    </label>
    <Show when={props.r.on()}>
      <div class={css.ratBody}>
        <SegmentedToggle
          ariaLabel={t("respond.ratSourceLabel")}
          wrapStyle={{ "align-self": "flex-start" }}
          value={props.r.mode()}
          onChange={props.r.setMode}
          options={[
            { value: "write", label: t("respond.ratModeWrite") },
            { value: "manual", label: t("respond.ratModeManual") },
          ]}
        />

        <Show
          when={props.r.mode() === "write"}
          fallback={
            <>
              <label class={css.ratField}>
                <span class={css.ratLabel}>{t("respond.ratDocUri")}</span>
                <input
                  type="text"
                  value={props.r.uri()}
                  placeholder={t("respond.ratDocUriPlaceholder")}
                  onInput={(e) => props.r.setUri(e.currentTarget.value)}
                  class={css.ratMonoInput}
                />
              </label>
              <label class={css.ratField}>
                <span class={css.ratLabel}>{t("respond.ratHashLabel")}</span>
                <input
                  type="text"
                  value={props.r.hash()}
                  placeholder={t("respond.ratHashPlaceholder")}
                  onInput={(e) => props.r.setHash(e.currentTarget.value)}
                  class={css.ratMonoInput}
                />
              </label>
              <p class={css.ratHint}>{t("respond.ratManualHint")}</p>
            </>
          }
        >
          <label class={css.ratField}>
            <span class={css.ratLabel}>{t("respond.ratWriteLabel")}</span>
            <textarea
              value={props.r.text()}
              rows={4}
              placeholder={t("respond.ratWritePlaceholder")}
              onInput={(e) => props.r.setText(e.currentTarget.value)}
              class={css.ratTextarea}
            />
          </label>
          <Show
            when={props.r.hasPinning()}
            fallback={
              <p class={css.ratWarn}>
                {t("respond.ratNoPinningBefore")}{" "}
                <A href="/settings" class={css.settingsLink}>
                  {t("respond.ratSettingsLink")}
                </A>{" "}
                {t("respond.ratNoPinningAfter")}
              </p>
            }
          >
            <p class={css.ratHint}>{t("respond.ratWriteHint")}</p>
          </Show>
        </Show>
      </div>
    </Show>
  </div>
);
