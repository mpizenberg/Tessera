import { Show, type Component } from "solid-js";
import { A } from "@solidjs/router";

import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { t } from "~/i18n";
import css from "./respond.module.css";

/**
 * Optional voter rationale (Pro). Attaches an off-chain document, tamper-evident
 * via its blake2b-256 hash, to the response (CIP-179 key 5). Purely
 * informational — no effect on validation or tallies — mirroring CIP-100/108
 * rationale conventions. Two ways to supply it: **write** the text and let the
 * app pin it to your IPFS providers (filling the anchor for you), or **paste**
 * an already-hosted URI + its hash.
 */
export const RationaleSection: Component<{
  on: boolean;
  mode: "write" | "manual";
  hasPinning: boolean;
  text: string;
  uri: string;
  hash: string;
  onToggle: (on: boolean) => void;
  onMode: (m: "write" | "manual") => void;
  onText: (v: string) => void;
  onUri: (v: string) => void;
  onHash: (v: string) => void;
}> = (props) => (
  <div class={css.card}>
    <label class={css.ratToggleLabel}>
      <input
        type="checkbox"
        checked={props.on}
        onChange={(e) => props.onToggle(e.currentTarget.checked)}
        class={css.ratCheckbox}
      />
      <span class={css.ratToggleText}>
        {t("respond.ratToggle")}{" "}
        <span class={css.ratToggleHint}>{t("respond.ratToggleHint")}</span>
      </span>
    </label>
    <Show when={props.on}>
      <div class={css.ratBody}>
        <SegmentedToggle
          ariaLabel={t("respond.ratSourceLabel")}
          wrapStyle={{ "align-self": "flex-start" }}
          value={props.mode}
          onChange={props.onMode}
          options={[
            { value: "write", label: t("respond.ratModeWrite") },
            { value: "manual", label: t("respond.ratModeManual") },
          ]}
        />

        <Show
          when={props.mode === "write"}
          fallback={
            <>
              <label class={css.ratField}>
                <span class={css.ratLabel}>{t("respond.ratDocUri")}</span>
                <input
                  type="text"
                  value={props.uri}
                  placeholder={t("respond.ratDocUriPlaceholder")}
                  onInput={(e) => props.onUri(e.currentTarget.value)}
                  class={css.ratMonoInput}
                />
              </label>
              <label class={css.ratField}>
                <span class={css.ratLabel}>{t("respond.ratHashLabel")}</span>
                <input
                  type="text"
                  value={props.hash}
                  placeholder={t("respond.ratHashPlaceholder")}
                  onInput={(e) => props.onHash(e.currentTarget.value)}
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
              value={props.text}
              rows={4}
              placeholder={t("respond.ratWritePlaceholder")}
              onInput={(e) => props.onText(e.currentTarget.value)}
              class={css.ratTextarea}
            />
          </label>
          <Show
            when={props.hasPinning}
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
