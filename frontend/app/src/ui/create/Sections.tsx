/** The six numbered meta sections of the builder, in the order they render. */

import {
  For,
  Show,
  createEffect,
  createSignal,
  type Component,
} from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { A } from "@solidjs/router";
import { ROLE_VALUES, Role } from "cip-179";
import type { ChainTip } from "cip-179/domain";
import { QUICKNET_CHAIN_HASH_HEX } from "cip-179/tlock";

import type { Network } from "~/config";
import type { DefinitionMeta } from "~/domain/create";
import { formatEpochEndDate, formatRevealDate } from "~/tlock/drand";
import { roleColors, roleLabel, shortHash } from "~/ui/format";
import { VisGlyph } from "~/ui/components/glyphs";
import type { WalletIdentity } from "~/wallet/types";
import { t, n } from "~/i18n";
import { intOf } from "./Fields";
import css from "./create.module.css";

export const SectionHead: Component<{
  n: string;
  label: string;
  trailing?: number;
}> = (props) => (
  <div class={css.numberedHead}>
    {props.n} · {props.label}
    <Show when={props.trailing !== undefined}>
      <span class={css.headTrailing}> · {props.trailing}</span>
    </Show>
  </div>
);

export const DetailsSection: Component<{
  meta: DefinitionMeta;
  setMeta: SetStoreFunction<DefinitionMeta>;
}> = (props) => (
  <div>
    <SectionHead n="01" label={t("create.sectionBasics")} />
    <div class={css.card}>
      <label class={css.blockLabel}>
        <span class={css.fieldLabel}>{t("create.fieldTitle")}</span>
        <input
          type="text"
          value={props.meta.title}
          placeholder={t("create.titlePlaceholder")}
          onInput={(e) => props.setMeta("title", e.currentTarget.value)}
          class={css.textInput}
        />
      </label>
      <label class={css.blockLabelGap}>
        <span class={css.fieldLabel}>{t("create.fieldDescription")}</span>
        <textarea
          value={props.meta.description}
          placeholder={t("create.descriptionPlaceholder")}
          onInput={(e) => props.setMeta("description", e.currentTarget.value)}
          rows={3}
          class={css.textArea}
        />
      </label>
    </div>
  </div>
);

export const OwnerSection: Component<{ identity: WalletIdentity }> = (
  props,
) => (
  <div class={css.section}>
    <SectionHead n="02" label={t("create.sectionWhoCanCancel")} />
    <div class={css.cardSoft}>
      <div class={css.ownerText}>
        <b class={css.ownerHeading}>{t("create.ownerHeading")}</b>{" "}
        {t("create.ownerBody")}
        <span class={css.ownerKey}>
          key:{shortHash(props.identity.payment.hashHex)}
        </span>
      </div>
    </div>
  </div>
);

export const RolesSection: Component<{
  roles: readonly Role[];
  onToggle: (r: Role) => void;
}> = (props) => (
  <div class={css.section}>
    <SectionHead n="03" label={t("create.sectionWhoCanRespond")} />
    <div class={css.card}>
      <div class={css.rowWrap}>
        <For each={ROLE_VALUES}>
          {(r) => {
            const on = () => props.roles.includes(r);
            const [color, bg] = roleColors(r);
            return (
              <button
                type="button"
                aria-pressed={on()}
                onClick={() => props.onToggle(r)}
                class={css.roleToggle}
                classList={{ [css.roleToggleOn]: on() }}
                style={{ "--role-color": color, "--role-bg": bg }}
              >
                <span
                  class={css.checkbox}
                  classList={{ [css.checkboxOn]: on() }}
                >
                  <Show when={on()}>✓</Show>
                </span>
                {roleLabel(r)}
              </button>
            );
          }}
        </For>
      </div>
      <p class={css.hint}>{t("create.rolesHint")}</p>
    </div>
  </div>
);

