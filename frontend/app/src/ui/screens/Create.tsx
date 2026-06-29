import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import { createStore, type SetStoreFunction } from "solid-js/store";
import { A, useNavigate } from "@solidjs/router";
import {
  QuestionTag,
  ROLE_VALUES,
  Role,
  encodePayload,
  type Credential,
  type Metadatum,
} from "cip-179";

import { useApp } from "~/state";
import type { Network } from "~/config";
import type { ChainTip } from "~/data/source";
import { walletCredToCip179 } from "~/domain/roles";
import {
  QUESTION_TYPES,
  buildDefinition,
  buildPresentationDoc,
  initQuestionDraft,
  questionTypeLabel,
  usesOptions,
  type DefinitionMeta,
  type QuestionDraft,
  type QuestionType,
} from "~/domain/create";
import { IPFS_PROVIDERS } from "~/enrichment/providers";
import { hexToBytes } from "~/util/hex";
import {
  SubmitProgressModal,
  type SubmitStep,
} from "~/ui/components/SubmitProgress";
import { VisGlyph } from "~/ui/components/glyphs";
import { OnchainPreview } from "~/ui/components/OnchainPreview";
import { ErrorBox, ProblemList } from "~/ui/components/Feedback";
import { TxLink } from "~/ui/components/TxLink";
import {
  QUICKNET_CHAIN_HASH_HEX,
  autoRevealRound,
  formatEpochEndDate,
  formatRevealDate,
} from "~/tlock/drand";
import { networkMismatch, roleColors, roleLabel, shortRef } from "~/ui/format";
import type { WalletIdentity } from "~/wallet/types";
import { t, n } from "~/i18n";
import css from "./Create.module.css";

/**
 * Add-a-question buttons: one per type, in tag order. Custom is Pro-only.
 * `shortKey` is an i18n message key, translated at render time.
 */
const ADD_BUTTONS: ReadonlyArray<{
  type: QuestionType;
  shortKey:
    | "create.addSingle"
    | "create.addMulti"
    | "create.addRanking"
    | "create.addNumeric"
    | "create.addPoints"
    | "create.addRating"
    | "create.addCustom";
  tag: number;
}> = [
  {
    type: "singleChoice",
    shortKey: "create.addSingle",
    tag: QuestionTag.SingleChoice,
  },
  {
    type: "multiSelect",
    shortKey: "create.addMulti",
    tag: QuestionTag.MultiSelect,
  },
  { type: "ranking", shortKey: "create.addRanking", tag: QuestionTag.Ranking },
  {
    type: "numericRange",
    shortKey: "create.addNumeric",
    tag: QuestionTag.NumericRange,
  },
  {
    type: "pointsAllocation",
    shortKey: "create.addPoints",
    tag: QuestionTag.PointsAllocation,
  },
  { type: "rating", shortKey: "create.addRating", tag: QuestionTag.Rating },
  { type: "custom", shortKey: "create.addCustom", tag: QuestionTag.Custom },
];

// ----------------------------------------------------------------------------
// Screen
// ----------------------------------------------------------------------------

