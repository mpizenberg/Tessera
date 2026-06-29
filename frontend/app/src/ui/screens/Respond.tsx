import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  type Component,
  type JSX,
} from "solid-js";
import { createStore } from "solid-js/store";
import { A, useNavigate, useParams } from "@solidjs/router";
import {
  SPEC_VERSION,
  encodeAnswerItem,
  encodePayload,
  validateResponse,
  type ContentAnchor,
  type Credential,
  type Metadatum,
  type OptionsOrCount,
  type Question,
  type RatingScale,
  type Role,
  type SurveyDefinition,
  type SurveyResponse,
} from "cip-179";

import { useApp } from "~/state";
import {
  dedupeResponses,
  findSurvey,
  refKey,
  type SurveyAggregate,
} from "~/domain/survey";
import { respondableRoles, roleCredential } from "~/domain/roles";
import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  decided,
  findExistingResponse,
  initDraft,
  optionCount,
  prefillDrafts,
  type Draft,
  type DraftValue,
} from "~/domain/respond";
import { usePresentation } from "~/enrichment/usePresentation";
import { IPFS_PROVIDERS } from "~/enrichment/providers";
import { OnchainPreview } from "~/ui/components/OnchainPreview";
import { ErrorBox, ProblemList } from "~/ui/components/Feedback";
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { TxLink } from "~/ui/components/TxLink";
import {
  SubmitProgressModal,
  type SubmitStep,
} from "~/ui/components/SubmitProgress";
import { hexToBytes } from "~/util/hex";
import { formatRevealDate } from "~/tlock/drand";
import {
  fullRef,
  networkMismatch,
  roleBrowserClaimable,
  roleColors,
  roleDescription,
  roleLabel,
  shortRef,
  viewStatus,
} from "~/ui/format";
import type { WalletIdentity } from "~/wallet/types";
import css from "./Respond.module.css";

// ----------------------------------------------------------------------------
// Screen
// ----------------------------------------------------------------------------

