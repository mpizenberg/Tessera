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
import css from "./Settings.module.css";

export const Settings: Component = () => {
  return (
    <main class={css.main}>
      <h1 class={css.title}>Settings</h1>
      <p class={css.lead}>
        Stored only in this browser. None of it touches the on-chain payload —
        surveys always validate and tally from chain data alone.
      </p>

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
    <Section head="Off-chain content storage">
      <h2 class={css.heading}>IPFS pinning services</h2>
      <p class={css.prose}>
        Needed only to <b>author</b> content the app stores off-chain — an
        external survey's presentation document, or a voter rationale. Enable
        one or more; each document is pinned to <b>every</b> enabled service in
        parallel for wider availability (same content hash everywhere). Embedded
        surveys and reading never need these.
      </p>
      <div class={css.enabledCount}>{enabledCount()} enabled</div>

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
                    {on() ? "Set" : "Not set"}
                  </span>
                </div>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={token()}
                  onInput={(e) => app.setIpfsToken(p.id, e.currentTarget.value)}
                  placeholder={p.tokenPlaceholder}
                  aria-label={`${p.label} API token`}
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
          Pinning keeps a document reachable; if it ever drops, surveys still
          validate and tally from on-chain data — only the presentation labels
          can't be rendered. The anchor hash is computed locally (
          <b>blake2b-256</b>) from the exact bytes uploaded, so a provider can't
          alter what you anchor. Tokens stay in this browser only.
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
    <Section head="Network & data source">
      <h2 class={css.heading}>Reading from Koios</h2>
      <p class={css.prose}>
        The app ships with a pre-configured Koios token that may get
        rate-limited under load. Paste your own to use it instead — it overrides
        the default and applies on save (the snapshot reloads). Switching
        network reloads the app on Explore to apply the new endpoint.
      </p>

      <dl class={css.factGrid}>
        <FactRow label="Network">
          <SegmentedToggle
            ariaLabel="Network"
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
        <FactRow label="Endpoint">
          <span class={css.endpoint}>{app.config.koiosUrl}</span>
        </FactRow>
        <FactRow label="Active token">
          <span
            class={css.statusBadge}
            classList={{ [css.statusBadgeOn]: !!app.koiosToken() }}
          >
            {app.koiosToken()
              ? overridden()
                ? "your token"
                : "app default"
              : "none"}
          </span>
        </FactRow>
      </dl>

      <label class={css.tokenLabel}>Your Koios token</label>
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
          placeholder="paste a Koios bearer token"
          aria-label="Koios bearer token"
          class={css.koiosInput}
        />
        <button
          class={css.btnPrimary}
          classList={{ [css.btnPrimaryOn]: dirty() }}
          disabled={!dirty()}
          onClick={save}
        >
          Save
        </button>
        <button class={css.btnGhost} disabled={!stored()} onClick={reset}>
          Use app default
        </button>
      </div>
      <Show when={saved()}>
        <div class={css.savedMsg}>✓ saved · snapshot reloaded</div>
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
    <Section head="Display">
      <h2 class={css.heading}>Detail level</h2>
      <p class={css.prose}>
        <b>Pro</b> mode surfaces technical detail across the app — survey refs,
        epochs, drand rounds, padding sizes, and extra authoring fields.{" "}
        <b>Plain</b> hides them. Also toggleable from the header.
      </p>
      <SegmentedToggle
        ariaLabel="Display mode"
        fontSize={12}
        buttonPadding="6px 16px"
        wrapStyle={{ "margin-top": "14px" }}
        value={app.ui.pro ? "pro" : "plain"}
        onChange={(v) => app.setPro(v === "pro")}
        options={[
          { value: "plain", label: "Plain" },
          { value: "pro", label: "Pro" },
        ]}
      />
    </Section>
  );
};
