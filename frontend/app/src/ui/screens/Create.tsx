import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
  type JSX,
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

/** Add-a-question buttons: one per type, in tag order. Custom is Pro-only. */
const ADD_BUTTONS: ReadonlyArray<{
  type: QuestionType;
  short: string;
  tag: number;
}> = [
  { type: "singleChoice", short: "Single", tag: QuestionTag.SingleChoice },
  { type: "multiSelect", short: "Multi", tag: QuestionTag.MultiSelect },
  { type: "ranking", short: "Ranking", tag: QuestionTag.Ranking },
  { type: "numericRange", short: "Numeric", tag: QuestionTag.NumericRange },
  {
    type: "pointsAllocation",
    short: "Points",
    tag: QuestionTag.PointsAllocation,
  },
  { type: "rating", short: "Rating", tag: QuestionTag.Rating },
  { type: "custom", short: "Custom", tag: QuestionTag.Custom },
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
  const [busyText, setBusyText] = createSignal("Publishing…");
  const [stepKey, setStepKey] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [showProblems, setShowProblems] = createSignal(false);

  // External-content publishing pins the presentation doc first, so the submit
  // becomes two visible steps (drives the progress overlay); embedded is one.
  const submitSteps = createMemo<SubmitStep[]>(() => {
    const steps: SubmitStep[] = [];
    if (meta.contentMode === "external")
      steps.push({ key: "pin", label: "Pinning the presentation to IPFS" });
    steps.push({
      key: "submit",
      label: "Signing & submitting the transaction",
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
        setBusyText("Pinning presentation…");
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
      setBusyText("Submitting…");
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
      setBusyText("Publishing…");
      setStepKey(null);
    }
  };

  // Submitted: full-width receipt. Not connected: full-width prompt.
  return (
    <Show
      when={txHash() === null}
      fallback={
        <main style={singleColMain()}>
          <BackLink />
          <SubmittedPanel hash={txHash()!} />
        </main>
      }
    >
      <Show
        when={identity()}
        fallback={
          <main style={singleColMain()}>
            <BackLink />
            <ConnectPrompt />
          </main>
        }
      >
        <main
          style={{
            "max-width": "1160px",
            margin: "0 auto",
            padding: "22px 24px 90px",
          }}
        >
          <Show when={submitting() && submitSteps().length > 1}>
            <SubmitProgressModal
              title="Publishing your survey"
              steps={submitSteps()}
              currentKey={stepKey()}
            />
          </Show>

          <BackLink />
          <h1 style={titleStyle()}>Create a survey</h1>
          <p style={subtitleStyle()}>
            Define the questions, who may respond, when it closes, and whether
            answers are public or sealed, then sign to publish the definition
            on-chain under metadata label 17.
          </p>

          <div class="create-grid" style={{ "margin-top": "20px" }}>
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

              <div style={{ "margin-top": "24px" }}>
                <SectionHead
                  n="07"
                  label="Questions"
                  trailing={questions.length}
                />
                <div
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    gap: "12px",
                  }}
                >
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
                <div style={addPanelStyle()}>
                  <div style={addPanelHeadStyle()}>Add a question</div>
                  <div
                    style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}
                  >
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
                          style={addTypeBtnStyle()}
                        >
                          <span
                            style={{
                              "font-family": "var(--mono)",
                              "font-size": "11px",
                              color: "var(--dim)",
                            }}
                          >
                            {b.tag}
                          </span>
                          {b.short}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>

              <Show when={showProblems() && problems().length > 0}>
                <ProblemList
                  title="Fix before publishing"
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
                    ? `Switch your wallet to ${app.config.network} before publishing`
                    : externalNoTokens()
                      ? "Add an IPFS provider in Settings to publish external content"
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
  <A href="/" style={backLinkStyle()}>
    <span style={{ "font-size": "15px" }}>←</span> All surveys
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
    <SectionHead n="01" label="Basics" />
    <div style={cardStyle()}>
      <label style={{ display: "block" }}>
        <span style={fieldLabelStyle()}>Title</span>
        <input
          type="text"
          value={props.meta.title}
          placeholder="e.g. Treasury priorities for next epoch"
          onInput={(e) => props.setMeta("title", e.currentTarget.value)}
          style={textInputStyle()}
        />
      </label>
      <label style={{ display: "block", "margin-top": "14px" }}>
        <span style={fieldLabelStyle()}>Description</span>
        <textarea
          value={props.meta.description}
          placeholder="Optional context for respondents."
          onInput={(e) => props.setMeta("description", e.currentTarget.value)}
          rows={3}
          style={{
            ...textInputStyle(),
            resize: "vertical",
            "font-family": "inherit",
          }}
        />
      </label>
    </div>
  </div>
);

