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
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { LOCALES, locale, setLocale, t, n } from "~/i18n";
import css from "./Settings.module.css";

export const Settings: Component = () => {
  return (
    <main class={css.main}>
      <h1 class={css.title}>{t("settings.title")}</h1>
      <p class={css.lead}>{t("settings.lead")}</p>

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
  <div class={css.section}>
    <div class={css.sectionHead}>{props.head}</div>
    <div class={css.panel}>{props.children}</div>
  </div>
);

// --- IPFS pinning providers --------------------------------------------------

const ProvidersSection: Component = () => {
  const app = useApp();
  const enabledCount = () =>
    IPFS_PROVIDERS.filter((p) => app.ipfsTokens[p.id]?.trim()).length;

  return (
    <Section head={t("settings.storageSectionHead")}>
      <h2 class={css.heading}>{t("settings.storageHeading")}</h2>
      <p class={css.prose}>
        {t("settings.storageProse1")}
        <b>{t("settings.storageProseAuthor")}</b>
        {t("settings.storageProse2")}
        <b>{t("settings.storageProseEvery")}</b>
        {t("settings.storageProse3")}
      </p>
      <div class={css.enabledCount}>
        {t("settings.enabledCount", { count: n(enabledCount()) })}
      </div>

      <div class={css.providerList}>
        <For each={IPFS_PROVIDERS}>
          {(p) => {
            const token = () => app.ipfsTokens[p.id] ?? "";
            const on = () => !!token().trim();
            return (
              <div
                class={css.providerCard}
                classList={{ [css.providerCardOn]: on() }}
              >
                <div class={css.providerRow}>
                  <span
                    class={css.providerLabel}
                    classList={{ [css.providerLabelOn]: on() }}
                  >
                    {p.label}
                  </span>
                  <span
                    class={css.statusBadge}
                    classList={{ [css.statusBadgeOn]: on() }}
                  >
                    {on()
                      ? t("settings.providerSet")
                      : t("settings.providerNotSet")}
                  </span>
                </div>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={token()}
                  onInput={(e) => app.setIpfsToken(p.id, e.currentTarget.value)}
                  placeholder={p.tokenPlaceholder}
                  aria-label={t("settings.providerTokenLabel", {
                    provider: p.label,
                  })}
                  class={css.tokenInput}
                />
                <p class={css.providerHint}>{p.hint}</p>
              </div>
            );
          }}
        </For>
      </div>

      <div class={css.infoNote}>
        <span class={css.infoBadge}>i</span>
        <p class={css.noteText}>
          {t("settings.storageNote1")}
          <b>{t("settings.storageNoteBlake")}</b>
          {t("settings.storageNote2")}
        </p>
      </div>
    </Section>
  );
};

// --- Koios token override ----------------------------------------------------

const KoiosSection: Component = () => {
  const app = useApp();
  // Mirror the persisted override into a signal: `storedKoiosToken()` reads
  // localStorage (not reactive), so `dirty()` and the reset button wouldn't
  // refresh after save/reset without this. `storeKoiosToken` trims before
  // persisting, so we mirror the trimmed value to match.
  const [stored, setStored] = createSignal(storedKoiosToken() ?? "");
  const [draft, setDraft] = createSignal(stored());
  const [saved, setSaved] = createSignal(false);

  const overridden = () => app.koiosToken() !== envKoiosToken();
  const dirty = () => draft().trim() !== stored();

  const save = () => {
    app.setKoiosToken(draft());
    setStored(draft().trim());
    setSaved(true);
  };
  const reset = () => {
    setDraft("");
    app.setKoiosToken("");
    setStored("");
    setSaved(true);
  };

  return (
    <Section head={t("settings.koiosSectionHead")}>
      <h2 class={css.heading}>{t("settings.koiosHeading")}</h2>
      <p class={css.prose}>{t("settings.koiosProse")}</p>

      <dl class={css.factGrid}>
        <FactRow label={t("settings.networkLabel")}>
          <SegmentedToggle
            ariaLabel={t("settings.networkLabel")}
            fontSize={12}
            buttonPadding="6px 16px"
            value={app.config.network}
            onChange={(v) => app.setNetwork(v)}
            options={[
              { value: "preview", label: "Preview" },
              { value: "mainnet", label: "Mainnet" },
            ]}
          />
        </FactRow>
        <FactRow label={t("settings.endpointLabel")}>
          <span class={css.endpoint}>{app.config.koiosUrl}</span>
        </FactRow>
        <FactRow label={t("settings.activeTokenLabel")}>
          <span
            class={css.statusBadge}
            classList={{ [css.statusBadgeOn]: !!app.koiosToken() }}
          >
            {app.koiosToken()
              ? overridden()
                ? t("settings.tokenYours")
                : t("settings.tokenAppDefault")
              : t("settings.tokenNone")}
          </span>
        </FactRow>
      </dl>

      <label class={css.tokenLabel}>{t("settings.koiosTokenLabel")}</label>
      <div class={css.tokenRow}>
        <input
          type="password"
          autocomplete="off"
          spellcheck={false}
          value={draft()}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            setSaved(false);
          }}
          placeholder={t("settings.koiosTokenPlaceholder")}
          aria-label={t("settings.koiosTokenAria")}
          class={css.koiosInput}
        />
        <button
          class={css.btnPrimary}
          classList={{ [css.btnPrimaryOn]: dirty() }}
          disabled={!dirty()}
          onClick={save}
        >
          {t("settings.save")}
        </button>
        <button class={css.btnGhost} disabled={!stored()} onClick={reset}>
          {t("settings.useAppDefault")}
        </button>
      </div>
      <Show when={saved()}>
        <div class={css.savedMsg}>{t("settings.savedMsg")}</div>
      </Show>
    </Section>
  );
};

const FactRow: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <>
    <dt class={css.factLabel}>{props.label}</dt>
    <dd class={css.factValue}>{props.children}</dd>
  </>
);

// --- display preferences -----------------------------------------------------

const DisplaySection: Component = () => {
  const app = useApp();
  return (
    <Section head={t("settings.displaySectionHead")}>
      <h2 class={css.heading}>{t("settings.detailHeading")}</h2>
      <p class={css.prose}>
        <b>{t("settings.detailProsePro")}</b>
        {t("settings.detailProse1")}
        <b>{t("settings.detailProsePlain")}</b>
        {t("settings.detailProse2")}
      </p>
      <SegmentedToggle
        ariaLabel={t("settings.displayModeAria")}
        fontSize={12}
        buttonPadding="6px 16px"
        wrapStyle={{ "margin-top": "14px" }}
        value={app.ui.pro ? "pro" : "plain"}
        onChange={(v) => app.setPro(v === "pro")}
        options={[
          { value: "plain", label: t("settings.displayPlain") },
          { value: "pro", label: t("settings.displayPro") },
        ]}
      />

      <h2 class={css.subheading}>{t("settings.languageHeading")}</h2>
      <p class={css.prose}>{t("settings.languageProse")}</p>
      <SegmentedToggle
        ariaLabel={t("settings.languageHeading")}
        fontSize={12}
        buttonPadding="6px 16px"
        wrapStyle={{ "margin-top": "14px" }}
        value={locale()}
        onChange={(v) => void setLocale(v)}
        options={LOCALES.map((l) => ({ value: l.code, label: l.name }))}
      />
    </Section>
  );
};