export const TimingSection: Component<{
  value: string;
  onInput: (v: string) => void;
  tip: ChainTip | undefined;
  secondsPerEpoch: number;
  network: Network;
}> = (props) => {
  const tipEpoch = (): number | undefined => props.tip?.epoch;
  const govActionLifetime = (): number => props.tip?.govActionLifetime ?? 0;

  // Whether the creator plans to tie this survey to a governance Info Action.
  // The link itself is Action → Survey and lives off-chain in the action's
  // anchor, so this toggle changes no on-chain field directly. Its effect here
  // is that the end epoch is no longer free: it must equal the voting end epoch
  // of the Info Action that will advertise this survey, so we compute and lock
  // it instead of letting the creator type one that wouldn't match.
  const [govLinked, setGovLinked] = createSignal(false);

  // The voting deadline of an Info Action submitted in the current epoch:
  // `current + gov_action_lifetime` (the live protocol parameter, read from the
  // chain tip). The only end epoch a linked survey may carry. Undefined until
  // the tip loads, or if the parameter couldn't be read (lifetime 0) — in which
  // case we can't compute it and fall back to manual entry.
  const autoEndEpoch = (): number | undefined =>
    tipEpoch() === undefined || govActionLifetime() <= 0
      ? undefined
      : tipEpoch()! + govActionLifetime();

  // The wall-clock moment the current end epoch closes (responses stop), shown
  // like the sealed reveal time. Null until the tip loads or while the field is
  // empty/non-integer. An estimate (epoch length can change at a future fork).
  const endEpochDate = (): string | null => {
    const tip = props.tip;
    const n = Number(props.value.trim());
    if (!tip || props.value.trim() === "" || !Number.isInteger(n)) return null;
    return formatEpochEndDate(
      n,
      tip.epoch,
      tip.time,
      tip.epochSlot,
      props.secondsPerEpoch,
    );
  };

  // Lock the field only when linked *and* we actually have a value to lock to.
  const locked = (): boolean => govLinked() && autoEndEpoch() !== undefined;

  // While locked, drive the end epoch from the chain parameter, and keep it in
  // sync if the tip advances. Toggling off (or an unknown lifetime) leaves the
  // value in place and editable again.
  createEffect(() => {
    const auto = autoEndEpoch();
    if (govLinked() && auto !== undefined) props.onInput(String(auto));
  });

  // Soft warning: end_epoch must be later than the current epoch or the survey
  // is closed on arrival. (validateDefinition can't check this — it's ledger
  // state — so it's a client-side nudge, not a hard block.) Never fires while
  // linked: the auto value is always in the future.
  const tooEarly = () => {
    const n = Number(props.value.trim());
    return (
      tipEpoch() !== undefined &&
      props.value.trim() !== "" &&
      Number.isInteger(n) &&
      n <= tipEpoch()!
    );
  };
  return (
    <div class={css.section}>
      <SectionHead n="04" label={t("create.sectionTiming")} />
      <div class={css.card} classList={{ [css.govCard]: govLinked() }}>
        <button
          type="button"
          role="switch"
          aria-checked={govLinked()}
          onClick={() => setGovLinked((v) => !v)}
          class={css.govToggleRow}
        >
          <span
            class={css.govSwitchTrack}
            classList={{ [css.govSwitchTrackOn]: govLinked() }}
          >
            <span
              class={css.govSwitchKnob}
              classList={{ [css.govSwitchKnobOn]: govLinked() }}
            />
          </span>
          <span class={css.govToggleText}>
            <span
              class={css.govToggleTitle}
              classList={{ [css.govToggleTitleOn]: govLinked() }}
            >
              {t("create.govToggleTitle")}
            </span>
            <span class={css.govToggleDesc}>{t("create.govToggleDesc")}</span>
          </span>
        </button>

        <label class={css.endEpochField}>
          <span class={`${css.fieldLabel} ${css.endEpochLabel}`}>
            {t("create.endEpochLabel")}
            <Show when={locked()}>
              <span class={css.govAutoBadge}>
                {t("create.autoLockedBadge")}
              </span>
            </Show>
          </span>
          <input
            type="number"
            value={props.value}
            readOnly={locked()}
            aria-disabled={locked()}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            class={css.epochInput}
            classList={{ [css.epochInputLocked]: locked() }}
          />
        </label>
        <Show when={endEpochDate()}>
          {(date) => (
            <div class={css.revealLine}>
              {t("create.closesOn", { date: date() })}
            </div>
          )}
        </Show>
        <Show
          when={govLinked()}
          fallback={
            <p class={css.hint}>
              {t("create.acceptedThroughEpoch", {
                hint:
                  tipEpoch() !== undefined
                    ? t("create.currentEpochIs", { epoch: tipEpoch()! })
                    : t("create.loadingEpoch"),
              })}
            </p>
          }
        >
          <Show
            when={locked()}
            fallback={
              <div class={css.warnNote}>
                {t("create.govLifetimeUnreadable")}
              </div>
            }
          >
            <div class={css.govNote}>
              {t("create.govNoteIntro", {
                network: props.network,
                epochParen: tipEpoch() !== undefined ? ` (${tipEpoch()})` : "",
              })}{" "}
              <b>{autoEndEpoch()}</b> (
              <span class={css.mono}>
                gov_action_lifetime = {govActionLifetime()}
              </span>
              ){t("create.govNoteOutro")}
            </div>
          </Show>
        </Show>
        <Show when={!govLinked() && tooEarly()}>
          <div class={css.warnNote}>
            {t("create.tooEarlyWarning", { epoch: tipEpoch()! })}
          </div>
        </Show>
      </div>
    </div>
  );
};