const RolesSection: Component<{
  roles: readonly Role[];
  onToggle: (r: Role) => void;
}> = (props) => (
  <div style={{ "margin-top": "22px" }}>
    <SectionHead n="03" label="Who can respond" />
    <div style={cardStyle()}>
      <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
        <For each={ROLE_VALUES}>
          {(r) => {
            const on = () => props.roles.includes(r);
            const [color, bg] = roleColors(r);
            return (
              <button
                type="button"
                aria-pressed={on()}
                onClick={() => props.onToggle(r)}
                style={roleToggleStyle(on(), color, bg)}
              >
                <span style={checkboxStyle(on())}>
                  <Show when={on()}>✓</Show>
                </span>
                {roleLabel(r)}
              </button>
            );
          }}
        </For>
      </div>
      <p style={hintStyle()}>
        Eligibility is a claim, verified independently against ledger state. SPO
        and CC can be listed, but can't respond from a browser wallet (they need
        cold/hot keys).
      </p>
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
    <div style={{ "margin-top": "22px" }}>
      <SectionHead n="04" label="Timing" />
      <div style={govLinked() ? govCardStyle() : cardStyle()}>
        <button
          type="button"
          role="switch"
          aria-checked={govLinked()}
          onClick={() => setGovLinked((v) => !v)}
          style={govToggleRowStyle()}
        >
          <span style={govSwitchTrackStyle(govLinked())}>
            <span style={govSwitchKnobStyle(govLinked())} />
          </span>
          <span
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "2px",
              "text-align": "left",
            }}
          >
            <span
              style={{
                "font-size": "13px",
                "font-weight": "700",
                color: govLinked() ? "var(--gov)" : "var(--ink)",
              }}
            >
              Tie this survey to a governance Info Action
            </span>
            <span
              style={{
                "font-size": "11.5px",
                color: "var(--muted)",
                "line-height": "1.45",
              }}
            >
              An on-chain Info Action will advertise this survey and they close
              together.
            </span>
          </span>
        </button>

        <label style={{ display: "block", "margin-top": "18px" }}>
          <span
            style={{
              ...fieldLabelStyle(),
              display: "flex",
              "align-items": "center",
              gap: "8px",
            }}
          >
            End epoch (inclusive)
            <Show when={locked()}>
              <span style={govAutoBadgeStyle()}>auto · locked</span>
            </Show>
          </span>
          <input
            type="number"
            value={props.value}
            readOnly={locked()}
            aria-disabled={locked()}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            style={{
              ...textInputStyle(),
              "font-family": "var(--mono)",
              "max-width": "200px",
              ...(locked()
                ? {
                    background: "var(--surface3)",
                    color: "var(--gov)",
                    "border-color": "var(--gov-line)",
                    cursor: "not-allowed",
                  }
                : {}),
            }}
          />
        </label>
        <Show when={endEpochDate()}>
          {(date) => <div style={revealLineStyle()}>Closes ~{date()}</div>}
        </Show>
        <Show
          when={govLinked()}
          fallback={
            <p style={hintStyle()}>
              Responses are accepted through this epoch.{" "}
              <Show
                when={tipEpoch() !== undefined}
                fallback="Loading current epoch…"
              >
                Current epoch is <b>{tipEpoch()}</b>.
              </Show>
            </p>
          }
        >
          <Show
            when={locked()}
            fallback={
              <div style={warnNoteStyle()}>
                Couldn't read{" "}
                <span style={{ "font-family": "var(--mono)" }}>
                  gov_action_lifetime
                </span>{" "}
                from the chain, so the deadline can't be computed. Enter the
                Info Action's voting end epoch manually — they must match
                exactly.
              </div>
            }
          >
            <div style={govNoteStyle()}>
              Locked to the Info Action's voting deadline. On{" "}
              <b>{props.network}</b>, a governance action submitted this epoch
              {tipEpoch() !== undefined ? ` (${tipEpoch()})` : ""} closes at
              epoch <b>{autoEndEpoch()}</b> (
              <span style={{ "font-family": "var(--mono)" }}>
                gov_action_lifetime = {govActionLifetime()}
              </span>
              ), so the survey's end epoch must equal that. If you'll submit the
              action in a later epoch, untoggle and set a matching epoch by
              hand.
            </div>
          </Show>
        </Show>
        <Show when={!govLinked() && tooEarly()}>
          <div style={warnNoteStyle()}>
            End epoch must be later than the current epoch ({tipEpoch()}), or
            the survey is closed as soon as it's published.
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
  <div style={{ "margin-top": "22px" }}>
    <SectionHead n="06" label="Content" />
    <div style={cardStyle()}>
      <div
        style={{
          display: "grid",
          "grid-template-columns": "1fr 1fr",
          gap: "10px",
        }}
      >
        <button
          type="button"
          aria-pressed={props.mode === "embedded"}
          onClick={() => props.onMode("embedded")}
          style={modeCardStyle(props.mode === "embedded")}
        >
          <div style={modeTitleStyle()}>Embedded</div>
          <div style={modeDescStyle()}>
            All text on-chain. No external dependency — recommended.
          </div>
        </button>
        <button
          type="button"
          aria-pressed={props.mode === "external"}
          onClick={() => props.onMode("external")}
          style={modeCardStyle(props.mode === "external")}
        >
          <div style={modeTitleStyle()}>External</div>
          <div style={modeDescStyle()}>
            Prompts &amp; labels live in a pinned IPFS document; chain carries a
            hash anchor.
          </div>
        </button>
      </div>

      <Show when={props.mode === "external"}>
        <p
          style={{
            "font-size": "12.5px",
            color: "var(--muted)",
            "line-height": "1.5",
            margin: "14px 0 0",
          }}
        >
          On publish, the title, description, prompts and option labels are
          written to a <b>presentation document</b>, pinned to your IPFS
          providers, and anchored on-chain by its blake2b-256 hash. Only counts,
          constraints, owner and timing stay on-chain — so the survey still
          validates and tallies even if the document later becomes unreachable
          (only labels go missing). Keeps the on-chain payload small for large
          surveys.
        </p>
        <Show when={!props.hasPinning}>
          <div style={warnNoteStyle()}>
            No IPFS provider is configured.{" "}
            <A href="/settings" style={{ color: "var(--accent)" }}>
              Add one in Settings
            </A>{" "}
            to publish external content, or switch to Embedded.
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
  <div style={{ "margin-top": "22px" }}>
    <SectionHead n="05" label="Visibility" />
    <div style={cardStyle()}>
      <div
        style={{
          display: "grid",
          "grid-template-columns": "1fr 1fr",
          gap: "10px",
        }}
      >
        <button
          type="button"
          aria-pressed={props.mode === "public"}
          onClick={() => props.onMode("public")}
          style={modeCardStyle(props.mode === "public")}
        >
          <div style={modeTitleStyle()}>Public</div>
          <div style={modeDescStyle()}>
            Answers are plaintext, tallied as they arrive.
          </div>
        </button>
        <button
          type="button"
          aria-pressed={props.mode === "sealed"}
          onClick={() => props.onMode("sealed")}
          style={modeCardStyle(props.mode === "sealed")}
        >
          <div
            style={{
              ...modeTitleStyle(),
              display: "inline-flex",
              "align-items": "center",
              gap: "7px",
            }}
          >
            <VisGlyph status="sealed" /> Sealed
          </div>
          <div style={modeDescStyle()}>
            Timelock-encrypted; opens at a drand round.
          </div>
        </button>
      </div>

      <Show when={props.mode === "sealed"}>
        <div style={{ "margin-top": "16px" }}>
          {/* Pro: pin chain + choose how the reveal round is set. Plain: Auto. */}
          <Show when={props.pro}>
            <div style={fieldLabelStyle()}>Drand chain</div>
            <div style={chainHashStyle()}>
              {QUICKNET_CHAIN_HASH_HEX.slice(0, 6)}…
              {QUICKNET_CHAIN_HASH_HEX.slice(-3)} · quicknet
            </div>

            <div style={{ ...fieldLabelStyle(), "margin-top": "14px" }}>
              Reveal round
            </div>
            <div
              style={{ display: "flex", gap: "8px", "margin-bottom": "10px" }}
            >
              <button
                type="button"
                aria-pressed={props.drandMode === "auto"}
                onClick={() => props.onDrandMode("auto")}
                style={pillStyle(props.drandMode === "auto")}
              >
                Auto
              </button>
              <button
                type="button"
                aria-pressed={props.drandMode === "manual"}
                onClick={() => props.onDrandMode("manual")}
                style={pillStyle(props.drandMode === "manual")}
              >
                Manual
              </button>
            </div>
            <Show
              when={props.drandMode === "manual"}
              fallback={
                <p style={hintStyle()}>
                  Derived from the end epoch — the first drand round after
                  responses close.
                </p>
              }
            >
              <input
                type="number"
                value={props.drandRoundText}
                placeholder="drand round number"
                onInput={(e) => props.onDrandRoundText(e.currentTarget.value)}
                style={{
                  ...textInputStyle(),
                  "font-family": "var(--mono)",
                  "max-width": "240px",
                }}
              />
            </Show>
          </Show>

          <Show when={props.resolvedRound > 0}>
            <div style={revealLineStyle()}>
              <Show
                when={props.pro}
                fallback={<>Reveals {formatRevealDate(props.resolvedRound)}</>}
              >
                round {props.resolvedRound.toLocaleString()} · reveals{" "}
                {formatRevealDate(props.resolvedRound)}
              </Show>
            </div>
          </Show>

          <Show when={props.pro}>
            <label style={{ display: "block", "margin-top": "14px" }}>
              <span style={fieldLabelStyle()}>Padding size (bytes)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={props.paddingOverride === 0 ? "" : props.paddingOverride}
                placeholder={`auto · ${props.resolvedPadding}`}
                onInput={(e) => {
                  const v = e.currentTarget.value.trim();
                  const n = intOf(v);
                  // Positive integers only; blank or anything < 1 means auto.
                  props.onPaddingOverride(v === "" || n < 1 ? 0 : n);
                }}
                style={{
                  ...textInputStyle(),
                  "font-family": "var(--mono)",
                  "max-width": "160px",
                }}
              />
            </label>
            <p style={hintStyle()}>
              Each response is zero-padded to this length before encryption, so
              ciphertext size doesn't leak how much was answered. Leave blank to
              auto-size to the worst-case answer (<b>{props.resolvedPadding}</b>{" "}
              bytes for these questions).
            </p>
          </Show>

          <div
            style={{
              ...warnNoteStyle(),
              color: "#7A6A45",
              background: "#FBFAF6",
              border: "1px solid #F0EBD8",
            }}
          >
            Responses are encrypted as they come in and stay hidden until the
            reveal time — not even you can read them early.
          </div>
        </div>
      </Show>
    </div>
  </div>
);