export const Respond: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);

  // Fall back to the optimistic set so a just-created survey is answerable
  // immediately, before Koios indexes it (mirrors the results page).
  const survey = createMemo(() => {
    const snap = app.snapshot();
    const found = snap ? findSurvey(snap.surveys, key()) : undefined;
    return found ?? app.optimisticSurveys().find((a) => a.key === key());
  });
  // External-content surveys: render labels from the off-chain presentation doc
  // when available. `definition()` is the enriched (display) definition; it
  // falls back to the on-chain one, which is always answerable since indices and
  // constraints are on-chain. The enrichment only changes labels, so it's safe
  // to use for validation/build too.
  const rawDefinition = (): SurveyDefinition | undefined =>
    survey()?.record.definition;
  const pres = usePresentation(rawDefinition);
  const definition = (): SurveyDefinition | undefined => pres.def();
  const identity = (): WalletIdentity | null => app.wallet()?.identity ?? null;
  // Block submitting while the wallet is on a different network than the app, so
  // the signature can't be built against the wrong chain. Mirrors create + propose.
  const mismatch = (): boolean =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  const respondable = createMemo<Role[]>(() => {
    const def = definition();
    const id = identity();
    return def && id ? respondableRoles(def, id) : [];
  });

  // Role we respond as: honor the header's active role if it's respondable here,
  // otherwise the first role this wallet can claim for this survey.
  const [roleOverride, setRoleOverride] = createSignal<Role | null>(null);
  const role = createMemo<Role | null>(() => {
    const rs = respondable();
    if (rs.length === 0) return null;
    const o = roleOverride();
    if (o !== null && rs.includes(o)) return o;
    const a = app.activeRole();
    if (a !== null && rs.includes(a as Role)) return a as Role;
    return rs[0]!;
  });

  const credential = createMemo<Credential | null>(() => {
    const def = definition();
    const id = identity();
    const r = role();
    return def && id && r !== null
      ? (roleCredential(id, r, def.owner) ?? null)
      : null;
  });

  // The wallet's prior public response for (this survey, role, credential).
  const existing = createMemo<SurveyResponse | undefined>(() => {
    const def = definition();
    const s = survey();
    const r = role();
    const cred = credential();
    const snap = app.snapshot();
    if (!def || !s || r === null || !cred || !snap) return undefined;
    const mine = dedupeResponses(
      snap.records.responses.filter(
        (rr) => refKey(rr.response.surveyRef) === s.key,
      ),
    ).map((x) => x.response);
    return findExistingResponse(mine, s.record.ref, r, cred);
  });

  // Store mirror of Draft with mutable fields so path setters typecheck;
  // assignable to/from the readonly domain Draft.
  const [drafts, setDrafts] = createStore<
    { skipped: boolean; value: DraftValue }[]
  >([]);

  // True once the user edits an answer; gates auto-(re)seeding so late-arriving
  // data and reloads never clobber in-progress input.
  const [touched, setTouched] = createSignal(false);

  // (Re)seed drafts when the form's identity or its backing data changes:
  //  - survey key / chosen role → a different prior response to pre-fill from
  //  - definition()            → external-content enrichment swapping labels in
  //  - existing()              → a prior on-chain response that resolves *after*
  //    the first seed (e.g. once the wallet auto-reconnects)
  // A change of survey or role makes the form pristine again; otherwise we only
  // (re)seed while the user hasn't started editing.
  createEffect(
    on(
      () => [survey()?.key, role(), definition(), existing()] as const,
      ([k, r], prev) => {
        if (!prev || prev[0] !== k || prev[1] !== r) setTouched(false);
        if (touched()) return;
        const def = definition();
        if (!def) {
          setDrafts([]);
          return;
        }
        const ex = existing();
        setDrafts(
          ex ? prefillDrafts(def.questions, ex) : def.questions.map(initDraft),
        );
      },
    ),
  );

  const total = () => definition()?.questions.length ?? 0;
  const decidedCount = createMemo(() => {
    const def = definition();
    if (!def) return 0;
    return def.questions.filter((q, i) => drafts[i] && decided(q, drafts[i]!))
      .length;
  });

  const sealedMode = createMemo(() => {
    const mode = definition()?.submissionMode;
    return mode?.type === "sealed" ? mode : null;
  });

  const [submitting, setSubmitting] = createSignal(false);
  const [busyText, setBusyText] = createSignal("Submitting…");
  const [stepKey, setStepKey] = createSignal<string | null>(null);
  const [problems, setProblems] = createSignal<string[]>([]);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);

  // Optional voter rationale (Pro): an off-chain doc, hash-anchored on the
  // response (CIP-179 key 5). Either *write* it (the app pins it to your IPFS
  // providers and fills the anchor) or *paste* an already-hosted URI + hash.
  const [rationaleOn, setRationaleOn] = createSignal(false);
  const hasPinning = (): boolean =>
    IPFS_PROVIDERS.some((p) => app.ipfsTokens[p.id]?.trim());
  const [ratMode, setRatMode] = createSignal<"write" | "manual">(
    hasPinning() ? "write" : "manual",
  );
  const [ratText, setRatText] = createSignal("");
  const [ratUri, setRatUri] = createSignal("");
  const [ratHash, setRatHash] = createSignal("");

  const setValue = (i: number, value: DraftValue) => {
    setTouched(true);
    setDrafts(i, "value", value);
  };
  const setSkipped = (i: number, skipped: boolean) => {
    setTouched(true);
    setDrafts(i, "skipped", skipped);
  };

  // Parse the *manual* rationale anchor: the anchor, `undefined` (none), or
  // "invalid" (problems set). URI required; hash must be 32 bytes of hex. The
  // write/pin path resolves its anchor asynchronously at submit time instead.
  const manualRationaleAnchor = (): ContentAnchor | undefined | "invalid" => {
    if (!app.ui.pro || !rationaleOn() || ratMode() !== "manual")
      return undefined;
    const uri = ratUri().trim();
    const probs: string[] = [];
    if (uri === "") probs.push("Rationale: document URI is required.");
    let hash: Uint8Array | null = null;
    try {
      const b = hexToBytes(ratHash().trim());
      if (b.length !== 32)
        probs.push("Rationale: hash must be 32 bytes (64 hex chars).");
      else hash = b;
    } catch {
      probs.push("Rationale: hash is not valid hex.");
    }
    if (probs.length > 0 || !hash) {
      setProblems(probs);
      return "invalid";
    }
    return { uri, hash };
  };

  // Resolve the rationale anchor at submit time: pin the written text (when in
  // write mode with non-empty text), or use the already-parsed manual anchor.
  // Throws (→ submit error) if pinning fails. Returns undefined for "no rationale".
  const resolveRationale = async (
    manual: ContentAnchor | undefined,
  ): Promise<ContentAnchor | undefined> => {
    if (!app.ui.pro || !rationaleOn()) return undefined;
    if (ratMode() === "manual") return manual;
    const text = ratText().trim();
    if (text === "") return undefined;
    setBusyText("Pinning rationale…");
    const { pinJson } = await import("~/enrichment/pin");
    const doc = {
      specVersion: SPEC_VERSION,
      kind: "cardano-survey-rationale",
      body: { comment: text },
    };
    const pinned = await pinJson(doc, "rationale.json", app.ipfsTokens);
    return { uri: pinned.uri, hash: pinned.hash };
  };

  // --- Pro on-chain preview ------------------------------------------------
  // A side-effect-free read of the manual rationale anchor (the submit path's
  // `manualRationaleAnchor` also sets the problem list, which a memo must not).
  // Included in the preview only when fully valid; otherwise omitted.
  const previewRationale = (): ContentAnchor | undefined => {
    if (!app.ui.pro || !rationaleOn() || ratMode() !== "manual")
      return undefined;
    const uri = ratUri().trim();
    if (uri === "") return undefined;
    try {
      const hash = hexToBytes(ratHash().trim());
      return hash.length === 32 ? { uri, hash } : undefined;
    } catch {
      return undefined;
    }
  };

  // Public surveys: the payload is built live from the current drafts.
  const publicPreview = createMemo<Metadatum | undefined>(() => {
    if (!app.ui.pro || sealedMode()) return undefined;
    const def = definition();
    const s = survey();
    const r = role();
    const cred = credential();
    if (!def || !s || r === null || !cred) return undefined;
    try {
      const response = buildResponse(
        s.record.ref,
        r,
        cred,
        def.questions,
        drafts,
        previewRationale(),
      );
      return encodePayload({ type: "responses", responses: [response] });
    } catch {
      return undefined;
    }
  });

  // Sealed surveys: the on-chain payload is the timelock ciphertext, but we do
  // NOT encrypt for the preview — encryption runs only when the voter submits.
  // Instead we show the *plaintext answers* that will be sealed (the exact
  // metadatum fed to the timelock), built live and cheaply, with no tlock load.
  const sealedPreview = createMemo<Metadatum | undefined>(() => {
    const def = definition();
    if (!def || !sealedMode()) return undefined;
    try {
      return collectAnswers(def.questions, drafts).map(encodeAnswerItem);
    } catch {
      return undefined;
    }
  });

  const previewPayload = (): Metadatum | undefined =>
    sealedMode() ? sealedPreview() : publicPreview();
  // Padding the sealed ciphertext is zero-padded to, for the preview note.
  const sealedPadding = (): number | undefined => sealedMode()?.paddingSize;

  // A written (not pasted) rationale gets pinned at submit — an extra step.
  const willPinRationale = () =>
    app.ui.pro &&
    rationaleOn() &&
    ratMode() === "write" &&
    ratText().trim() !== "";
  // The ordered steps this submission will run through (drives the progress
  // overlay). Only shown when there's more than one — a plain public submit
  // keeps its inline button state.
  const submitSteps = createMemo<SubmitStep[]>(() => {
    const steps: SubmitStep[] = [];
    if (willPinRationale())
      steps.push({ key: "pin", label: "Pinning rationale to IPFS" });
    if (sealedMode())
      steps.push({ key: "encrypt", label: "Timelock-encrypting your answers" });
    steps.push({
      key: "submit",
      label: "Signing & submitting the transaction",
    });
    return steps;
  });

  const onSubmit = async () => {
    const def = definition();
    const s = survey();
    const r = role();
    const cred = credential();
    if (!def || !s || r === null || !cred) return;

    // Manual rationale anchor (Pro) parsed up front so a bad hash surfaces
    // alongside answer problems, before any signing. The write/pin path is
    // resolved asynchronously below (it needs a network round-trip).
    const manualRationale = manualRationaleAnchor();
    if (manualRationale === "invalid") return;

    // Validate the answers as plaintext first — for a sealed survey nobody can
    // check them again until the reveal, so they must be well-formed now. The
    // rationale never affects answer validation, so it's resolved after.
    const found = validateResponse(
      { ...def, submissionMode: { type: "public" } },
      buildResponse(s.record.ref, r, cred, def.questions, drafts),
    );
    setProblems(found);
    if (found.length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    setStepKey(submitSteps()[0]?.key ?? "submit");
    try {
      // Resolve (and, in write mode, pin) the rationale before building.
      const rationale = await resolveRationale(manualRationale);

      const sealed = sealedMode();
      let response = buildResponse(
        s.record.ref,
        r,
        cred,
        def.questions,
        drafts,
        rationale,
      );
      if (sealed) {
        // Timelock-encrypt the answers to the survey's drand round, then submit
        // the ciphertext instead of the plaintext answers.
        setStepKey("encrypt");
        setBusyText("Encrypting…");
        const { sealAnswers } = await import("~/tlock/seal");
        const answers = collectAnswers(def.questions, drafts);
        const ciphertext = await sealAnswers(
          answers,
          sealed.round,
          sealed.paddingSize,
        );
        response = buildSealedResponse(
          s.record.ref,
          r,
          cred,
          ciphertext,
          rationale,
        );
      }
      setStepKey("submit");
      setBusyText("Submitting…");
      const payload = encodePayload({
        type: "responses",
        responses: [response],
      });
      // Prove control of the responder credential via required_signers (CIP-179
      // credential proof) — e.g. forces the wallet to sign with the stake key
      // when responding as a Stakeholder, not just the payment key.
      const hash = await app.submitMetadata(payload, [cred]);
      setTxHash(hash);
      app.trackTx({ txHash: hash, kind: "response", surveyKey: key() });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setBusyText("Submitting…");
      setStepKey(null);
    }
  };

  return (
    <main class={css.main}>
      <A href={`/survey/${encodeURIComponent(key())}`} class={css.backLink}>
        <span class={css.backArrow}>←</span> Back to results
      </A>

      <Show when={submitting() && submitSteps().length > 1}>
        <SubmitProgressModal
          title={
            sealedMode() ? "Sealing your response" : "Submitting your response"
          }
          steps={submitSteps()}
          currentKey={stepKey()}
        />
      </Show>

      <Show
        when={survey()}
        fallback={
          <Empty
            loading={app.snapshot.loading}
            error={app.snapshot.error}
            onRetry={() => app.reload()}
          />
        }
      >
        {(s) => (
          <Show
            when={txHash() === null}
            fallback={<SubmittedPanel hash={txHash()!} surveyKey={key()} />}
          >
            <SurveyHeader
              s={s()}
              def={definition() ?? s().record.definition}
              pro={app.ui.pro}
              role={role()}
              respondable={respondable()}
              // Per-survey choice only — must not rewrite the app-wide active
              // role used by other screens (e.g. the "mine" Explore filter).
              onPickRole={(r) => setRoleOverride(r)}
            />

            <Show when={s().cancellationClaimed}>
              <div class={css.cancelClaim}>
                <strong>Unverified cancellation claim.</strong> A cancellation
                for this survey was published but couldn't be verified as the
                owner's, so it's ignored — you can still respond.
              </div>
            </Show>

            <Switch3
              s={s()}
              connected={identity() !== null}
              respondable={respondable()}
            >
              {/* The actual form (open + eligible) */}
              <Show when={existing()}>
                <RespondedBanner role={role()} />
              </Show>
              <Show when={sealedMode()}>
                {(m) => <SealedBanner round={m().round} />}
              </Show>
              <Show when={pres.external() && pres.unavailable()}>
                <LabelsAbsentBanner keyStr={key()} />
              </Show>

              <div class={css.questionList}>
                <For each={(definition() ?? s().record.definition).questions}>
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

              <Show when={app.ui.pro}>
                <RationaleSection
                  on={rationaleOn()}
                  mode={ratMode()}
                  hasPinning={hasPinning()}
                  text={ratText()}
                  uri={ratUri()}
                  hash={ratHash()}
                  onToggle={setRationaleOn}
                  onMode={setRatMode}
                  onText={setRatText}
                  onUri={setRatUri}
                  onHash={setRatHash}
                />
              </Show>

              <Show when={problems().length > 0}>
                <ProblemList
                  title="Please fix before submitting"
                  problems={problems()}
                />
              </Show>
              <Show when={submitError()}>
                <ErrorBox message={submitError()!} />
              </Show>

              <Show when={app.ui.pro}>
                <OnchainPreview
                  payload={previewPayload()}
                  sealed={sealedMode() !== null}
                  paddingSize={sealedPadding()}
                />
              </Show>
            </Switch3>
          </Show>
        )}
      </Show>

      {/* sticky submit bar — only when an open, eligible form is showing */}
      <Show
        when={
          survey() &&
          txHash() === null &&
          (viewStatus(survey()!) === "public" ||
            viewStatus(survey()!) === "sealed") &&
          role() !== null
        }
      >
        <SubmitBar
          decided={decidedCount()}
          total={total()}
          replacing={existing() !== undefined}
          submitting={submitting()}
          mismatch={mismatch()}
          network={app.config.network}
          idleText={sealedMode() ? "Encrypt & submit" : "Sign & submit"}
          busyText={busyText()}
          onSubmit={() => void onSubmit()}
        />
      </Show>
    </main>
  );
};

