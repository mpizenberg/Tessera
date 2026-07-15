/**
 * The widget's answering component — the app's Respond.tsx screen with every
 * host coupling stripped (plan §3.2):
 *
 * - `useApp()` (survey lookup, wallet, submit) → `props.definition` / `surveyRef`
 *   / `responder` and an `onSubmit` that **emits** a `tessera:response` instead
 *   of submitting;
 * - `@solidjs/router`, `usePresentation`/IPFS, the Pro preview and rationale
 *   editor, network-mismatch gating → all dropped (the host owns them);
 * - the module-global `t`/`n` → an instance `createI18n({ locale, messages })`
 *   provided through {@link I18nContext};
 * - `viewStatus`/`SurveyAggregate` → `surveyStatus(endEpoch, tipEpoch)` + the
 *   `cancelled` prop; `formatRevealDate` → `i18n.d(unixTimeForRound(round))`.
 *
 * Two layouts share all state and logic (layout is pure presentation):
 * `"one-per-screen"` (default) steps through the question cards one at a time;
 * `"list"` renders them all at once. The `theme` prop is reflected as inline
 * `--tessera-*` custom properties on the shadow host.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  type Component,
} from "solid-js";
import { createStore } from "solid-js/store";

import {
  Role,
  encodePayload,
  validateResponse,
  type Credential,
  type Question,
  type SurveyDefinition,
} from "cip-179";
import { refKey, surveyStatus } from "cip-179/domain";
import { isQuicknet, unixTimeForRound } from "cip-179/tlock";

import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  createI18n,
  credentialForRole,
  decided,
  findExistingResponse,
  initDraft,
  prefillDrafts,
  renderProblem,
  respondableRolesFor,
  sealResponse,
  type Draft,
  type DraftValue,
  type I18n,
} from "@tessera/respond-core";

import { I18nContext, useI18n } from "./i18n-context";
import { QuestionBody } from "./bodies";
import { typeMeta } from "./bodies/shared";
import {
  keyKindForRole,
  roleBrowserClaimable,
  roleColors,
  roleDescription,
  roleLabel,
} from "./roles";
import {
  RESPOND_EVENTS,
  type CredentialProof,
  type RespondResult,
  type TesseraRespondProps,
} from "./types";

// ----------------------------------------------------------------------------
// Root component
// ----------------------------------------------------------------------------

export const RespondRoot: Component<TesseraRespondProps> = (props) => {
  // Instance-scoped i18n, recreated when `locale`/`messages` change; provided as
  // an accessor so a locale switch re-renders every consumer (see i18n-context).
  const i18n = createMemo<I18n>(() =>
    createI18n({
      locale: props.locale ?? "en",
      ...(props.messages ? { messages: props.messages } : {}),
    }),
  );

  // Events cross the shadow boundary from the widget's own root node
  // (`composed: true`); a listener outside the shadow sees the host element as
  // the retargeted `event.target`.
  let rootRef: HTMLDivElement | undefined;
  const dispatch = (type: string, detail: unknown): void => {
    rootRef?.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true, composed: true }),
    );
  };

  // Reflect the `theme` prop as inline `--tessera-<key>` custom properties on
  // the shadow host — they inherit through the boundary and, being inline,
  // beat the :host defaults in theme.css. Without a shadow root (a bare
  // RespondRoot mount), fall back to the widget's own root div. Keys dropped
  // from the prop are cleared back to the defaults.
  let themedKeys: string[] = [];
  createEffect(() => {
    const theme = props.theme ?? {};
    const node = rootRef?.getRootNode();
    const target = node instanceof ShadowRoot ? node.host : rootRef;
    if (!(target instanceof HTMLElement)) return;
    for (const key of themedKeys) {
      if (!(key in theme)) target.style.removeProperty(`--tessera-${key}`);
    }
    for (const [key, value] of Object.entries(theme)) {
      target.style.setProperty(`--tessera-${key}`, value);
    }
    themedKeys = Object.keys(theme);
  });

  const respondable = createMemo<Role[]>(() =>
    respondableRolesFor(props.definition, props.responder),
  );

  // Role we respond as: honor the header's picked role if respondable here, else
  // the host-provided initial `role` if respondable, else the first claimable.
  const [roleOverride, setRoleOverride] = createSignal<Role | null>(null);
  const role = createMemo<Role | null>(() => {
    const rs = respondable();
    if (rs.length === 0) return null;
    const o = roleOverride();
    if (o !== null && rs.includes(o)) return o;
    const pref = props.role;
    if (pref !== undefined && rs.includes(pref)) return pref;
    return rs[0]!;
  });

  const credential = createMemo<Credential | null>(() => {
    const r = role();
    return r !== null ? (credentialForRole(r, props.responder) ?? null) : null;
  });

  // The responder's prior public response for the *current* (role, credential),
  // picked from the host-supplied set. The host passes one per role it answered
  // as; `findExistingResponse` selects the one matching the chosen role, so
  // switching roles re-prefills correctly (or clears, when that role is fresh).
  const existing = createMemo(() => {
    const prs = props.priorResponses;
    const r = role();
    const cred = credential();
    if (!prs || prs.length === 0 || r === null || !cred) return undefined;
    return findExistingResponse(prs, props.surveyRef, r, cred);
  });

  // Store mirror of Draft with mutable fields so path setters typecheck.
  const [drafts, setDrafts] = createStore<
    { skipped: boolean; value: DraftValue }[]
  >([]);
  // True once the user edits; gates auto-(re)seeding so late-arriving prop
  // changes never clobber in-progress input.
  const [touched, setTouched] = createSignal(false);

  // (Re)seed drafts when the form's identity or backing data changes. A change
  // of survey or role makes the form pristine again; otherwise we only (re)seed
  // while the user hasn't started editing.
  createEffect(
    on(
      () =>
        [
          refKey(props.surveyRef),
          role(),
          props.definition,
          existing(),
        ] as const,
      ([k, r], prev) => {
        if (!prev || prev[0] !== k || prev[1] !== r) {
          setTouched(false);
          setStep(0);
        }
        if (touched()) return;
        const def = props.definition;
        const ex = existing();
        setDrafts(
          ex ? prefillDrafts(def.questions, ex) : def.questions.map(initDraft),
        );
      },
    ),
  );

  const total = () => props.definition.questions.length;

  // Stepper position for the one-per-screen layout — reset alongside the
  // drafts (survey/role change, above) and clamped in case the definition
  // shrinks under it.
  const layout = () => props.layout ?? "one-per-screen";
  const [step, setStep] = createSignal(0);
  const stepIndex = createMemo(() =>
    Math.min(step(), Math.max(0, total() - 1)),
  );

  const decidedCount = createMemo(
    () =>
      props.definition.questions.filter(
        (q, i) => drafts[i] && decided(q, drafts[i]!),
      ).length,
  );

  const sealedMode = createMemo(() => {
    const mode = props.definition.submissionMode;
    return mode.type === "sealed" ? mode : null;
  });

  // A sealed survey pinned to a drand chain the bundled tlock can't decrypt
  // would be permanently undecryptable, so block submission outright.
  const sealedUnsupported = createMemo(() => {
    const m = sealedMode();
    return m !== null && !isQuicknet(m.chainHash);
  });

  // Open/closed from the host's chain tip + cancellation flag (plan §3.2).
  const view = createMemo<"public" | "sealed" | "ended" | "cancelled">(() => {
    if (props.cancelled) return "cancelled";
    if (surveyStatus(props.definition.endEpoch, props.tipEpoch) === "ended") {
      return "ended";
    }
    return sealedMode() ? "sealed" : "public";
  });
  const open = () => view() === "public" || view() === "sealed";

  const [submitting, setSubmitting] = createSignal(false);
  const [problems, setProblems] = createSignal<string[]>([]);

  const setValue = (i: number, value: DraftValue) => {
    setTouched(true);
    setDrafts(i, "value", value);
  };
  const setSkipped = (i: number, skipped: boolean) => {
    setTouched(true);
    setDrafts(i, "skipped", skipped);
  };

  // Ready to submit: open, eligible, unblocked, and every question decided.
  const valid = () =>
    open() &&
    role() !== null &&
    !sealedUnsupported() &&
    total() > 0 &&
    decidedCount() >= total();

  // Progress, for host-driven submit buttons (fires on every edit).
  createEffect(() => {
    dispatch(RESPOND_EVENTS.change, {
      decided: decidedCount(),
      total: total(),
      valid: valid(),
    });
  });

  const onSubmit = async (): Promise<void> => {
    const def = props.definition;
    const r = role();
    const cred = credential();
    if (r === null || !cred) return;

    // Validate the answers as plaintext first — for a sealed survey nobody can
    // check them again until the reveal, so they must be well-formed now.
    const found = validateResponse(
      { ...def, submissionMode: { type: "public" } },
      buildResponse(props.surveyRef, r, cred, def.questions, drafts),
    );
    if (found.length > 0) {
      const t = i18n();
      const messages = found.map((pb) => renderProblem(t, pb));
      setProblems(messages);
      dispatch(RESPOND_EVENTS.invalid, { problems: found, messages });
      return;
    }
    setProblems([]);

    setSubmitting(true);
    try {
      const sealed = sealedMode();
      const response = sealed
        ? buildSealedResponse(
            props.surveyRef,
            r,
            cred,
            // Timelock-encrypt the answers to the survey's drand round (lazy —
            // the only path that loads the tlock + evolution chunks).
            await sealResponse(
              collectAnswers(def.questions, drafts),
              sealed.round,
              sealed.paddingSize,
            ),
            props.rationaleAnchor,
          )
        : buildResponse(
            props.surveyRef,
            r,
            cred,
            def.questions,
            drafts,
            props.rationaleAnchor,
          );

      const payload = encodePayload({
        type: "responses",
        responses: [response],
      });
      // Declare the responder credential for the host to prove through the
      // carrying tx (required_signers or a governance-vote binding), keyed by
      // the role's signing kind.
      const proveCredentials: CredentialProof[] = [
        { credential: cred, keyKind: keyKindForRole(r) },
      ];
      const result: RespondResult = {
        surveyRef: props.surveyRef,
        role: r,
        credential: cred,
        payload,
        proveCredentials,
        sealed: sealed !== null,
      };
      dispatch(RESPOND_EVENTS.response, result);
    } catch (e) {
      // Sealing failed (e.g. the tlock chunk couldn't load) — surface it
      // inline; the host owns everything after the emit.
      setProblems([e instanceof Error ? e.message : String(e)]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <I18nContext.Provider value={i18n}>
      <div class="root" ref={rootRef}>
        <SurveyHeader
          def={props.definition}
          role={role()}
          respondable={respondable()}
          onPickRole={setRoleOverride}
        />

        <Show
          when={open()}
          fallback={<ClosedNotice cancelled={view() === "cancelled"} />}
        >
          <Show
            when={respondable().length > 0}
            fallback={<Ineligible def={props.definition} />}
          >
            <Show when={existing()}>
              <RespondedBanner role={role()} />
            </Show>
            <Show when={sealedMode()}>
              {(m) => <SealedBanner round={m().round} />}
            </Show>
            <Show when={sealedUnsupported()}>
              <SealedUnsupportedNotice />
            </Show>

            <Show
              when={layout() === "list"}
              fallback={
                <div class="questionList">
                  {/* `keyed` remounts the card when the question changes: a
                      QuestionBody picks its widget by question type at creation
                      (see bodies/index.tsx), so it must not outlive its
                      question the way a non-keyed Show would let it. */}
                  <Show keyed when={props.definition.questions[stepIndex()]}>
                    {(q) => (
                      <QuestionCard
                        q={q}
                        index={stepIndex()}
                        draft={drafts[stepIndex()]}
                        onChange={(v) => setValue(stepIndex(), v)}
                        onSkip={(sk) => setSkipped(stepIndex(), sk)}
                      />
                    )}
                  </Show>
                  <StepperNav
                    index={stepIndex()}
                    total={total()}
                    onStep={setStep}
                  />
                </div>
              }
            >
              <div class="questionList">
                <For each={props.definition.questions}>
                  {(q, i) => (
                    <QuestionCard
                      q={q}
                      index={i()}
                      draft={drafts[i()]}
                      onChange={(v) => setValue(i(), v)}
                      onSkip={(sk) => setSkipped(i(), sk)}
                    />
                  )}
                </For>
              </div>
            </Show>

            <Show when={problems().length > 0}>
              <ProblemList problems={problems()} />
            </Show>

            <SubmitBar
              decided={decidedCount()}
              total={total()}
              replacing={existing() !== undefined}
              submitting={submitting()}
              blocked={sealedUnsupported()}
              sealed={sealedMode() !== null}
              onSubmit={() => void onSubmit()}
            />
          </Show>
        </Show>
      </div>
    </I18nContext.Provider>
  );
};