const OwnerSection: Component<{ identity: WalletIdentity }> = (props) => (
  <div style={{ "margin-top": "22px" }}>
    <SectionHead n="02" label="Who can cancel" />
    <div
      style={{
        ...cardStyle(),
        background: "#FBFAF6",
        border: "1px solid #F0EBD8",
      }}
    >
      <div
        style={{
          "font-size": "12.5px",
          color: "#7A6A45",
          "line-height": "1.5",
        }}
      >
        <b style={{ color: "#5B4A22" }}>Owned by your payment credential.</b>{" "}
        You sign with it to publish, and only it can cancel this survey later.
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "11.5px",
            color: "var(--dim)",
            "margin-left": "6px",
          }}
        >
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
    <div style={cardStyle()}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "10px",
          "flex-wrap": "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "10px", "align-items": "center" }}>
          <span style={qChipStyle()}>Q{props.index + 1}</span>
          <select
            value={props.draft.type}
            onChange={(e) =>
              props.set(i(), "type", e.currentTarget.value as QuestionType)
            }
            style={selectStyle()}
          >
            <For each={QUESTION_TYPES}>
              {(t) => <option value={t}>{questionTypeLabel(t)}</option>}
            </For>
          </select>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <button
            type="button"
            aria-pressed={props.draft.required}
            onClick={() => props.set(i(), "required", !props.draft.required)}
            style={requiredBtnStyle(props.draft.required)}
          >
            {props.draft.required ? "Required" : "Optional"}
          </button>
          <Show when={props.canRemove}>
            <button
              type="button"
              onClick={() => props.onRemove()}
              style={removeBtnStyle()}
              aria-label="Remove question"
            >
              ×
            </button>
          </Show>
        </div>
      </div>

      <input
        type="text"
        value={props.draft.prompt}
        placeholder="Question prompt"
        onInput={(e) => props.set(i(), "prompt", e.currentTarget.value)}
        style={{ ...textInputStyle(), "margin-top": "12px" }}
      />

      <div style={{ "margin-top": "12px" }}>
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
          label="selections"
          min={props.draft.minSelections}
          max={props.draft.maxSelections}
          onMin={(n) => props.set(i(), "minSelections", n)}
          onMax={(n) => props.set(i(), "maxSelections", n)}
          minAllowed={0}
        />
      </Show>

      <Show when={props.draft.type === "ranking"}>
        <MinMaxRow
          label="ranked"
          min={props.draft.minRanked}
          max={props.draft.maxRanked}
          onMin={(n) => props.set(i(), "minRanked", n)}
          onMax={(n) => props.set(i(), "maxRanked", n)}
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
        <label style={inlineFieldStyle()}>
          <span style={fieldLabelStyle()}>Budget</span>
          <input
            type="number"
            value={props.draft.budget}
            onInput={(e) =>
              props.set(i(), "budget", intOf(e.currentTarget.value))
            }
            style={{
              ...textInputStyle(),
              "font-family": "var(--mono)",
              "max-width": "140px",
            }}
          />
        </label>
      </Show>

      <Show when={props.draft.type === "rating"}>
        <div style={{ "margin-top": "14px" }}>
          <div style={{ display: "flex", gap: "8px", "margin-bottom": "12px" }}>
            <button
              type="button"
              aria-pressed={props.draft.ratingScale === "numeric"}
              onClick={() => props.set(i(), "ratingScale", "numeric")}
              style={pillStyle(props.draft.ratingScale === "numeric")}
            >
              Numeric scale
            </button>
            <button
              type="button"
              aria-pressed={props.draft.ratingScale === "labels"}
              onClick={() => props.set(i(), "ratingScale", "labels")}
              style={pillStyle(props.draft.ratingScale === "labels")}
            >
              Labelled scale
            </button>
          </div>
          <Show
            when={props.draft.ratingScale === "numeric"}
            fallback={
              <OptionsEditor
                labels={props.draft.ratingLabels}
                addLabel="+ Add level"
                zeroBased
                endBadges
                hint="ordered worst → best · answers store the 0-based index"
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
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            "margin-top": "4px",
          }}
        >
          <label style={{ display: "block" }}>
            <span style={fieldLabelStyle()}>Method schema URI</span>
            <input
              type="text"
              value={props.draft.customUri}
              placeholder="ipfs://… or https://…"
              onInput={(e) =>
                props.set(i(), "customUri", e.currentTarget.value)
              }
              style={{
                ...textInputStyle(),
                "font-family": "var(--mono)",
                "font-size": "12.5px",
              }}
            />
          </label>
          <label style={{ display: "block" }}>
            <span style={fieldLabelStyle()}>
              Schema hash (blake2b-256, hex)
            </span>
            <input
              type="text"
              value={props.draft.customHash}
              placeholder="64 hex characters"
              onInput={(e) =>
                props.set(i(), "customHash", e.currentTarget.value)
              }
              style={{
                ...textInputStyle(),
                "font-family": "var(--mono)",
                "font-size": "12.5px",
              }}
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
  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
    <Show when={props.hint}>
      <div style={scaleHintStyle()}>{props.hint}</div>
    </Show>
    <Index each={props.labels}>
      {(label, j) => (
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <span style={optIndexStyle()}>{props.zeroBased ? j : j + 1}</span>
          <input
            type="text"
            value={label()}
            placeholder={`Option ${j + 1}`}
            onInput={(e) => props.onLabel(j, e.currentTarget.value)}
            style={{ ...textInputStyle(), "margin-top": "0" }}
          />
          <Show when={props.endBadges && j === 0}>
            <span style={endBadgeStyle("worst")}>worst</span>
          </Show>
          <Show when={props.endBadges && j === props.labels.length - 1}>
            <span style={endBadgeStyle("best")}>best</span>
          </Show>
          <Show when={props.labels.length > 2}>
            <button
              type="button"
              onClick={() => props.onRemove(j)}
              style={removeBtnStyle()}
              aria-label={`Remove option ${j + 1}`}
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
      style={addOptionBtnStyle()}
    >
      {props.addLabel ?? "+ Add option"}
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
  <div
    style={{
      display: "flex",
      gap: "16px",
      "margin-top": "14px",
      "flex-wrap": "wrap",
    }}
  >
    <label style={inlineFieldStyle()}>
      <span style={fieldLabelStyle()}>min {props.label}</span>
      <input
        type="number"
        min={props.minAllowed}
        value={props.min}
        onInput={(e) => props.onMin(intOf(e.currentTarget.value))}
        style={miniNumberStyle()}
      />
    </label>
    <label style={inlineFieldStyle()}>
      <span style={fieldLabelStyle()}>max {props.label}</span>
      <input
        type="number"
        value={props.max}
        onInput={(e) => props.onMax(intOf(e.currentTarget.value))}
        style={miniNumberStyle()}
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
  <div
    style={{
      display: "flex",
      gap: "16px",
      "margin-top": "14px",
      "flex-wrap": "wrap",
    }}
  >
    <label style={inlineFieldStyle()}>
      <span style={fieldLabelStyle()}>min</span>
      <input
        type="text"
        value={props.min}
        onInput={(e) => props.onMin(e.currentTarget.value)}
        style={miniNumberStyle()}
      />
    </label>
    <label style={inlineFieldStyle()}>
      <span style={fieldLabelStyle()}>max</span>
      <input
        type="text"
        value={props.max}
        onInput={(e) => props.onMax(e.currentTarget.value)}
        style={miniNumberStyle()}
      />
    </label>
    <label style={inlineFieldStyle()}>
      <span style={fieldLabelStyle()}>step (optional)</span>
      <input
        type="text"
        value={props.step}
        placeholder="1"
        onInput={(e) => props.onStep(e.currentTarget.value)}
        style={miniNumberStyle()}
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
  <div style={numberedHeadStyle()}>
    {props.n} · {props.label}
    <Show when={props.trailing !== undefined}>
      <span style={{ color: "var(--dim)" }}> · {props.trailing}</span>
    </Show>
  </div>
);

const SummaryCard: Component<{ meta: DefinitionMeta; qCount: number }> = (
  props,
) => {
  const roleList = () =>
    props.meta.eligibleRoles.length === 0
      ? "No roles selected"
      : [...props.meta.eligibleRoles]
          .sort((a, b) => a - b)
          .map(roleLabel)
          .join(", ");
  const ends = () =>
    props.meta.endEpoch.trim() === ""
      ? "—"
      : `epoch ${props.meta.endEpoch.trim()}`;
  const visibility = () =>
    props.meta.mode === "sealed"
      ? props.meta.sealedRound > 0
        ? `Sealed · reveals ${formatRevealDate(props.meta.sealedRound)}`
        : "Sealed"
      : "Public";
  return (
    <div style={summaryCardStyle()}>
      <div style={numberedHeadStyle()}>Summary</div>
      <h3 style={summaryTitleStyle()}>
        {props.meta.title.trim() || "Untitled survey"}
      </h3>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "margin-top": "14px",
        }}
      >
        <SummaryRow label="Questions" value={String(props.qCount)} />
        <SummaryRow label="Who responds" value={roleList()} />
        <SummaryRow label="Ends" value={ends()} />
        <SummaryRow label="Visibility" value={visibility()} />
      </div>
    </div>
  );
};