// ----------------------------------------------------------------------------
// State router: connect / ineligible / closed / sealed / form
// ----------------------------------------------------------------------------

/** Renders the form (children) only when open, public, connected, and eligible. */
const Switch3: Component<{
  s: SurveyAggregate;
  connected: boolean;
  respondable: Role[];
  children: JSX.Element;
}> = (props) => {
  const v = () => viewStatus(props.s);
  // Both "public" and "sealed" are open/active — sealed just encrypts on submit.
  return (
    <Show
      when={v() === "public" || v() === "sealed"}
      fallback={<ClosedNotice v={v()} />}
    >
      <Show when={props.connected} fallback={<ConnectPrompt />}>
        <Show
          when={props.respondable.length > 0}
          fallback={<Ineligible def={props.s.record.definition} />}
        >
          {props.children}
        </Show>
      </Show>
    </Show>
  );
};

const ClosedNotice: Component<{ v: ReturnType<typeof viewStatus> }> = (
  props,
) => (
  <Notice
    tone="muted"
    title={
      props.v === "cancelled"
        ? "This survey was cancelled"
        : "This survey has closed"
    }
    body={
      props.v === "cancelled"
        ? "The owner withdrew it with a tag-2 cancellation. New responses are rejected. The definition stays on-chain for reference."
        : "Its end epoch has passed, so new responses are no longer accepted. You can still read the results."
    }
  />
);