export const Create: Component = () => {
  const app = useApp();
  const identity = (): WalletIdentity | null => app.wallet()?.identity ?? null;

  // The survey is owned by the wallet's payment credential — it always signs the
  // funding tx, so ownership is proven automatically here and on a later cancel.
  const owner = createMemo<Credential | null>(() => {
    const id = identity();
    return id ? walletCredToCip179(id.payment) : null;
  });

  const [meta, setMeta] = createStore<DefinitionMeta>({
    title: "",
    description: "",
    eligibleRoles: [Role.Stakeholder],
    contentMode: "embedded",
    endEpoch: "",
    mode: "public",
    sealedRound: 0,
    sealedPadding: 0, // 0 = auto (worst-case size, computed in buildDefinition)
  });
  const [questions, setQuestions] = createStore<QuestionDraft[]>([
    initQuestionDraft("singleChoice"),
  ]);

  // Sealed config: derive the reveal round from the end epoch ("auto"), or let
  // the creator pin a round directly ("manual").
  const [drandMode, setDrandMode] = createSignal<"auto" | "manual">("auto");
  const [drandRoundText, setDrandRoundText] = createSignal("");

  // Seed a sensible default end epoch once the tip is known (don't clobber
  // input): the next epoch, the soonest a survey can still be open on arrival.
  createEffect(() => {
    const tip = app.snapshot()?.tip;
    if (tip && meta.endEpoch === "") setMeta("endEpoch", String(tip.epoch + 1));
  });

  // Auto reveal round: the first drand round a couple of minutes after the end
  // epoch closes. 0 until the tip + a valid end epoch are known.
  const autoRound = createMemo<number>(() => {
    const tip = app.snapshot()?.tip;
    const end = Number(meta.endEpoch.trim());
    if (!tip || meta.endEpoch.trim() === "" || !Number.isInteger(end)) return 0;
    return autoRevealRound(
      end,
      tip.epoch,
      tip.time,
      tip.epochSlot,
      app.config.secondsPerEpoch,
    );
  });

  // Keep the definition's resolved round in sync with the chosen drand mode.
  // Manual entry is a Pro-only affordance; Plain mode is always Auto.
  createEffect(() => {
    const manual = app.ui.pro && drandMode() === "manual";
    setMeta("sealedRound", manual ? intOf(drandRoundText()) : autoRound());
  });

  const built = createMemo(() => {
    const o = owner();
    return o ? buildDefinition(o, meta, questions) : null;
  });
  const problems = (): string[] => built()?.problems ?? [];

  // Pro on-chain preview: the label-17 definition payload, built live. External
  // content uses the same placeholder anchor `built` validates with (the real
  // anchor is only known after pinning at publish time).
  const previewPayload = createMemo<Metadatum | undefined>(() => {
    if (!app.ui.pro) return undefined;
    const b = built();
    if (!b) return undefined;
    try {
      return encodePayload({
        type: "definitions",
        definitions: [b.definition],
      });
    } catch {
      return undefined;
    }
  });

  // The padding size actually used for sealed responses — the auto worst-case
  // size unless the creator overrode it. Shown in the sealed config.
  const resolvedPadding = (): number => {
    const b = built();
    return b && b.definition.submissionMode.type === "sealed"
      ? b.definition.submissionMode.paddingSize
      : 0;
  };

  const [submitting, setSubmitting] = createSignal(false);
  const [busyText, setBusyText] = createSignal(t("create.busyPublishing"));
  const [stepKey, setStepKey] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [showProblems, setShowProblems] = createSignal(false);

  // External-content publishing pins the presentation doc first, so the submit
  // becomes two visible steps (drives the progress overlay); embedded is one.
  const submitSteps = createMemo<SubmitStep[]>(() => {
    const steps: SubmitStep[] = [];
    if (meta.contentMode === "external")
      steps.push({ key: "pin", label: t("create.stepPin") });
    steps.push({
      key: "submit",
      label: t("create.stepSubmit"),
    });
    return steps;
  });

  // External-content authoring pins the presentation document, which needs at
  // least one IPFS provider configured in Settings.
  const hasPinning = (): boolean =>
    IPFS_PROVIDERS.some((p) => app.ipfsTokens[p.id]?.trim());
  const externalNoTokens = (): boolean =>
    meta.contentMode === "external" && !hasPinning();
  // Block publishing while the wallet is on a different network than the app:
  // the build would otherwise fail deep in evolution-sdk with a confusing error
  // instead of a clear, up-front reason. Mirrors the respond + propose gates.
  const mismatch = (): boolean =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  const toggleRole = (r: Role) =>
    setMeta("eligibleRoles", (rs) =>
      rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r],
    );

  const addQuestion = (type: QuestionType) =>
    setQuestions(questions.length, initQuestionDraft(type));
  const removeQuestion = (i: number) =>
    setQuestions((qs) => qs.filter((_, k) => k !== i));

  const onPublish = async () => {
    const b = built();
    const o = owner();
    if (!b || !o) return;
    if (b.problems.length > 0 || externalNoTokens()) {
      setShowProblems(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setStepKey(submitSteps()[0]?.key ?? "submit");
    try {
      let definition = b.definition;
      if (meta.contentMode === "external") {
        // Pin the presentation document, then rebuild the definition with the
        // real anchor (the preview used a placeholder so the codec accepted the
        // count forms). The on-chain payload carries only the anchor + counts.
        setBusyText(t("create.busyPinning"));
        const { pinJson } = await import("~/enrichment/pin");
        const doc = buildPresentationDoc(meta, questions);
        const pinned = await pinJson(doc, "survey.json", app.ipfsTokens);
        // Cache the doc we just authored so its survey renders with full labels
        // immediately, without re-fetching it from IPFS.
        app.cachePresentationDoc(pinned.hash, doc);
        definition = buildDefinition(o, meta, questions, {
          uri: pinned.uri,
          hash: pinned.hash,
        }).definition;
      }
      setStepKey("submit");
      setBusyText(t("create.busySubmitting"));
      const payload = encodePayload({
        type: "definitions",
        definitions: [definition],
      });
      // Definitions must prove the owner credential (CIP-179 mechanism A) — the
      // owner is what authorizes a later cancellation.
      const hash = await app.submitMetadata(payload, [o]);
      setTxHash(hash);
      // Show the survey right away (the wallet accepted it, so it will land) and
      // track inclusion to confirm. No reload — the optimistic copy is on-chain.
      app.trackTx({
        txHash: hash,
        kind: "survey",
        surveyKey: `${hash}:0`,
        title: meta.title.trim() || undefined,
      });
      app.addOptimisticSurvey({
        txHash: hash,
        slot: 0, // unknown until indexed; not surfaced for a fresh survey
        ref: { txId: hexToBytes(hash), index: 0 },
        definition,
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setBusyText(t("create.busyPublishing"));
      setStepKey(null);
    }
  };

  // Submitted: full-width receipt. Not connected: full-width prompt.
  return (
    <Show
      when={txHash() === null}
      fallback={
        <main class={css.singleColMain}>
          <BackLink />
          <SubmittedPanel hash={txHash()!} />
        </main>
      }
    >
      <Show
        when={identity()}
        fallback={
          <main class={css.singleColMain}>
            <BackLink />
            <ConnectPrompt />
          </main>
        }
      >
        <main class={css.main}>
          <Show when={submitting() && submitSteps().length > 1}>
            <SubmitProgressModal
              title={t("create.progressTitle")}
              steps={submitSteps()}
              currentKey={stepKey()}
            />
          </Show>

          <BackLink />
          <h1 class={css.title}>{t("create.pageTitle")}</h1>
          <p class={css.subtitle}>{t("create.pageSubtitle")}</p>

          <div class={`create-grid ${css.gridTop}`}>
            {/* left: builder */}
            <div>
              <DetailsSection meta={meta} setMeta={setMeta} />
              <OwnerSection identity={identity()!} />
              <RolesSection roles={meta.eligibleRoles} onToggle={toggleRole} />
              <TimingSection
                value={meta.endEpoch}
                onInput={(v) => setMeta("endEpoch", v)}
                tip={app.snapshot()?.tip}
                secondsPerEpoch={app.config.secondsPerEpoch}
                network={app.config.network}
              />
              <VisibilitySection
                mode={meta.mode}
                onMode={(m) => setMeta("mode", m)}
                drandMode={drandMode()}
                onDrandMode={setDrandMode}
                drandRoundText={drandRoundText()}
                onDrandRoundText={setDrandRoundText}
                resolvedRound={meta.sealedRound}
                paddingOverride={meta.sealedPadding}
                onPaddingOverride={(n) => setMeta("sealedPadding", n)}
                resolvedPadding={resolvedPadding()}
                pro={app.ui.pro}
              />
              <ContentSection
                mode={meta.contentMode}
                onMode={(m) => setMeta("contentMode", m)}
                hasPinning={hasPinning()}
              />

              <div class={css.questionsSection}>
                <SectionHead
                  n="07"
                  label={t("create.sectionQuestions")}
                  trailing={questions.length}
                />
                <div class={css.questionList}>
                  <For each={questions}>
                    {(q, i) => (
                      <QuestionEditor
                        index={i()}
                        draft={q}
                        set={setQuestions}
                        canRemove={questions.length > 1}
                        onRemove={() => removeQuestion(i())}
                      />
                    )}
                  </For>
                </div>
                <div class={css.addPanel}>
                  <div class={css.addPanelHead}>{t("create.addAQuestion")}</div>
                  <div class={css.addBtnRow}>
                    <For
                      each={
                        app.ui.pro
                          ? ADD_BUTTONS
                          : ADD_BUTTONS.filter((b) => b.type !== "custom")
                      }
                    >
                      {(b) => (
                        <button
                          type="button"
                          onClick={() => addQuestion(b.type)}
                          class={css.addTypeBtn}
                        >
                          <span class={css.addTypeTag}>{b.tag}</span>
                          {t(b.shortKey)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>

              <Show when={showProblems() && problems().length > 0}>
                <ProblemList
                  title={t("create.fixBeforePublishing")}
                  problems={problems()}
                />
              </Show>
              <Show when={submitError()}>
                <ErrorBox message={submitError()!} />
              </Show>
            </div>

            {/* right: summary + publish */}
            <aside class="create-aside">
              <SummaryCard meta={meta} qCount={questions.length} />
              <Show when={app.ui.pro}>
                <OnchainPreview payload={previewPayload()} />
              </Show>
              <PublishButton
                problemCount={problems().length}
                blockedReason={
                  mismatch()
                    ? t("create.publishBlockedNetwork", {
                        network: app.config.network,
                      })
                    : externalNoTokens()
                      ? t("create.publishBlockedNoIpfs")
                      : null
                }
                submitting={submitting()}
                busyText={busyText()}
                paymentHashHex={identity()!.payment.hashHex}
                onPublish={() => void onPublish()}
              />
            </aside>
          </div>
        </main>
      </Show>
    </Show>
  );
};

const BackLink: Component = () => (
  <A href="/" class={css.backLink}>
    <span class={css.backArrow}>←</span> {t("create.backToSurveys")}
  </A>
);

// ----------------------------------------------------------------------------
// Meta sections
// ----------------------------------------------------------------------------

const DetailsSection: Component<{
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

const RolesSection: Component<{
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

const TimingSection: Component<{
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

const ContentSection: Component<{
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

const VisibilitySection: Component<{
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

const OwnerSection: Component<{ identity: WalletIdentity }> = (props) => (
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

// ----------------------------------------------------------------------------
// Question editor
// ----------------------------------------------------------------------------

const QuestionEditor: Component<{
  index: number;
  draft: QuestionDraft;
  set: SetStoreFunction<QuestionDraft[]>;
  canRemove: boolean;
  onRemove: () => void;
}> = (props) => {
  const i = () => props.index;
  return (
    <div class={css.card}>
      <div class={css.qHeadRow}>
        <div class={css.qHeadLeft}>
          <span class={css.qChip}>
            {t("create.questionChip", { n: props.index + 1 })}
          </span>
          <select
            value={props.draft.type}
            onChange={(e) =>
              props.set(i(), "type", e.currentTarget.value as QuestionType)
            }
            class={css.select}
          >
            <For each={QUESTION_TYPES}>
              {(t) => <option value={t}>{questionTypeLabel(t)}</option>}
            </For>
          </select>
        </div>
        <div class={css.qHeadRight}>
          <button
            type="button"
            aria-pressed={props.draft.required}
            onClick={() => props.set(i(), "required", !props.draft.required)}
            class={css.requiredBtn}
            classList={{ [css.requiredBtnOn]: props.draft.required }}
          >
            {props.draft.required ? t("create.required") : t("create.optional")}
          </button>
          <Show when={props.canRemove}>
            <button
              type="button"
              onClick={() => props.onRemove()}
              class={css.removeBtn}
              aria-label={t("create.removeQuestion")}
            >
              ×
            </button>
          </Show>
        </div>
      </div>

      <input
        type="text"
        value={props.draft.prompt}
        placeholder={t("create.promptPlaceholder")}
        onInput={(e) => props.set(i(), "prompt", e.currentTarget.value)}
        class={css.promptInput}
      />

      <div class={css.typeFields}>
        <TypeFields index={i()} draft={props.draft} set={props.set} />
      </div>
    </div>
  );
};

const TypeFields: Component<{
  index: number;
  draft: QuestionDraft;
  set: SetStoreFunction<QuestionDraft[]>;
}> = (props) => {
  const i = () => props.index;
  // Add an option row; for multi-select / ranking, grow the max ceiling to the
  // new option count (it can never exceed the number of options anyway).
  const addOption = () => {
    const newCount = props.draft.labels.length + 1;
    props.set(i(), "labels", (ls) => [...ls, ""]);
    if (props.draft.type === "multiSelect") {
      props.set(i(), "maxSelections", (m) => Math.max(m, newCount));
    } else if (props.draft.type === "ranking") {
      props.set(i(), "maxRanked", (m) => Math.max(m, newCount));
    }
  };
  return (
    <>
      <Show when={usesOptions(props.draft.type)}>
        <OptionsEditor
          labels={props.draft.labels}
          onLabel={(j, v) => props.set(i(), "labels", j, v)}
          onAdd={addOption}
          onRemove={(j) =>
            props.set(i(), "labels", (ls) => ls.filter((_, k) => k !== j))
          }
        />
      </Show>

      <Show when={props.draft.type === "multiSelect"}>
        <MinMaxRow
          label={t("create.selectionsLabel")}
          min={props.draft.minSelections}
          max={props.draft.maxSelections}
          onMin={(v) => props.set(i(), "minSelections", v)}
          onMax={(v) => props.set(i(), "maxSelections", v)}
          minAllowed={0}
        />
      </Show>

      <Show when={props.draft.type === "ranking"}>
        <MinMaxRow
          label={t("create.rankedLabel")}
          min={props.draft.minRanked}
          max={props.draft.maxRanked}
          onMin={(v) => props.set(i(), "minRanked", v)}
          onMax={(v) => props.set(i(), "maxRanked", v)}
          minAllowed={1}
        />
      </Show>

      <Show when={props.draft.type === "numericRange"}>
        <NumericRow
          min={props.draft.numMin}
          max={props.draft.numMax}
          step={props.draft.numStep}
          onMin={(v) => props.set(i(), "numMin", v)}
          onMax={(v) => props.set(i(), "numMax", v)}
          onStep={(v) => props.set(i(), "numStep", v)}
        />
      </Show>

      <Show when={props.draft.type === "pointsAllocation"}>
        <label class={css.inlineField}>
          <span class={css.fieldLabel}>{t("create.budget")}</span>
          <input
            type="number"
            value={props.draft.budget}
            onInput={(e) =>
              props.set(i(), "budget", intOf(e.currentTarget.value))
            }
            class={css.budgetInput}
          />
        </label>
      </Show>

      <Show when={props.draft.type === "rating"}>
        <div class={css.ratingBlock}>
          <div class={css.ratingPillRow}>
            <button
              type="button"
              aria-pressed={props.draft.ratingScale === "numeric"}
              onClick={() => props.set(i(), "ratingScale", "numeric")}
              class={css.pill}
              classList={{
                [css.pillOn]: props.draft.ratingScale === "numeric",
              }}
            >
              {t("create.ratingNumericScale")}
            </button>
            <button
              type="button"
              aria-pressed={props.draft.ratingScale === "labels"}
              onClick={() => props.set(i(), "ratingScale", "labels")}
              class={css.pill}
              classList={{ [css.pillOn]: props.draft.ratingScale === "labels" }}
            >
              {t("create.ratingLabelledScale")}
            </button>
          </div>
          <Show
            when={props.draft.ratingScale === "numeric"}
            fallback={
              <OptionsEditor
                labels={props.draft.ratingLabels}
                addLabel={t("create.addLevel")}
                zeroBased
                endBadges
                hint={t("create.scaleHint")}
                onLabel={(j, v) => props.set(i(), "ratingLabels", j, v)}
                onAdd={() =>
                  props.set(i(), "ratingLabels", (ls) => [...ls, ""])
                }
                onRemove={(j) =>
                  props.set(i(), "ratingLabels", (ls) =>
                    ls.filter((_, k) => k !== j),
                  )
                }
              />
            }
          >
            <NumericRow
              min={props.draft.ratingMin}
              max={props.draft.ratingMax}
              step={props.draft.ratingStep}
              onMin={(v) => props.set(i(), "ratingMin", v)}
              onMax={(v) => props.set(i(), "ratingMax", v)}
              onStep={(v) => props.set(i(), "ratingStep", v)}
            />
          </Show>
        </div>
      </Show>

      <Show when={props.draft.type === "custom"}>
        <div class={css.customFields}>
          <label class={css.blockLabel}>
            <span class={css.fieldLabel}>{t("create.customUriLabel")}</span>
            <input
              type="text"
              value={props.draft.customUri}
              placeholder={t("create.customUriPlaceholder")}
              onInput={(e) =>
                props.set(i(), "customUri", e.currentTarget.value)
              }
              class={css.customInput}
            />
          </label>
          <label class={css.blockLabel}>
            <span class={css.fieldLabel}>{t("create.customHashLabel")}</span>
            <input
              type="text"
              value={props.draft.customHash}
              placeholder={t("create.customHashPlaceholder")}
              onInput={(e) =>
                props.set(i(), "customHash", e.currentTarget.value)
              }
              class={css.customInput}
            />
          </label>
        </div>
      </Show>
    </>
  );
};

const OptionsEditor: Component<{
  labels: readonly string[];
  addLabel?: string;
  /** Show 0-based indices (rating labels store the 0-based level). */
  zeroBased?: boolean;
  /** Tag the first/last rows "worst"/"best" (ordered rating scale). */
  endBadges?: boolean;
  /** Optional mono hint line above the rows. */
  hint?: string;
  onLabel: (j: number, v: string) => void;
  onAdd: () => void;
  onRemove: (j: number) => void;
}> = (props) => (
  <div class={css.optionsList}>
    <Show when={props.hint}>
      <div class={css.scaleHint}>{props.hint}</div>
    </Show>
    <Index each={props.labels}>
      {(label, j) => (
        <div class={css.optionRow}>
          <span class={css.optIndex}>{props.zeroBased ? j : j + 1}</span>
          <input
            type="text"
            value={label()}
            placeholder={t("create.optionPlaceholder", { n: j + 1 })}
            onInput={(e) => props.onLabel(j, e.currentTarget.value)}
            class={css.optionInput}
          />
          <Show when={props.endBadges && j === 0}>
            <span class={css.endBadgeWorst}>{t("create.endBadgeWorst")}</span>
          </Show>
          <Show when={props.endBadges && j === props.labels.length - 1}>
            <span class={css.endBadgeBest}>{t("create.endBadgeBest")}</span>
          </Show>
          <Show when={props.labels.length > 2}>
            <button
              type="button"
              onClick={() => props.onRemove(j)}
              class={css.removeBtn}
              aria-label={t("create.removeOption", { n: j + 1 })}
            >
              ×
            </button>
          </Show>
        </div>
      )}
    </Index>
    <button
      type="button"
      onClick={() => props.onAdd()}
      class={css.addOptionBtn}
    >
      {props.addLabel ?? t("create.addOption")}
    </button>
  </div>
);

const MinMaxRow: Component<{
  label: string;
  min: number;
  max: number;
  onMin: (n: number) => void;
  onMax: (n: number) => void;
  minAllowed: number;
}> = (props) => (
  <div class={css.fieldRow}>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>
        {t("create.minOf", { label: props.label })}
      </span>
      <input
        type="number"
        min={props.minAllowed}
        value={props.min}
        onInput={(e) => props.onMin(intOf(e.currentTarget.value))}
        class={css.miniNumber}
      />
    </label>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>
        {t("create.maxOf", { label: props.label })}
      </span>
      <input
        type="number"
        value={props.max}
        onInput={(e) => props.onMax(intOf(e.currentTarget.value))}
        class={css.miniNumber}
      />
    </label>
  </div>
);

const NumericRow: Component<{
  min: string;
  max: string;
  step: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  onStep: (v: string) => void;
}> = (props) => (
  <div class={css.fieldRow}>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>{t("create.min")}</span>
      <input
        type="text"
        value={props.min}
        onInput={(e) => props.onMin(e.currentTarget.value)}
        class={css.miniNumber}
      />
    </label>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>{t("create.max")}</span>
      <input
        type="text"
        value={props.max}
        onInput={(e) => props.onMax(e.currentTarget.value)}
        class={css.miniNumber}
      />
    </label>
    <label class={css.inlineField}>
      <span class={css.fieldLabel}>{t("create.stepOptional")}</span>
      <input
        type="text"
        value={props.step}
        placeholder={t("create.numericStepPlaceholder")}
        onInput={(e) => props.onStep(e.currentTarget.value)}
        class={css.miniNumber}
      />
    </label>
  </div>
);

// ----------------------------------------------------------------------------
// Bar, panels, guards
// ----------------------------------------------------------------------------

const SectionHead: Component<{
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

const SummaryCard: Component<{ meta: DefinitionMeta; qCount: number }> = (
  props,
) => {
  const roleList = () =>
    props.meta.eligibleRoles.length === 0
      ? t("create.noRolesSelected")
      : [...props.meta.eligibleRoles]
          .sort((a, b) => a - b)
          .map(roleLabel)
          .join(", ");
  const ends = () =>
    props.meta.endEpoch.trim() === ""
      ? t("create.endsNone")
      : t("create.endsEpoch", { epoch: props.meta.endEpoch.trim() });
  const visibility = () =>
    props.meta.mode === "sealed"
      ? props.meta.sealedRound > 0
        ? t("create.summarySealedReveals", {
            date: formatRevealDate(props.meta.sealedRound),
          })
        : t("create.summarySealed")
      : t("create.summaryPublic");
  return (
    <div class={css.summaryCard}>
      <div class={css.numberedHead}>{t("create.summary")}</div>
      <h3 class={css.summaryTitle}>
        {props.meta.title.trim() || t("create.untitledSurvey")}
      </h3>
      <div class={css.summaryRows}>
        <SummaryRow
          label={t("create.summaryQuestions")}
          value={n(props.qCount)}
        />
        <SummaryRow label={t("create.summaryWhoResponds")} value={roleList()} />
        <SummaryRow label={t("create.summaryEnds")} value={ends()} />
        <SummaryRow
          label={t("create.summaryVisibility")}
          value={visibility()}
        />
      </div>
    </div>
  );
};

const SummaryRow: Component<{ label: string; value: string }> = (props) => (
  <div class={css.summaryRow}>
    <span class={css.summaryRowLabel}>{props.label}</span>
    <span class={css.summaryRowValue}>{props.value}</span>
  </div>
);

const PublishButton: Component<{
  problemCount: number;
  blockedReason: string | null;
  submitting: boolean;
  busyText: string;
  paymentHashHex: string;
  onPublish: () => void;
}> = (props) => {
  const ok = () => props.problemCount === 0 && !props.blockedReason;
  return (
    <>
      <button
        type="button"
        onClick={() => props.onPublish()}
        disabled={props.submitting || !!props.blockedReason}
        class={css.publishBtn}
        classList={{ [css.publishBtnEnabled]: ok() && !props.submitting }}
      >
        {props.submitting ? props.busyText : t("create.signAndPublish")}{" "}
        <span class={css.publishArrow}>→</span>
      </button>
      <p class={css.publishNote} classList={{ [css.publishNoteOk]: ok() }}>
        <Show
          when={ok()}
          fallback={
            props.blockedReason ??
            t("create.publishNoteProblems", {
              count: props.problemCount,
              plural:
                props.problemCount === 1 ? "" : t("create.problemPluralSuffix"),
            })
          }
        >
          {t("create.publishNoteOkPre")}
          <span class={css.mono}>key:{shortHash(props.paymentHashHex)}</span>
          {t("create.publishNoteOkPost")}
        </Show>
      </p>
    </>
  );
};

const SubmittedPanel: Component<{ hash: string }> = (props) => {
  const navigate = useNavigate();
  const surveyKey = `${props.hash}:0`;
  return (
    <div class={css.submittedCard}>
      <span class={css.submittedTick}>✓</span>
      <h3 class={css.submittedTitle}>{t("create.surveyPublished")}</h3>
      <p class={css.submittedBody}>{t("create.submittedBody")}</p>
      <div class={css.submittedRef}>
        <TxLink hash={props.hash} /> ·{" "}
        {t("create.submittedRef", { ref: shortRef(surveyKey) })}
      </div>
      <div class={css.submittedActions}>
        <button
          type="button"
          onClick={() => navigate(`/survey/${encodeURIComponent(surveyKey)}`)}
          class={css.submittedPrimary}
        >
          {t("create.viewSurvey")}
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          class={css.submittedSecondary}
        >
          {t("create.allSurveysButton")}
        </button>
      </div>
    </div>
  );
};

const ConnectPrompt: Component = () => (
  <div class={css.connectCard}>
    <div class={css.connectTitle}>{t("create.connectTitle")}</div>
    <p class={css.connectBody}>{t("create.connectBody")}</p>
  </div>
);

// ----------------------------------------------------------------------------
// helpers + styles
// ----------------------------------------------------------------------------

function intOf(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}