const SummaryRow: Component<{ label: string; value: string }> = (props) => (
  <div
    style={{
      display: "flex",
      "align-items": "center",
      "justify-content": "space-between",
      gap: "12px",
      padding: "11px 0",
      "border-top": "1px solid var(--line2)",
    }}
  >
    <span
      style={{ "font-size": "12.5px", color: "var(--muted)", flex: "none" }}
    >
      {props.label}
    </span>
    <span
      style={{
        "font-size": "13px",
        "font-weight": "600",
        color: "var(--ink)",
        "text-align": "right",
      }}
    >
      {props.value}
    </span>
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
        style={asidePublishStyle(ok() && !props.submitting)}
      >
        {props.submitting ? props.busyText : "Sign & publish survey"}{" "}
        <span style={{ "font-size": "16px" }}>→</span>
      </button>
      <p style={asideNoteStyle(ok())}>
        <Show
          when={ok()}
          fallback={
            props.blockedReason ??
            `${props.problemCount} thing${props.problemCount === 1 ? "" : "s"} to fix before publishing`
          }
        >
          signs with your owner credential ·{" "}
          <span style={{ "font-family": "var(--mono)" }}>
            key:{shortHash(props.paymentHashHex)}
          </span>{" "}
          · authorizes cancellation
        </Show>
      </p>
    </>
  );
};