export const VisibilitySection: Component<{
  mode: "public" | "sealed";
  onMode: (m: "public" | "sealed") => void;
  drandMode: "auto" | "manual";
  onDrandMode: (m: "auto" | "manual") => void;
  drandRoundText: string;
  onDrandRoundText: (v: string) => void;
  resolvedRound: number;
  paddingOverride: number;
  onPaddingOverride: (n: number) => void;
  resolvedPadding: number;
  pro: boolean;
}> = (props) => (
  <div class={css.section}>
    <SectionHead n="05" label={t("create.sectionVisibility")} />
    <div class={css.card}>
      <div class={css.modeGrid}>
        <button
          type="button"
          aria-pressed={props.mode === "public"}
          onClick={() => props.onMode("public")}
          class={css.modeCard}
          classList={{ [css.modeCardOn]: props.mode === "public" }}
        >
          <div class={css.modeTitle}>{t("create.visPublicTitle")}</div>
          <div class={css.modeDesc}>{t("create.visPublicDesc")}</div>
        </button>
        <button
          type="button"
          aria-pressed={props.mode === "sealed"}
          onClick={() => props.onMode("sealed")}
          class={css.modeCard}
          classList={{ [css.modeCardOn]: props.mode === "sealed" }}
        >
          <div class={css.modeTitleSealed}>
            <VisGlyph status="sealed" /> {t("create.visSealedTitle")}
          </div>
          <div class={css.modeDesc}>{t("create.visSealedDesc")}</div>
        </button>
      </div>

      <Show when={props.mode === "sealed"}>
        <div class={css.sealedConfig}>
          {/* Pro: pin chain + choose how the reveal round is set. Plain: Auto. */}
          <Show when={props.pro}>
            <div class={css.fieldLabel}>{t("create.drandChainLabel")}</div>
            <div class={css.chainHash}>
              {QUICKNET_CHAIN_HASH_HEX.slice(0, 6)}…
              {QUICKNET_CHAIN_HASH_HEX.slice(-3)} · quicknet
            </div>

            <div class={css.fieldLabelGap}>{t("create.revealRoundLabel")}</div>
            <div class={css.pillRow}>
              <button
                type="button"
                aria-pressed={props.drandMode === "auto"}
                onClick={() => props.onDrandMode("auto")}
                class={css.pill}
                classList={{ [css.pillOn]: props.drandMode === "auto" }}
              >
                {t("create.drandAuto")}
              </button>
              <button
                type="button"
                aria-pressed={props.drandMode === "manual"}
                onClick={() => props.onDrandMode("manual")}
                class={css.pill}
                classList={{ [css.pillOn]: props.drandMode === "manual" }}
              >
                {t("create.drandManual")}
              </button>
            </div>
            <Show
              when={props.drandMode === "manual"}
              fallback={<p class={css.hint}>{t("create.drandAutoHint")}</p>}
            >
              <input
                type="number"
                value={props.drandRoundText}
                placeholder={t("create.drandRoundPlaceholder")}
                onInput={(e) => props.onDrandRoundText(e.currentTarget.value)}
                class={css.roundInput}
              />
            </Show>
          </Show>

          <Show when={props.resolvedRound > 0}>
            <div class={css.revealLine}>
              <Show
                when={props.pro}
                fallback={t("create.revealsOn", {
                  date: formatRevealDate(props.resolvedRound),
                })}
              >
                {t("create.revealsRoundOn", {
                  round: n(props.resolvedRound),
                  date: formatRevealDate(props.resolvedRound),
                })}
              </Show>
            </div>
          </Show>

          <Show when={props.pro}>
            <label class={css.blockLabelGap}>
              <span class={css.fieldLabel}>{t("create.paddingLabel")}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={props.paddingOverride === 0 ? "" : props.paddingOverride}
                placeholder={t("create.paddingAutoPlaceholder", {
                  size: n(props.resolvedPadding),
                })}
                onInput={(e) => {
                  const v = e.currentTarget.value.trim();
                  const parsed = intOf(v);
                  // Positive integers only; blank or anything < 1 means auto.
                  props.onPaddingOverride(v === "" || parsed < 1 ? 0 : parsed);
                }}
                class={css.paddingInput}
              />
            </label>
            <p class={css.hint}>
              {t("create.paddingHint", { size: n(props.resolvedPadding) })}
            </p>
          </Show>

          <div class={css.sealedNote}>{t("create.sealedNote")}</div>
        </div>
      </Show>
    </div>
  </div>
);