const ConnectPrompt: Component = () => (
  <Notice
    tone="muted"
    title="Connect a wallet to respond"
    body="Use the Connect wallet button in the header. Eligibility is checked against your wallet's credentials. You can read the survey and its results without connecting."
  />
);

const Ineligible: Component<{ def: SurveyDefinition }> = (props) => (
  <div class={css.card}>
    <h3 class={css.ineligibleTitle}>You can't respond to this survey</h3>
    <p class={css.ineligibleLead}>
      It's open only to the roles below, and your connected wallet can't claim
      any of them here. Here's what each one means:
    </p>
    <div class={css.ineligibleList}>
      <For each={props.def.eligibleRoles}>
        {(r) => {
          const [color, bg] = roleColors(r);
          return (
            <div class={css.ineligibleRow}>
              <span class={css.roleChip} style={{ color, background: bg }}>
                {roleLabel(r)}
              </span>
              <span class={css.roleDesc}>
                {roleDescription(r)}
                <Show when={!roleBrowserClaimable(r)}>
                  <span class={css.notClaimable}>
                    {" "}
                    Not claimable in a browser wallet.
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

// ----------------------------------------------------------------------------
// Header (status + title + role selector)
// ----------------------------------------------------------------------------

const SurveyHeader: Component<{
  s: SurveyAggregate;
  /** Display definition (enriched with off-chain labels for external content). */
  def: SurveyDefinition;
  pro: boolean;
  role: Role | null;
  respondable: Role[];
  onPickRole: (r: Role) => void;
}> = (props) => (
  <div class={css.header}>
    <div class={css.headerTop}>
      <span class={css.respondLabel}>Respond</span>
      {/* refText carries margin-left:auto, so no spacer node is needed. When
          pro is off, "Responding as" / title don't depend on the spacer. */}
      <Show when={props.pro}>
        <span
          title="Full survey ref — defining transaction hash and output index"
          class={css.refText}
        >
          ref {fullRef(props.s.key)}
        </span>
      </Show>
    </div>
    <h1 class={css.headerTitle}>{props.def.title || "Untitled survey"}</h1>
    <Show when={props.def.description}>
      <p class={css.headerDesc}>{props.def.description}</p>
    </Show>

    <Show when={props.respondable.length > 0}>
      <div class={css.roleRow}>
        <span class={css.roleRowLabel}>Responding as</span>
        <For each={props.respondable}>
          {(r) => (
            <button
              onClick={() => props.onPickRole(r)}
              class={css.rolePick}
              classList={{ [css.rolePickOn]: r === props.role }}
            >
              {roleLabel(r)}
            </button>
          )}
        </For>
      </div>
    </Show>
  </div>
);

const RespondedBanner: Component<{ role: Role | null }> = (props) => (
  <div class={css.respondedBanner}>
    <span class={css.respondedCheck}>✓</span>
    <div class={css.bannerBody}>
      <div class={css.respondedTitle}>
        You already responded as{" "}
        {props.role !== null ? roleLabel(props.role) : "this role"}
      </div>
      <div class={css.respondedText}>
        Your previous answers are pre-filled. Submitting again publishes a new
        response that fully replaces the earlier one under latest-valid-wins;
        the old one stays on-chain but is no longer tallied.
      </div>
    </div>
  </div>
);

const SealedBanner: Component<{ round: number }> = (props) => (
  <div class={css.cardBanner}>
    <span class={css.bannerIcon}>◆</span>
    <div class={css.bannerBody}>
      <div class={css.bannerTitle}>This is a sealed survey</div>
      <div class={css.bannerText}>
        Your answers are timelock-encrypted on submit —{" "}
        <b>no one, not even you, can read them</b> until the drand round
        publishes ({formatRevealDate(props.round)}). Aggregate results appear
        only after the reveal.
      </div>
    </div>
  </div>
);

/**
 * External-content survey whose off-chain labels couldn't be fetched/verified.
 * The form still works: every question's type, count and constraints are
 * on-chain, and answers reference option indices (validated + tallied normally).
 */
const LabelsAbsentBanner: Component<{ keyStr: string }> = (props) => (
  <div class={css.cardBanner}>
    <span class={css.bannerIcon}>⚠</span>
    <div class={css.bannerBody}>
      <div class={css.bannerTitle}>Presentation labels unavailable</div>
      <div class={css.bannerText}>
        The off-chain document (
        <span class={css.refInline}>{shortRef(props.keyStr)}</span>) couldn't be
        fetched or failed its hash check, so option labels are shown as indices.{" "}
        <b>You can still respond</b> — your answer references option indices,
        validated and tallied normally.
      </div>
    </div>
  </div>
);

/**
 * Optional voter rationale (Pro). Attaches an off-chain document, tamper-evident
 * via its blake2b-256 hash, to the response (CIP-179 key 5). Purely
 * informational — no effect on validation or tallies — mirroring CIP-100/108
 * rationale conventions. Two ways to supply it: **write** the text and let the
 * app pin it to your IPFS providers (filling the anchor for you), or **paste**
 * an already-hosted URI + its hash.
 */
const RationaleSection: Component<{
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
        Attach a rationale document{" "}
        <span class={css.ratToggleHint}>(off-chain, hash-anchored)</span>
      </span>
    </label>
    <Show when={props.on}>
      <div class={css.ratBody}>
        <SegmentedToggle
          ariaLabel="Rationale source"
          wrapStyle={{ "align-self": "flex-start" }}
          value={props.mode}
          onChange={props.onMode}
          options={[
            { value: "write", label: "Write & pin" },
            { value: "manual", label: "Paste anchor" },
          ]}
        />

        <Show
          when={props.mode === "write"}
          fallback={
            <>
              <label class={css.ratField}>
                <span class={css.ratLabel}>Document URI</span>
                <input
                  type="text"
                  value={props.uri}
                  placeholder="ipfs://… or https://…"
                  onInput={(e) => props.onUri(e.currentTarget.value)}
                  class={css.ratMonoInput}
                />
              </label>
              <label class={css.ratField}>
                <span class={css.ratLabel}>Hash (blake2b-256, hex)</span>
                <input
                  type="text"
                  value={props.hash}
                  placeholder="64 hex characters"
                  onInput={(e) => props.onHash(e.currentTarget.value)}
                  class={css.ratMonoInput}
                />
              </label>
              <p class={css.ratHint}>
                Host the document yourself; the hash makes it tamper-evident.
              </p>
            </>
          }
        >
          <label class={css.ratField}>
            <span class={css.ratLabel}>Rationale</span>
            <textarea
              value={props.text}
              rows={4}
              placeholder="Why you answered this way…"
              onInput={(e) => props.onText(e.currentTarget.value)}
              class={css.ratTextarea}
            />
          </label>
          <Show
            when={props.hasPinning}
            fallback={
              <p class={css.ratWarn}>
                No IPFS provider is configured — add a token in{" "}
                <A href="/settings" class={css.settingsLink}>
                  Settings
                </A>{" "}
                to pin from here, or switch to “Paste anchor”.
              </p>
            }
          >
            <p class={css.ratHint}>
              On submit, this is pinned to your IPFS providers and anchored (URI
              + blake2b-256 hash) on your response. Informational only — never
              affects validation or tallies.
            </p>
          </Show>
        </Show>
      </div>
    </Show>
  </div>
);

// ----------------------------------------------------------------------------
// Question card (header + skip + body switch)
// ----------------------------------------------------------------------------

const TYPE_LABEL: Record<Question["type"], string> = {
  custom: "Custom · external schema",
  singleChoice: "Single choice",
  multiSelect: "Multi-select",
  ranking: "Ranking",
  numericRange: "Numeric range",
  pointsAllocation: "Points allocation",
  rating: "Rating",
};

const QuestionCard: Component<{
  q: Question;
  index: number;
  draft: Draft | undefined;
  onChange: (v: DraftValue) => void;
  onSkip: (skipped: boolean) => void;
}> = (props) => {
  const skipped = () => props.draft?.skipped ?? false;
  return (
    <div class={css.card}>
      <div class={css.qHead}>
        <div class={css.qHeadLeft}>
          <span class={css.qChip}>Q{props.index + 1}</span>
          <span class={css.qType}>{typeMeta(props.q)}</span>
          <Show when={props.q.required}>
            <span class={css.qRequired}>Required</span>
          </Show>
        </div>
        <Show when={!props.q.required}>
          <button
            onClick={() => props.onSkip(!skipped())}
            class={css.skipBtn}
            classList={{ [css.skipBtnOn]: skipped() }}
          >
            {skipped() ? "Skipped" : "Skip"}
          </button>
        </Show>
      </div>
      <h3 class={css.qPrompt}>{props.q.prompt || "(no prompt)"}</h3>

      <Show
        when={!skipped()}
        fallback={
          <p class={css.qSkipped}>
            Skipped — abstaining. Nothing is recorded for this question.
          </p>
        }
      >
        <div class={css.qBody}>
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

/**
 * Pick the body for the question's type, passing the draft value reactively.
 * Question type and draft-value type always match by construction, so the casts
 * are type-narrowing only (no runtime effect) and reactivity is preserved — no
 * remount on edits, so text/number inputs keep focus.
 */
const QuestionBody: Component<{
  q: Question;
  value: DraftValue;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  type V<T extends DraftValue["type"]> = Extract<DraftValue, { type: T }>;
  type Q<T extends Question["type"]> = Extract<Question, { type: T }>;
  switch (props.q.type) {
    case "singleChoice":
      return (
        <SingleChoiceBody
          q={props.q as Q<"singleChoice">}
          v={props.value as V<"singleChoice">}
          onChange={props.onChange}
        />
      );
    case "multiSelect":
      return (
        <MultiSelectBody
          q={props.q as Q<"multiSelect">}
          v={props.value as V<"multiSelect">}
          onChange={props.onChange}
        />
      );
    case "ranking":
      return (
        <RankingBody
          q={props.q as Q<"ranking">}
          v={props.value as V<"ranking">}
          onChange={props.onChange}
        />
      );
    case "numericRange":
      return (
        <NumericBody
          q={props.q as Q<"numericRange">}
          v={props.value as V<"numeric">}
          onChange={props.onChange}
        />
      );
    case "pointsAllocation":
      return (
        <PointsBody
          q={props.q as Q<"pointsAllocation">}
          v={props.value as V<"pointsAllocation">}
          onChange={props.onChange}
        />
      );
    case "rating":
      return (
        <RatingBody
          q={props.q as Q<"rating">}
          v={props.value as V<"rating">}
          onChange={props.onChange}
        />
      );
    case "custom":
      return (
        <CustomBody
          q={props.q as Q<"custom">}
          v={props.value as V<"custom">}
          onChange={props.onChange}
        />
      );
  }
};

// ----------------------------------------------------------------------------
// Per-type bodies
// ----------------------------------------------------------------------------

const SingleChoiceBody: Component<{
  q: Extract<Question, { type: "singleChoice" }>;
  v: Extract<DraftValue, { type: "singleChoice" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => (
  <div role="radiogroup" class={css.optionGroup}>
    <For each={range(optionCount(props.q.options))}>
      {(i) => {
        const on = () => props.v.optionIndex === i;
        const pick = () =>
          props.onChange({ type: "singleChoice", optionIndex: i });
        return (
          <div
            role="radio"
            tabindex={0}
            aria-checked={on()}
            onClick={pick}
            onKeyDown={activateOnKey(pick)}
            class={css.optionRow}
            classList={{ [css.optionRowOn]: on() }}
          >
            <span class={css.radio} classList={{ [css.radioOn]: on() }}>
              <Show when={on()}>
                <span class={css.radioDot} />
              </Show>
            </span>
            <span>{labelFor(props.q.options, i)}</span>
          </div>
        );
      }}
    </For>
  </div>
);

const MultiSelectBody: Component<{
  q: Extract<Question, { type: "multiSelect" }>;
  v: Extract<DraftValue, { type: "multiSelect" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const toggle = (i: number) => {
    const set = new Set(props.v.selected);
    if (set.has(i)) set.delete(i);
    else if (props.v.selected.length < props.q.maxSelections) set.add(i);
    props.onChange({
      type: "multiSelect",
      selected: [...set].sort((a, b) => a - b),
    });
  };
  return (
    <>
      <div class={css.multiGrid}>
        <For each={range(optionCount(props.q.options))}>
          {(i) => {
            const on = () => props.v.selected.includes(i);
            return (
              <div
                role="checkbox"
                tabindex={0}
                aria-checked={on()}
                onClick={() => toggle(i)}
                onKeyDown={activateOnKey(() => toggle(i))}
                class={css.optionRow}
                classList={{ [css.optionRowOn]: on() }}
              >
                <span
                  class={css.checkbox}
                  classList={{ [css.checkboxOn]: on() }}
                >
                  <Show when={on()}>✓</Show>
                </span>
                <span>{labelFor(props.q.options, i)}</span>
              </div>
            );
          }}
        </For>
      </div>
      <div class={css.multiCount}>
        select {props.q.minSelections}–{props.q.maxSelections} ·{" "}
        {props.v.selected.length} chosen
      </div>
      <Show when={props.q.minSelections === 0}>
        <div class={css.noneNote}>
          <span class={css.noneNoteText}>
            <b class={css.noneNoteLead}>"None of these" is a real answer.</b>{" "}
            This question allows 0 selections — submitting with nothing checked
            records a deliberate empty answer, different from Skip (abstain).
          </span>
        </div>
      </Show>
    </>
  );
};

const RankingBody: Component<{
  q: Extract<Question, { type: "ranking" }>;
  v: Extract<DraftValue, { type: "ranking" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const ranked = () => props.v.ranked;
  const pool = () =>
    range(optionCount(props.q.options)).filter((i) => !ranked().includes(i));
  const set = (next: number[]) =>
    props.onChange({ type: "ranking", ranked: next });
  const add = (i: number) => {
    if (ranked().length < props.q.maxRanked) set([...ranked(), i]);
  };
  const remove = (i: number) => set(ranked().filter((x) => x !== i));
  const move = (idx: number, delta: number) => {
    const next = [...ranked()];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    set(next);
  };
  return (
    <>
      <Show when={ranked().length > 0}>
        <div class={css.rankedList}>
          <For each={ranked()}>
            {(optIdx, pos) => (
              <div class={css.rankedRow}>
                <span class={css.rankNum}>{pos() + 1}</span>
                <span class={css.rankLabel}>
                  {labelFor(props.q.options, optIdx)}
                </span>
                <button
                  class={css.rankBtn}
                  onClick={() => move(pos(), -1)}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  class={css.rankBtn}
                  onClick={() => move(pos(), 1)}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  class={`${css.rankBtn} ${css.rankBtnDanger}`}
                  onClick={() => remove(optIdx)}
                  aria-label="Remove from ranking"
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={pool().length > 0}>
        <div class={css.rankPoolHint}>
          tap to add · rank {props.q.minRanked}–{props.q.maxRanked}
        </div>
        <div class={css.rankPool}>
          <For each={pool()}>
            {(i) => (
              <button
                onClick={() => add(i)}
                disabled={ranked().length >= props.q.maxRanked}
                class={css.poolBtn}
                classList={{
                  [css.poolBtnDisabled]: ranked().length >= props.q.maxRanked,
                }}
              >
                + {labelFor(props.q.options, i)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
};

const NumericBody: Component<{
  q: Extract<Question, { type: "numericRange" }>;
  v: Extract<DraftValue, { type: "numeric" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const { min, max } = props.q.constraints;
  const step = props.q.constraints.step ?? 1n;
  const span = max - min;
  const sliderOk = span > 0n && span <= 100000n;
  const set = (value: bigint) => props.onChange({ type: "numeric", value });
  return (
    <>
      <div class={css.numHero}>
        <span class={css.numValue}>{props.v.value.toString()}</span>
      </div>
      <Show
        when={sliderOk}
        fallback={
          <input
            type="number"
            value={props.v.value.toString()}
            min={min.toString()}
            max={max.toString()}
            step={step.toString()}
            onInput={(e) => {
              const n = e.currentTarget.value.trim();
              if (n === "") return;
              try {
                set(clampStep(BigInt(n), min, max, step));
              } catch {
                /* ignore non-integer input */
              }
            }}
            class={css.numberInput}
          />
        }
      >
        <input
          type="range"
          min={Number(min)}
          max={Number(max)}
          step={Number(step)}
          value={Number(props.v.value)}
          onInput={(e) =>
            set(clampStep(BigInt(e.currentTarget.value), min, max, step))
          }
          class={css.rangeFull}
        />
        <div class={css.rangeBounds}>
          <span>{min.toString()}</span>
          <span>{max.toString()}</span>
        </div>
      </Show>
    </>
  );
};

const PointsBody: Component<{
  q: Extract<Question, { type: "pointsAllocation" }>;
  v: Extract<DraftValue, { type: "pointsAllocation" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const sum = () => props.v.points.reduce((s, p) => s + p, 0);
  const remaining = () => props.q.budget - sum();
  // Clamp to [0, budget − others] so a single field can never push the total
  // over budget — the same invariant the +/- buttons enforce.
  const setPoints = (i: number, raw: number) => {
    const others = sum() - (props.v.points[i] ?? 0);
    const value = Math.max(0, Math.min(raw, props.q.budget - others));
    const next = [...props.v.points];
    next[i] = value;
    props.onChange({ type: "pointsAllocation", points: next });
  };
  const bump = (i: number, delta: number) =>
    setPoints(i, (props.v.points[i] ?? 0) + delta);
  // Capped slider: the track keeps its full 0..budget range, but the thumb is
  // blocked past the remaining budget. We clamp the dragged value and, when it
  // was over the cap, write it back onto the element so the thumb snaps to the
  // cap — Solid won't re-render the input if the clamped value matches state.
  const slideTo = (i: number, el: HTMLInputElement) => {
    const raw = parseInt(el.value, 10) || 0;
    const others = sum() - (props.v.points[i] ?? 0);
    const capped = Math.max(0, Math.min(raw, props.q.budget - others));
    if (capped !== raw) el.value = String(capped);
    setPoints(i, capped);
  };
  return (
    <>
      <div class={css.pointsHeader}>
        <span class={css.pointsRemainLabel}>Remaining to allocate</span>
        <span
          class={css.pointsRemain}
          classList={{ [css.pointsRemainDone]: remaining() === 0 }}
        >
          {remaining()} pts
        </span>
      </div>
      <For each={range(optionCount(props.q.options))}>
        {(i) => (
          <div class={css.pointsRow}>
            <div class={css.pointsRowHead}>
              <span class={css.pointsOptLabel}>
                {labelFor(props.q.options, i)}
              </span>
              <div class={css.pointsControls}>
                <button class={css.stepBtn} onClick={() => bump(i, -1)}>
                  −
                </button>
                <input
                  type="number"
                  min={0}
                  max={props.q.budget}
                  value={props.v.points[i] ?? 0}
                  onInput={(e) => {
                    const n = parseInt(e.currentTarget.value, 10);
                    setPoints(i, Number.isFinite(n) ? n : 0);
                  }}
                  class={css.pointsInput}
                />
                <button class={css.stepBtn} onClick={() => bump(i, 1)}>
                  +
                </button>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={props.q.budget}
              step={1}
              value={props.v.points[i] ?? 0}
              onInput={(e) => slideTo(i, e.currentTarget)}
              class={css.rangeFullBlock}
            />
          </div>
        )}
      </For>
      <div class={css.pointsFooter}>
        distribute {props.q.budget} points · sum must equal budget
      </div>
    </>
  );
};

const RatingBody: Component<{
  q: Extract<Question, { type: "rating" }>;
  v: Extract<DraftValue, { type: "rating" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => {
  const levels = ratingLevels(props.q.scale);
  const setRating = (optIdx: number, rating: bigint) => {
    const next = [...props.v.ratings];
    next[optIdx] = rating;
    props.onChange({ type: "rating", ratings: next });
  };
  return (
    <div class={css.ratingList}>
      <For each={range(optionCount(props.q.options))}>
        {(optIdx) => (
          <div class={css.ratingRow}>
            <span class={css.ratingOptLabel}>
              {labelFor(props.q.options, optIdx)}
            </span>
            <Show
              when={levels}
              fallback={
                <input
                  type="number"
                  value={props.v.ratings[optIdx]?.toString() ?? ""}
                  onInput={(e) => {
                    const n = e.currentTarget.value.trim();
                    if (n === "") return;
                    try {
                      setRating(optIdx, BigInt(n));
                    } catch {
                      /* ignore */
                    }
                  }}
                  class={css.ratingNumberInput}
                />
              }
            >
              <div class={css.ratingLevels}>
                <For each={levels!}>
                  {(lvl) => {
                    const on = () => props.v.ratings[optIdx] === lvl.value;
                    return (
                      <button
                        onClick={() => setRating(optIdx, lvl.value)}
                        class={css.ratingBtn}
                        classList={{ [css.ratingBtnOn]: on() }}
                      >
                        {lvl.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
};

const CustomBody: Component<{
  q: Extract<Question, { type: "custom" }>;
  v: Extract<DraftValue, { type: "custom" }>;
  onChange: (v: DraftValue) => void;
}> = (props) => (
  <>
    <div class={css.customSchema}>
      <span class={css.customSchemaTag}>schema</span>
      <span class={css.customSchemaUri}>{props.q.methodSchema.uri}</span>
    </div>
    <input
      type="text"
      value={props.v.text}
      placeholder="Your answer"
      onInput={(e) =>
        props.onChange({ type: "custom", text: e.currentTarget.value })
      }
      class={css.customInput}
    />
    <p class={css.customHint}>
      Encoded as a raw text metadatum and interpreted by the method at the
      anchor.
    </p>
  </>
);

// ----------------------------------------------------------------------------
// Submit bar, panels, small bits
// ----------------------------------------------------------------------------

const SubmitBar: Component<{
  decided: number;
  total: number;
  replacing: boolean;
  submitting: boolean;
  mismatch: boolean;
  network: string;
  idleText: string;
  busyText: string;
  onSubmit: () => void;
}> = (props) => {
  const ready = () =>
    props.decided >= props.total && props.total > 0 && !props.mismatch;
  return (
    <div class={css.submitBar}>
      <div class={css.submitInner}>
        <div class={css.submitStatus}>
          <span class={css.progressDots}>
            <For each={range(props.total)}>
              {(i) => (
                <span
                  class={css.progressDot}
                  classList={{ [css.progressDotOn]: i < props.decided }}
                />
              )}
            </For>
          </span>
          <span class={css.decidedCount}>
            {props.decided} of {props.total} decided
          </span>
          <Show when={props.replacing}>
            <span class={css.replacesNote}>
              ✓ replaces your previous response
            </span>
          </Show>
          <Show when={props.mismatch}>
            <span class={css.mismatchNote}>
              Switch your wallet to {props.network} to submit
            </span>
          </Show>
        </div>
        <button
          onClick={() => props.onSubmit()}
          disabled={!ready() || props.submitting}
          class={css.submitBtn}
          classList={{ [css.submitBtnEnabled]: ready() && !props.submitting }}
        >
          {props.submitting ? props.busyText : props.idleText}{" "}
          <span class={css.submitArrow}>→</span>
        </button>
      </div>
    </div>
  );
};

const SubmittedPanel: Component<{ hash: string; surveyKey: string }> = (
  props,
) => {
  const navigate = useNavigate();
  return (
    <div class={css.submittedPanel}>
      <span class={css.submittedCheck}>✓</span>
      <h3 class={css.submittedTitle}>Response submitted</h3>
      <p class={css.submittedText}>
        Your response was published under metadata label 17. It may take a few
        moments to appear in the tally as the indexer catches up.
      </p>
      <div class={css.submittedTx}>
        <TxLink hash={props.hash} />
      </div>
      <button
        onClick={() =>
          navigate(`/survey/${encodeURIComponent(props.surveyKey)}`)
        }
        class={css.viewResultsBtn}
      >
        View results →
      </button>
    </div>
  );
};

const Notice: Component<{
  tone: "warn" | "muted";
  title: string;
  body: string;
}> = (props) => (
  <div
    class={css.notice}
    classList={{ [css.noticeWarn]: props.tone === "warn" }}
  >
    <div
      class={css.noticeTitle}
      classList={{ [css.noticeTitleWarn]: props.tone === "warn" }}
    >
      {props.title}
    </div>
    <p class={css.noticeBody}>{props.body}</p>
  </div>
);

const Empty: Component<{
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
}> = (props) => (
  <div class={css.empty}>
    <Show
      when={props.error}
      fallback={props.loading ? "Loading…" : "Survey not found."}
    >
      <div class={css.emptyError}>
        Couldn't load from the network — this may be a transient error.
      </div>
      <button
        type="button"
        onClick={() => props.onRetry?.()}
        class={css.retryBtn}
      >
        Retry
      </button>
    </Show>
  </div>
);

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

/**
 * Keyboard handler for div-based radio/checkbox rows: Enter or Space activates
 * the row (Space's default page-scroll is suppressed), matching native controls.
 */
function activateOnKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function labelFor(opts: OptionsOrCount, i: number): string {
  return opts.type === "options"
    ? (opts.labels[i] ?? `Option ${i + 1}`)
    : `Option ${i + 1}`;
}

function typeMeta(q: Question): string {
  switch (q.type) {
    case "multiSelect":
      return `${TYPE_LABEL[q.type]} · ${q.minSelections}–${q.maxSelections}`;
    case "ranking":
      return `${TYPE_LABEL[q.type]} · ${q.minRanked}–${q.maxRanked}`;
    case "numericRange": {
      const { min, max } = q.constraints;
      return `${TYPE_LABEL[q.type]} · ${min}–${max}`;
    }
    case "pointsAllocation":
      return `${TYPE_LABEL[q.type]} · budget ${q.budget}`;
    default:
      return TYPE_LABEL[q.type];
  }
}

function clampStep(
  value: bigint,
  min: bigint,
  max: bigint,
  step: bigint,
): bigint {
  let v = value < min ? min : value > max ? max : value;
  if (step > 0n) v = min + ((v - min) / step) * step;
  return v;
}

function ratingLevels(
  scale: RatingScale,
): { value: bigint; label: string }[] | null {
  switch (scale.type) {
    case "labels":
      return scale.labels.map((l, i) => ({ value: BigInt(i), label: l }));
    case "count":
      return range(scale.count).map((i) => ({
        value: BigInt(i),
        label: String(i + 1),
      }));
    case "numeric": {
      const { min, max } = scale.constraints;
      const step = scale.constraints.step ?? 1n;
      if (step <= 0n || max < min) return null;
      const n = Number((max - min) / step) + 1;
      if (n < 1 || n > 12) return null;
      return range(n).map((i) => {
        const v = min + BigInt(i) * step;
        return { value: v, label: v.toString() };
      });
    }
  }
}