// ----------------------------------------------------------------------------
// Header (status + title + role selector)
// ----------------------------------------------------------------------------

const SurveyHeader: Component<{
  def: SurveyDefinition;
  role: Role | null;
  respondable: Role[];
  onPickRole: (r: Role) => void;
}> = (props) => {
  const i18n = useI18n();
  return (
    <div class="header">
      <div class="headerTop">
        <span class="respondLabel">{i18n.t("respond.respondLabel")}</span>
      </div>
      <h1 class="headerTitle">
        {props.def.title || i18n.t("respond.untitledSurvey")}
      </h1>
      <Show when={props.def.description}>
        <p class="headerDesc">{props.def.description}</p>
      </Show>

      <Show when={props.respondable.length > 0}>
        <div class="roleRow">
          <span class="roleRowLabel">{i18n.t("respond.respondingAs")}</span>
          <For each={props.respondable}>
            {(r) => (
              <button
                onClick={() => props.onPickRole(r)}
                class="rolePick"
                classList={{ rolePickOn: r === props.role }}
              >
                {roleLabel(r)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Notices / banners
// ----------------------------------------------------------------------------

const ClosedNotice: Component<{ cancelled: boolean }> = (props) => {
  const i18n = useI18n();
  return (
    <div class="notice">
      <div class="noticeTitle">
        {props.cancelled
          ? i18n.t("respond.closedCancelledTitle")
          : i18n.t("respond.closedTitle")}
      </div>
      <p class="noticeBody">
        {props.cancelled
          ? i18n.t("respond.closedCancelledBody")
          : i18n.t("respond.closedBody")}
      </p>
    </div>
  );
};

const SealedUnsupportedNotice: Component = () => {
  const i18n = useI18n();
  return (
    <div class="notice noticeWarn">
      <div class="noticeTitle noticeTitleWarn">
        {i18n.t("respond.sealedUnsupportedTitle")}
      </div>
      <p class="noticeBody">{i18n.t("respond.sealedUnsupportedBody")}</p>
    </div>
  );
};

const Ineligible: Component<{ def: SurveyDefinition }> = (props) => {
  const i18n = useI18n();
  return (
    <div class="card">
      <h3 class="ineligibleTitle">{i18n.t("respond.ineligibleTitle")}</h3>
      <p class="ineligibleLead">{i18n.t("respond.ineligibleLead")}</p>
      <div class="ineligibleList">
        <For each={props.def.eligibleRoles}>
          {(r) => {
            const [color, bg] = roleColors(r);
            return (
              <div class="ineligibleRow">
                <span class="roleChip" style={{ color, background: bg }}>
                  {roleLabel(r)}
                </span>
                <span class="roleDesc">
                  {roleDescription(i18n, r)}
                  <Show when={!roleBrowserClaimable(r)}>
                    <span class="notClaimable">
                      {i18n.t("respond.notClaimable")}
                    </span>
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};

const RespondedBanner: Component<{ role: Role | null }> = (props) => {
  const i18n = useI18n();
  return (
    <div class="respondedBanner">
      <span class="respondedCheck">✓</span>
      <div class="bannerBody">
        <div class="respondedTitle">
          {i18n.t("respond.alreadyResponded", {
            role:
              props.role !== null
                ? roleLabel(props.role)
                : i18n.t("respond.alreadyRespondedRoleFallback"),
          })}
        </div>
        <div class="respondedText">
          {i18n.t("respond.alreadyRespondedText")}
        </div>
      </div>
    </div>
  );
};

const SealedBanner: Component<{ round: number }> = (props) => {
  const i18n = useI18n();
  return (
    <div class="cardBanner">
      <span class="bannerIcon">◆</span>
      <div class="bannerBody">
        <div class="bannerTitle">{i18n.t("respond.sealedTitle")}</div>
        <div class="bannerText">
          {i18n.t("respond.sealedTextBefore")}
          <b>{i18n.t("respond.sealedNoOne")}</b>
          {i18n.t("respond.sealedTextAfter", {
            reveal: i18n.d(unixTimeForRound(props.round), {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}
        </div>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Question card (header + skip + body switch)
// ----------------------------------------------------------------------------

const QuestionCard: Component<{
  q: Question;
  index: number;
  draft: Draft | undefined;
  onChange: (v: DraftValue) => void;
  onSkip: (skipped: boolean) => void;
}> = (props) => {
  const i18n = useI18n();
  const skipped = () => props.draft?.skipped ?? false;
  return (
    <div class="card">
      <div class="qHead">
        <div class="qHeadLeft">
          <span class="qChip">
            {i18n.t("respond.questionChip", { n: i18n.n(props.index + 1) })}
          </span>
          <span class="qType">{typeMeta(i18n, props.q)}</span>
          <Show when={props.q.required}>
            <span class="qRequired">{i18n.t("respond.required")}</span>
          </Show>
        </div>
        <Show when={!props.q.required}>
          <button
            onClick={() => props.onSkip(!skipped())}
            class="skipBtn"
            classList={{ skipBtnOn: skipped() }}
          >
            {skipped() ? i18n.t("respond.skipped") : i18n.t("respond.skip")}
          </button>
        </Show>
      </div>
      <h3 class="qPrompt">{props.q.prompt || i18n.t("respond.noPrompt")}</h3>

      <Show
        when={!skipped()}
        fallback={<p class="qSkipped">{i18n.t("respond.skippedNote")}</p>}
      >
        <div class="qBody">
          <Show when={props.draft}>
            <QuestionBody
              q={props.q}
              value={props.draft!.value}
              onChange={props.onChange}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Stepper navigation (one-per-screen layout)
// ----------------------------------------------------------------------------

const StepperNav: Component<{
  index: number;
  total: number;
  onStep: (i: number) => void;
}> = (props) => {
  const i18n = useI18n();
  return (
    <div class="stepperNav">
      <button
        class="stepNavBtn"
        disabled={props.index <= 0}
        onClick={() => props.onStep(Math.max(0, props.index - 1))}
      >
        ← {i18n.t("respond.stepPrev")}
      </button>
      <span class="stepCount">
        {i18n.t("respond.stepCount", {
          n: i18n.n(props.index + 1),
          total: i18n.n(props.total),
        })}
      </span>
      <button
        class="stepNavBtn"
        disabled={props.index >= props.total - 1}
        onClick={() => props.onStep(Math.min(props.total - 1, props.index + 1))}
      >
        {i18n.t("respond.stepNext")} →
      </button>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Problem list + submit bar
// ----------------------------------------------------------------------------

const ProblemList: Component<{ problems: string[] }> = (props) => {
  const i18n = useI18n();
  return (
    <div class="problems">
      <p class="problemsTitle">{i18n.t("respond.problemsTitle")}</p>
      <ul class="problemsList">
        <For each={props.problems}>
          {(p) => <li class="problemItem">{p}</li>}
        </For>
      </ul>
    </div>
  );
};

const SubmitBar: Component<{
  decided: number;
  total: number;
  replacing: boolean;
  submitting: boolean;
  /** Submission is impossible (e.g. a sealed survey on an unsupported chain). */
  blocked: boolean;
  sealed: boolean;
  onSubmit: () => void;
}> = (props) => {
  const i18n = useI18n();
  const ready = () =>
    props.decided >= props.total && props.total > 0 && !props.blocked;
  const idleText = () =>
    props.sealed
      ? i18n.t("respond.encryptAndSubmit")
      : i18n.t("respond.signAndSubmit");
  return (
    <div class="submitBar">
      <div class="submitInner">
        <div class="submitStatus">
          <span class="progressDots">
            <For each={Array.from({ length: props.total }, (_, i) => i)}>
              {(i) => (
                <span
                  class="progressDot"
                  classList={{ progressDotOn: i < props.decided }}
                />
              )}
            </For>
          </span>
          <span class="decidedCount">
            {i18n.t("respond.decidedCount", {
              decided: i18n.n(props.decided),
              total: i18n.n(props.total),
            })}
          </span>
          <Show when={props.replacing}>
            <span class="replacesNote">{i18n.t("respond.replacesNote")}</span>
          </Show>
          <Show when={props.blocked}>
            <span class="mismatchNote">
              {i18n.t("respond.sealedUnsupportedNote")}
            </span>
          </Show>
        </div>
        <button
          onClick={() => props.onSubmit()}
          disabled={!ready() || props.submitting}
          class="submitBtn"
          classList={{ submitBtnEnabled: ready() && !props.submitting }}
        >
          {props.submitting ? i18n.t("respond.encrypting") : idleText()}{" "}
          <span class="submitArrow">→</span>
        </button>
      </div>
    </div>
  );
};