export const ContentSection: Component<{
  mode: "embedded" | "external";
  onMode: (m: "embedded" | "external") => void;
  hasPinning: boolean;
}> = (props) => (
  <div class={css.section}>
    <SectionHead n="06" label={t("create.sectionContent")} />
    <div class={css.card}>
      <div class={css.modeGrid}>
        <button
          type="button"
          aria-pressed={props.mode === "embedded"}
          onClick={() => props.onMode("embedded")}
          class={css.modeCard}
          classList={{ [css.modeCardOn]: props.mode === "embedded" }}
        >
          <div class={css.modeTitle}>{t("create.contentEmbeddedTitle")}</div>
          <div class={css.modeDesc}>{t("create.contentEmbeddedDesc")}</div>
        </button>
        <button
          type="button"
          aria-pressed={props.mode === "external"}
          onClick={() => props.onMode("external")}
          class={css.modeCard}
          classList={{ [css.modeCardOn]: props.mode === "external" }}
        >
          <div class={css.modeTitle}>{t("create.contentExternalTitle")}</div>
          <div class={css.modeDesc}>{t("create.contentExternalDesc")}</div>
        </button>
      </div>

      <Show when={props.mode === "external"}>
        <p class={css.externalNote}>{t("create.contentExternalNote")}</p>
        <Show when={!props.hasPinning}>
          <div class={css.warnNote}>
            {t("create.contentNoPinningPre")}
            <A href="/settings" class={css.settingsLink}>
              {t("create.contentNoPinningLink")}
            </A>
            {t("create.contentNoPinningPost")}
          </div>
        </Show>
      </Show>
    </div>
  </div>
);
