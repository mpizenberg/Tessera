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
} from "cip-179";

import { useApp } from "~/state";
import { walletCredToCip179 } from "~/domain/roles";
import {
  QUESTION_TYPES,
  buildDefinition,
  initQuestionDraft,
  questionTypeLabel,
  usesOptions,
  type DefinitionMeta,
  type QuestionDraft,
  type QuestionType,
} from "~/domain/create";
import { roleColors, roleLabel, shortRef } from "~/ui/format";
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
    endEpoch: "",
  });
  const [questions, setQuestions] = createStore<QuestionDraft[]>([
    initQuestionDraft("singleChoice"),
  ]);

  // Seed a sensible default end epoch once the tip is known (don't clobber input).
  createEffect(() => {
    const tip = app.snapshot()?.tip;
    if (tip && meta.endEpoch === "")
      setMeta("endEpoch", String(tip.epoch + 30));
  });

  const built = createMemo(() => {
    const o = owner();
    return o ? buildDefinition(o, meta, questions) : null;
  });
  const problems = (): string[] => built()?.problems ?? [];

  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [showProblems, setShowProblems] = createSignal(false);

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
    if (b.problems.length > 0) {
      setShowProblems(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = encodePayload({
        type: "definitions",
        definitions: [b.definition],
      });
      // Definitions must prove the owner credential (CIP-179 mechanism A) — the
      // owner is what authorizes a later cancellation.
      const hash = await app.submitMetadata(payload, [o]);
      setTxHash(hash);
      app.reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
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
          <BackLink />
          <h1 style={titleStyle()}>Create a survey</h1>
          <p style={subtitleStyle()}>
            Define the questions, who may respond, and when it closes, then sign
            to publish the definition on-chain under metadata label 17. Answers
            are public (plaintext); sealed surveys arrive in a later milestone.
          </p>

          <div class="create-grid" style={{ "margin-top": "20px" }}>
            {/* left: builder */}
            <div>
              <DetailsSection meta={meta} setMeta={setMeta} />
              <RolesSection roles={meta.eligibleRoles} onToggle={toggleRole} />
              <TimingSection
                value={meta.endEpoch}
                onInput={(v) => setMeta("endEpoch", v)}
                tipEpoch={app.snapshot()?.tip.epoch}
              />
              <OwnerNote identity={identity()!} />

              <div style={{ "margin-top": "24px" }}>
                <SectionHead
                  n="04"
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
                <ProblemList problems={problems()} />
              </Show>
              <Show when={submitError()}>
                <ErrorBox message={submitError()!} />
              </Show>
            </div>

            {/* right: summary + publish */}
            <aside class="create-aside">
              <SummaryCard meta={meta} qCount={questions.length} />
              <PublishButton
                problemCount={problems().length}
                submitting={submitting()}
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
      <label style={fieldLabelStyle()}>Title</label>
      <input
        type="text"
        value={props.meta.title}
        placeholder="e.g. Treasury priorities for next epoch"
        onInput={(e) => props.setMeta("title", e.currentTarget.value)}
        style={textInputStyle()}
      />
      <label style={{ ...fieldLabelStyle(), "margin-top": "14px" }}>
        Description
      </label>
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
    </div>
  </div>
);

const RolesSection: Component<{
  roles: readonly Role[];
  onToggle: (r: Role) => void;
}> = (props) => (
  <div style={{ "margin-top": "22px" }}>
    <SectionHead n="02" label="Who can respond" />
    <div style={cardStyle()}>
      <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
        <For each={ROLE_VALUES}>
          {(r) => {
            const on = () => props.roles.includes(r);
            const [color, bg] = roleColors(r);
            return (
              <button
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
  tipEpoch: number | undefined;
}> = (props) => {
  // Soft warning: end_epoch must be later than the current epoch or the survey
  // is closed on arrival. (validateDefinition can't check this — it's ledger
  // state — so it's a client-side nudge, not a hard block.)
  const tooEarly = () => {
    const n = Number(props.value.trim());
    return (
      props.tipEpoch !== undefined &&
      props.value.trim() !== "" &&
      Number.isInteger(n) &&
      n <= props.tipEpoch
    );
  };
  return (
    <div style={{ "margin-top": "22px" }}>
      <SectionHead n="03" label="Timing" />
      <div style={cardStyle()}>
        <label style={fieldLabelStyle()}>End epoch (inclusive)</label>
        <input
          type="number"
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          style={{
            ...textInputStyle(),
            "font-family": "var(--mono)",
            "max-width": "200px",
          }}
        />
        <p style={hintStyle()}>
          Responses are accepted through this epoch.{" "}
          <Show
            when={props.tipEpoch !== undefined}
            fallback="Loading current epoch…"
          >
            Current epoch is <b>{props.tipEpoch}</b>.
          </Show>
        </p>
        <Show when={tooEarly()}>
          <div style={warnNoteStyle()}>
            End epoch must be later than the current epoch ({props.tipEpoch}),
            or the survey is closed as soon as it's published.
          </div>
        </Show>
      </div>
    </div>
  );
};

const OwnerNote: Component<{ identity: WalletIdentity }> = (props) => (
  <div
    style={{
      ...cardStyle(),
      "margin-top": "16px",
      background: "#FBFAF6",
      border: "1px solid #F0EBD8",
    }}
  >
    <div
      style={{ "font-size": "12.5px", color: "#7A6A45", "line-height": "1.5" }}
    >
      <b style={{ color: "#5B4A22" }}>Owned by your payment credential.</b> You
      sign with it to publish, and only it can cancel this survey later.
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
            onClick={() => props.set(i(), "required", !props.draft.required)}
            style={requiredBtnStyle(props.draft.required)}
          >
            {props.draft.required ? "Required" : "Optional"}
          </button>
          <Show when={props.canRemove}>
            <button onClick={() => props.onRemove()} style={removeBtnStyle()}>
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
        <div style={inlineFieldStyle()}>
          <label style={fieldLabelStyle()}>Budget</label>
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
        </div>
      </Show>

      <Show when={props.draft.type === "rating"}>
        <div style={{ "margin-top": "14px" }}>
          <div style={{ display: "flex", gap: "8px", "margin-bottom": "12px" }}>
            <button
              onClick={() => props.set(i(), "ratingScale", "numeric")}
              style={pillStyle(props.draft.ratingScale === "numeric")}
            >
              Numeric scale
            </button>
            <button
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
          <div>
            <label style={fieldLabelStyle()}>Method schema URI</label>
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
          </div>
          <div>
            <label style={fieldLabelStyle()}>
              Schema hash (blake2b-256, hex)
            </label>
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
          </div>
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
            <button onClick={() => props.onRemove(j)} style={removeBtnStyle()}>
              ×
            </button>
          </Show>
        </div>
      )}
    </Index>
    <button onClick={() => props.onAdd()} style={addOptionBtnStyle()}>
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
    <div style={inlineFieldStyle()}>
      <label style={fieldLabelStyle()}>min {props.label}</label>
      <input
        type="number"
        min={props.minAllowed}
        value={props.min}
        onInput={(e) => props.onMin(intOf(e.currentTarget.value))}
        style={miniNumberStyle()}
      />
    </div>
    <div style={inlineFieldStyle()}>
      <label style={fieldLabelStyle()}>max {props.label}</label>
      <input
        type="number"
        value={props.max}
        onInput={(e) => props.onMax(intOf(e.currentTarget.value))}
        style={miniNumberStyle()}
      />
    </div>
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
    <div style={inlineFieldStyle()}>
      <label style={fieldLabelStyle()}>min</label>
      <input
        type="text"
        value={props.min}
        onInput={(e) => props.onMin(e.currentTarget.value)}
        style={miniNumberStyle()}
      />
    </div>
    <div style={inlineFieldStyle()}>
      <label style={fieldLabelStyle()}>max</label>
      <input
        type="text"
        value={props.max}
        onInput={(e) => props.onMax(e.currentTarget.value)}
        style={miniNumberStyle()}
      />
    </div>
    <div style={inlineFieldStyle()}>
      <label style={fieldLabelStyle()}>step (optional)</label>
      <input
        type="text"
        value={props.step}
        placeholder="1"
        onInput={(e) => props.onStep(e.currentTarget.value)}
        style={miniNumberStyle()}
      />
    </div>
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
        <SummaryRow label="Visibility" value="Public" />
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
  submitting: boolean;
  paymentHashHex: string;
  onPublish: () => void;
}> = (props) => {
  const ok = () => props.problemCount === 0;
  return (
    <>
      <button
        onClick={() => props.onPublish()}
        disabled={props.submitting}
        style={asidePublishStyle(ok() && !props.submitting)}
      >
        {props.submitting ? "Publishing…" : "Sign & publish survey"}{" "}
        <span style={{ "font-size": "16px" }}>→</span>
      </button>
      <p style={asideNoteStyle(ok())}>
        <Show
          when={ok()}
          fallback={`${props.problemCount} thing${props.problemCount === 1 ? "" : "s"} to fix before publishing`}
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
        tx {props.hash} · ref {shortRef(surveyKey)}
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

const ProblemList: Component<{ problems: string[] }> = (props) => (
  <div
    style={{
      background: "var(--danger-bg)",
      border: "1px solid var(--danger-line)",
      "border-radius": "var(--r-md)",
      padding: "13px 15px",
      "margin-top": "18px",
    }}
  >
    <div
      style={{
        "font-size": "13px",
        "font-weight": "700",
        color: "var(--danger)",
      }}
    >
      Fix before publishing
    </div>
    <ul
      style={{
        margin: "8px 0 0",
        padding: "0 0 0 18px",
        color: "#8A3A2E",
        "font-size": "12.5px",
        "line-height": "1.6",
      }}
    >
      <For each={props.problems}>{(p) => <li>{p}</li>}</For>
    </ul>
  </div>
);

const ErrorBox: Component<{ message: string }> = (props) => (
  <div
    style={{
      background: "var(--danger-bg)",
      border: "1px solid var(--danger-line)",
      "border-radius": "var(--r-md)",
      padding: "13px 15px",
      "margin-top": "14px",
    }}
  >
    <div
      style={{
        "font-size": "13px",
        "font-weight": "700",
        color: "var(--danger)",
      }}
    >
      Submission failed
    </div>
    <div
      style={{
        "font-size": "12.5px",
        color: "#8A3A2E",
        "line-height": "1.5",
        "margin-top": "5px",
        "word-break": "break-word",
      }}
    >
      {props.message}
    </div>
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