const SubmittedPanel: Component<{ hash: string }> = (props) => {
  const navigate = useNavigate();
  const surveyKey = `${props.hash}:0`;
  return (
    <div
      style={{ ...cardStyle(), "text-align": "center", "margin-top": "20px" }}
    >
      <span
        style={{
          display: "inline-flex",
          "align-items": "center",
          "justify-content": "center",
          width: "46px",
          height: "46px",
          "border-radius": "13px",
          background: "var(--ok-bg)",
          color: "var(--ok)",
          "font-size": "22px",
        }}
      >
        ✓
      </span>
      <h3
        style={{
          "font-size": "19px",
          "font-weight": "800",
          "letter-spacing": "-.01em",
          margin: "14px 0 0",
        }}
      >
        Survey published
      </h3>
      <p
        style={{
          "font-size": "14px",
          color: "var(--muted)",
          "line-height": "1.55",
          margin: "8px auto 0",
          "max-width": "440px",
        }}
      >
        Your definition was submitted under metadata label 17. It may take a few
        moments to appear as the indexer catches up.
      </p>
      <div
        style={{
          "font-family": "var(--mono)",
          "font-size": "11.5px",
          color: "var(--faint)",
          "margin-top": "12px",
          "word-break": "break-all",
        }}
      >
        <TxLink hash={props.hash} /> · ref {shortRef(surveyKey)}
      </div>
      <div
        style={{
          display: "flex",
          gap: "10px",
          "justify-content": "center",
          "margin-top": "18px",
          "flex-wrap": "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => navigate(`/survey/${encodeURIComponent(surveyKey)}`)}
          style={{
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            "border-radius": "var(--r-control)",
            padding: "11px 18px",
            "font-family": "inherit",
            "font-size": "14px",
            "font-weight": "700",
            cursor: "pointer",
          }}
        >
          View survey →
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          style={{
            background: "#fff",
            color: "var(--muted)",
            border: "1px solid var(--line)",
            "border-radius": "var(--r-control)",
            padding: "11px 18px",
            "font-family": "inherit",
            "font-size": "14px",
            "font-weight": "700",
            cursor: "pointer",
          }}
        >
          All surveys
        </button>
      </div>
    </div>
  );
};

const ConnectPrompt: Component = () => (
  <div style={{ ...cardStyle(), "margin-top": "16px", "text-align": "center" }}>
    <div
      style={{ "font-size": "16px", "font-weight": "800", color: "var(--ink)" }}
    >
      Connect a wallet to create
    </div>
    <p
      style={{
        "font-size": "13.5px",
        color: "var(--muted)",
        "line-height": "1.55",
        margin: "8px auto 0",
        "max-width": "440px",
      }}
    >
      The survey is owned by your wallet's credential, which signs to publish it
      and is the only key that can cancel it. Use the Connect wallet button in
      the header.
    </p>
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

function backLinkStyle(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    "font-size": "13.5px",
    "font-weight": "600",
    color: "var(--muted)",
    "text-decoration": "none",
    padding: "6px 0",
  };
}
function titleStyle(): JSX.CSSProperties {
  return {
    "font-size": "26px",
    "font-weight": "700",
    "letter-spacing": "-.018em",
    "line-height": "1.16",
    margin: "10px 0 0",
    color: "var(--ink)",
  };
}
function subtitleStyle(): JSX.CSSProperties {
  return {
    "font-size": "14px",
    color: "var(--muted)",
    "line-height": "1.55",
    margin: "8px 0 0",
  };
}
function singleColMain(): JSX.CSSProperties {
  return { "max-width": "760px", margin: "0 auto", padding: "22px 24px 90px" };
}
function numberedHeadStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10.5px",
    "letter-spacing": ".1em",
    "text-transform": "uppercase",
    color: "var(--accent)",
    "font-weight": "600",
    margin: "0 2px 11px",
  };
}
function summaryCardStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-sm)",
    padding: "20px",
    "box-shadow": "var(--shadow-card)",
  };
}
function summaryTitleStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--serif)",
    "font-size": "19px",
    "font-weight": "600",
    "line-height": "1.25",
    margin: "12px 0 0",
    color: "var(--ink)",
  };
}
function warnNoteStyle(): JSX.CSSProperties {
  return {
    "font-size": "12px",
    color: "var(--warn)",
    background: "var(--warn-bg)",
    border: "1px solid var(--warn-line)",
    "border-radius": "var(--r-control)",
    padding: "10px 12px",
    "line-height": "1.5",
    "margin-top": "10px",
  };
}
function scaleHintStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10.5px",
    color: "var(--dim)",
    "letter-spacing": ".03em",
  };
}
function endBadgeStyle(kind: "worst" | "best"): JSX.CSSProperties {
  return kind === "worst"
    ? {
        "font-family": "var(--mono)",
        "font-size": "9.5px",
        color: "#CDA892",
        background: "#FBF0F0",
        "border-radius": "var(--r-3xs)",
        padding: "3px 6px",
        "white-space": "nowrap",
        flex: "none",
      }
    : {
        "font-family": "var(--mono)",
        "font-size": "9.5px",
        color: "var(--accent)",
        background: "var(--accent-bg)",
        "border-radius": "var(--r-3xs)",
        padding: "3px 6px",
        "white-space": "nowrap",
        flex: "none",
      };
}
function cardStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-sm)",
    padding: "18px 20px",
    "margin-top": "10px",
  };
}
// Governance-tinted variant of `cardStyle`, used when the survey is being tied
// to an Info Action (same blue family as the linkage UI elsewhere).
function govCardStyle(): JSX.CSSProperties {
  return {
    background: "var(--gov-bg)",
    border: "1px solid var(--gov-line)",
    "border-radius": "var(--r-sm)",
    padding: "18px 20px",
    "margin-top": "10px",
  };
}
function govAutoBadgeStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "9.5px",
    "font-weight": "700",
    "letter-spacing": ".04em",
    "text-transform": "uppercase",
    color: "var(--gov)",
    background: "#fff",
    border: "1px solid var(--gov-line)",
    "border-radius": "var(--r-3xs)",
    padding: "3px 6px",
  };
}
function govNoteStyle(): JSX.CSSProperties {
  return {
    "font-size": "12px",
    color: "var(--gov)",
    background: "#fff",
    border: "1px solid var(--gov-line)",
    "border-radius": "var(--r-control)",
    padding: "10px 12px",
    "line-height": "1.5",
    "margin-top": "10px",
  };
}
function govToggleRowStyle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "12px",
    width: "100%",
    padding: "0",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    "font-family": "inherit",
  };
}
function govSwitchTrackStyle(on: boolean): JSX.CSSProperties {
  return {
    position: "relative",
    flex: "none",
    width: "38px",
    height: "22px",
    "border-radius": "var(--r-pill)",
    background: on ? "var(--gov)" : "var(--track)",
    border: `1px solid ${on ? "var(--gov)" : "var(--line)"}`,
    transition: "background .15s ease",
  };
}
function govSwitchKnobStyle(on: boolean): JSX.CSSProperties {
  return {
    position: "absolute",
    top: "2px",
    left: on ? "18px" : "2px",
    width: "16px",
    height: "16px",
    "border-radius": "50%",
    background: "#fff",
    "box-shadow": "0 1px 2px rgba(0,0,0,.25)",
    transition: "left .15s ease",
  };
}
function fieldLabelStyle(): JSX.CSSProperties {
  return {
    display: "block",
    "font-size": "12px",
    "font-weight": "700",
    color: "var(--muted)",
    "margin-bottom": "6px",
  };
}
function textInputStyle(): JSX.CSSProperties {
  return {
    width: "100%",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-control)",
    padding: "11px 13px",
    "font-family": "inherit",
    "font-size": "14px",
    color: "var(--ink)",
    outline: "none",
    "box-sizing": "border-box",
    "margin-top": "0",
  };
}
function miniNumberStyle(): JSX.CSSProperties {
  return {
    width: "110px",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-control)",
    padding: "9px 11px",
    "font-family": "var(--mono)",
    "font-size": "14px",
    color: "var(--ink)",
    outline: "none",
    "box-sizing": "border-box",
  };
}
function inlineFieldStyle(): JSX.CSSProperties {
  return { display: "flex", "flex-direction": "column" };
}
function hintStyle(): JSX.CSSProperties {
  return {
    "font-size": "12px",
    color: "var(--dim)",
    "line-height": "1.5",
    margin: "10px 0 0",
  };
}
function qChipStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "12px",
    "font-weight": "600",
    color: "var(--accent)",
    background: "var(--accent-bg)",
    "border-radius": "var(--r-chip)",
    padding: "5px 8px",
  };
}
function selectStyle(): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "600",
    color: "var(--ink)",
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-control)",
    padding: "7px 10px",
    cursor: "pointer",
  };
}
function requiredBtnStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "12px",
    "font-weight": "700",
    cursor: "pointer",
    "border-radius": "var(--r-chip)",
    padding: "6px 12px",
    border: on ? "1px solid var(--accent)" : "1px solid var(--line)",
    background: on ? "var(--accent-bg)" : "#fff",
    color: on ? "var(--accent)" : "var(--muted)",
  };
}
function removeBtnStyle(): JSX.CSSProperties {
  return {
    width: "30px",
    height: "30px",
    "border-radius": "var(--r-xs)",
    border: "1px solid #F0D2D0",
    background: "#fff",
    color: "var(--danger)",
    "font-size": "16px",
    cursor: "pointer",
    "line-height": "1",
    flex: "none",
  };
}
function roleToggleStyle(
  on: boolean,
  color: string,
  bg: string,
): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "8px",
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": "700",
    cursor: "pointer",
    "border-radius": "8px",
    padding: "7px 12px",
    border: on ? `1px solid ${color}` : "1px solid var(--line)",
    background: on ? bg : "#fff",
    color: on ? color : "var(--muted)",
  };
}
function checkboxStyle(on: boolean): JSX.CSSProperties {
  return {
    width: "16px",
    height: "16px",
    "border-radius": "5px",
    border: on ? "none" : "2px solid var(--line2)",
    background: on ? "var(--accent)" : "#fff",
    color: "#fff",
    "font-size": "11px",
    "font-weight": "700",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    flex: "none",
  };
}
function optIndexStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "12px",
    "font-weight": "600",
    color: "var(--dim)",
    width: "18px",
    "text-align": "center",
    flex: "none",
  };
}
function addOptionBtnStyle(): JSX.CSSProperties {
  return {
    "align-self": "flex-start",
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": "600",
    cursor: "pointer",
    "border-radius": "var(--r-control)",
    padding: "7px 12px",
    border: "1px dashed var(--line2)",
    background: "#FBFAF6",
    color: "var(--muted)",
  };
}
function addPanelStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px dashed #D8CDB6",
    "border-radius": "var(--r-sm)",
    padding: "16px 18px",
    "margin-top": "12px",
  };
}
function addPanelHeadStyle(): JSX.CSSProperties {
  return {
    "font-size": "13px",
    "font-weight": "700",
    color: "var(--body)",
    "margin-bottom": "11px",
  };
}
function addTypeBtnStyle(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "600",
    color: "var(--body)",
    background: "var(--surface)",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-sm)",
    padding: "8px 12px",
    cursor: "pointer",
  };
}
function modeCardStyle(on: boolean): JSX.CSSProperties {
  return {
    "text-align": "left",
    "font-family": "inherit",
    cursor: "pointer",
    "border-radius": "var(--r-control)",
    padding: "12px 13px",
    border: on ? "1px solid var(--accent)" : "1px solid var(--line)",
    background: on ? "var(--accent-bg)" : "#fff",
  };
}
function modeTitleStyle(): JSX.CSSProperties {
  return {
    "font-size": "14px",
    "font-weight": "700",
    color: "var(--ink)",
  };
}
function modeDescStyle(): JSX.CSSProperties {
  return {
    "font-size": "11.5px",
    color: "var(--faint)",
    "line-height": "1.4",
    "margin-top": "5px",
  };
}
function chainHashStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "12px",
    color: "var(--muted)",
    background: "var(--surface)",
    border: "1px solid var(--line2)",
    "border-radius": "var(--r-control)",
    padding: "9px 11px",
  };
}
function revealLineStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "11.5px",
    color: "var(--accent)",
    "margin-top": "9px",
  };
}
function pillStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    "border-radius": "8px",
    padding: "7px 13px",
    border: on ? "1px solid var(--accent)" : "1px solid var(--line)",
    background: on ? "var(--accent)" : "#fff",
    color: on ? "#fff" : "var(--muted)",
  };
}
function asidePublishStyle(enabled: boolean): JSX.CSSProperties {
  return {
    width: "100%",
    "margin-top": "14px",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    gap: "9px",
    background: enabled ? "var(--accent)" : "var(--line2)",
    color: enabled ? "#fff" : "var(--dim)",
    border: "none",
    "border-radius": "var(--r-md)",
    padding: "15px",
    "font-family": "inherit",
    "font-size": "15px",
    "font-weight": "700",
    cursor: enabled ? "pointer" : "not-allowed",
    "box-shadow": enabled ? "0 10px 24px -10px var(--accent-shadow)" : "none",
  };
}
function asideNoteStyle(ok: boolean): JSX.CSSProperties {
  return {
    "text-align": "center",
    "font-size": "10.5px",
    color: ok ? "var(--dim)" : "var(--danger)",
    margin: "10px 0 0",
    "line-height": "1.5",
  };
}
