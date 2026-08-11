import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { A } from "@solidjs/router";
import {
  QuestionTag,
  Role,
  encodePayload,
  type Credential,
  type Metadatum,
} from "cip-179";
import { autoRevealRound } from "cip-179/tlock";

import { useApp } from "~/state";
import { ownerCredential } from "~/domain/roles";
import {
  buildDefinition,
  buildPresentationDoc,
  initQuestionDraft,
  type CreateProblem,
  type DefinitionMeta,
  type QuestionDraft,
  type QuestionType,
} from "~/domain/create";
import { IPFS_PROVIDERS } from "~/enrichment/providers";
import {
  SubmitProgressModal,
  type SubmitStep,
} from "~/ui/components/SubmitProgress";
import { OnchainPreview } from "~/ui/components/OnchainPreview";
import { ErrorBox, ProblemList } from "~/ui/components/Feedback";
import { PublishLocked, QueuedNote } from "~/ui/components/CartDrawer";
import { networkMismatch } from "~/ui/format";
import type { Action } from "~/wallet/action";
import type { WalletIdentity } from "~/wallet/types";
import { t } from "~/i18n";
import { problemText } from "~/i18n/problem";
import { intOf } from "./Fields";
import { QuestionEditor } from "./Question";
import {
  ContentSection,
  DetailsSection,
  OwnerSection,
  RolesSection,
  SectionHead,
  TimingSection,
  VisibilitySection,
} from "./Sections";
import {
  NoOwnerPanel,
  PublishButton,
  SubmittedPanel,
  SummaryCard,
} from "./Publish";
import css from "./create.module.css";

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

export const Create: Component = () => {
  const app = useApp();
  const identity = (): WalletIdentity | null => app.wallet()?.identity ?? null;

  // The survey is owned by the wallet's payment credential — it always signs the
  // funding tx, so ownership is proven automatically here and on a later cancel.
  // Undefined for a script-based wallet, which the builder refuses outright.
  const owner = createMemo<Credential | undefined>(() => {
    const id = identity();
    return id ? ownerCredential(id) : undefined;
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
    const tip = app.list()?.tip;
    if (tip && meta.endEpoch === "") setMeta("endEpoch", String(tip.epoch + 1));
  });

  // Auto reveal round: the first drand round a couple of minutes after the end
  // epoch closes. 0 until the tip + a valid end epoch are known.
  const autoRound = createMemo<number>(() => {
    const tip = app.list()?.tip;
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
    if (!o) return null;
    return buildDefinition(o, meta, questions, {
      tipEpoch: app.list()?.tip.epoch,
    });
  });
  const problems = (): CreateProblem[] => built()?.problems ?? [];
  /** Render structured codec problems in the active locale; pass strings through. */
  const renderProblems = (ps: readonly CreateProblem[]): string[] =>
    ps.map((p) => (typeof p === "string" ? p : problemText(p)));
  const problemStrings = (): string[] => renderProblems(problems());

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
  const [queued, setQueued] = createSignal(false);
  const [showProblems, setShowProblems] = createSignal(false);
  // With something already waiting, publishing this survey would publish that
  // too — so the button queues instead, and the cart is where it all goes out.
  const queueing = (): boolean => app.cart().length > 0;

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
  const externalNoTokens = (m: DefinitionMeta = meta): boolean =>
    m.contentMode === "external" && !hasPinning();
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

  const onPublish = async (queueOnly: boolean) => {
    const o = owner();
    if (!o) return;
    // Publish the form as it was when the button was clicked. Pinning awaits a
    // network round-trip and the progress overlay blocks the pointer but not the
    // keyboard, so reading the live stores afterwards could put never-validated
    // content on chain, or diverge the pinned document from the on-chain counts.
    const metaNow = structuredClone(unwrap(meta));
    const questionsNow = structuredClone(unwrap(questions));
    const b = buildDefinition(o, metaNow, questionsNow, {
      tipEpoch: app.list()?.tip.epoch,
    });
    if (b.problems.length > 0 || externalNoTokens(metaNow)) {
      setShowProblems(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setStepKey(submitSteps()[0]?.key ?? "submit");
    try {
      let definition = b.definition;
      if (metaNow.contentMode === "external") {
        // Pin the presentation document, then rebuild the definition with the
        // real anchor (the preview used a placeholder so the codec accepted the
        // count forms). The on-chain payload carries only the anchor + counts.
        setBusyText(t("create.busyPinning"));
        const { pinJson } = await import("~/enrichment/pin");
        const doc = buildPresentationDoc(metaNow, questionsNow);
        const pinned = await pinJson(doc, "survey.json", app.ipfsTokens);
        // Cache the doc we just authored so its survey renders with full labels
        // immediately, without re-fetching it from IPFS.
        app.cachePresentationDoc(pinned.hash, doc);
        const rebuilt = buildDefinition(o, metaNow, questionsNow, {
          contentAnchor: { uri: pinned.uri, hash: pinned.hash },
        });
        // Same inputs as the validated build with only the anchor swapped, so a
        // problem here is the anchor's — never publish it.
        if (rebuilt.problems.length > 0) {
          throw new Error(renderProblems(rebuilt.problems).join(" "));
        }
        definition = rebuilt.definition;
      }
      setStepKey("submit");
      setBusyText(t("create.busySubmitting"));
      // Definitions must prove the owner credential (CIP-179 mechanism A) — the
      // owner is what authorizes a later cancellation. The title is carried for
      // the cart and the pending indicator because an external-content
      // definition carries none on chain.
      const action: Action = {
        kind: "survey",
        definition,
        proveCredentials: [o],
        title: metaNow.title.trim() || undefined,
      };
      if (queueOnly) {
        app.enqueue([action]);
        setQueued(true);
        return;
      }
      const hashes = await app.submitOrQueue([action]);
      if (hashes) setTxHash(hashes[0] ?? null);
      else setQueued(true);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setBusyText(t("create.busyPublishing"));
      setStepKey(null);
    }
  };

  // Published or queued: full-width receipt. Not connected: full-width prompt.
  return (
    <Show
      when={txHash() === null && !queued()}
      fallback={
        <main class={css.singleColMain}>
          <BackLink />
          <Show
            when={txHash()}
            fallback={<QueuedNote body="cart.queuedSurveyBody" />}
          >
            {(hash) => <SubmittedPanel hash={hash()} />}
          </Show>
        </main>
      }
    >
      <Show
        when={owner()}
        fallback={
          <main class={css.singleColMain}>
            <BackLink />
            <NoOwnerPanel connected={identity() !== null} />
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
                tip={app.list()?.tip}
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
                  problems={problemStrings()}
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
              <Show when={!app.cartLocked()} fallback={<PublishLocked />}>
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
                  queueing={queueing()}
                  onPublish={() => void onPublish(false)}
                  onQueue={() => void onPublish(true)}
                />
              </Show>
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
