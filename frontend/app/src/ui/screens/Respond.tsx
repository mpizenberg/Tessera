import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import {
  SPEC_VERSION,
  encodeAnswerItem,
  encodePayload,
  validateResponse,
  type ContentAnchor,
  type Metadatum,
  type Question,
  type Role,
  type SurveyDefinition,
} from "cip-179";

import { useApp } from "~/state";
import {
  dedupeResponses,
  findSurvey,
  hexToBytes,
  voteDeadlineUnix,
  type ChainTip,
  type SurveyAggregate,
} from "cip-179/domain";
import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  type Draft,
  type DraftValue,
  type I18n,
  type Responder,
} from "cardano-tessera-respond-core";
import {
  ClassesContext,
  I18nContext,
  QuestionBody,
  createResponseDraft,
  range,
  typeMeta,
  useI18n,
  type BodyClasses,
} from "cardano-tessera-respond-ui";
import { walletResponder } from "~/domain/roles";
import { usePresentation } from "~/enrichment/usePresentation";
import { IPFS_PROVIDERS } from "~/enrichment/providers";
import { Empty } from "~/ui/components/Empty";
import { OnchainPreview } from "~/ui/components/OnchainPreview";
import { ErrorBox, ProblemList } from "~/ui/components/Feedback";
import { SegmentedToggle } from "~/ui/components/SegmentedToggle";
import { SubmissionReceipt } from "~/ui/components/SubmissionReceipt";
import { PublishLocked, QueuedNote } from "~/ui/components/CartDrawer";
import {
  SubmitProgressModal,
  type SubmitStep,
} from "~/ui/components/SubmitProgress";
import { isQuicknet, sealAnswers, sealedCiphertextSize } from "cip-179/tlock";
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
import type { Action } from "~/wallet/action";
import { type WalletIdentity } from "~/wallet/types";
import { t, n, d } from "~/i18n";
import { problemText } from "~/i18n/problem";
import css from "./Respond.module.css";

/**
 * The shared question bodies (`cardano-tessera-respond-ui`) render class names through
 * {@link ClassesContext}; this maps each one to this screen's CSS module. Keys
 * are checked complete by `BodyClasses`, so a body can't render a class this
 * screen doesn't style.
 */
const bodyClasses: BodyClasses = {
  optionGroup: css.optionGroup,
  optionRow: css.optionRow,
  optionRowOn: css.optionRowOn,
  radio: css.radio,
  radioOn: css.radioOn,
  radioDot: css.radioDot,
  multiGrid: css.multiGrid,
  checkbox: css.checkbox,
  checkboxOn: css.checkboxOn,
  multiCount: css.multiCount,
  noneNote: css.noneNote,
  noneNoteText: css.noneNoteText,
  noneNoteLead: css.noneNoteLead,
  rankedList: css.rankedList,
  rankedRow: css.rankedRow,
  rankNum: css.rankNum,
  rankLabel: css.rankLabel,
  rankBtn: css.rankBtn,
  rankBtnDanger: css.rankBtnDanger,
  rankPoolHint: css.rankPoolHint,
  rankPool: css.rankPool,
  poolBtn: css.poolBtn,
  poolBtnDisabled: css.poolBtnDisabled,
  numHero: css.numHero,
  numValue: css.numValue,
  numberInput: css.numberInput,
  rangeFull: css.rangeFull,
  rangeBounds: css.rangeBounds,
  pointsHeader: css.pointsHeader,
  pointsRemainLabel: css.pointsRemainLabel,
  pointsRemain: css.pointsRemain,
  pointsRemainDone: css.pointsRemainDone,
  pointsRow: css.pointsRow,
  pointsRowHead: css.pointsRowHead,
  pointsOptLabel: css.pointsOptLabel,
  pointsControls: css.pointsControls,
  stepBtn: css.stepBtn,
  pointsInput: css.pointsInput,
  rangeFullBlock: css.rangeFullBlock,
  pointsFooter: css.pointsFooter,
  ratingList: css.ratingList,
  ratingRow: css.ratingRow,
  ratingOptLabel: css.ratingOptLabel,
  ratingNumberInput: css.ratingNumberInput,
  ratingLevels: css.ratingLevels,
  ratingBtn: css.ratingBtn,
  ratingBtnOn: css.ratingBtnOn,
  ratHint: css.ratHint,
  customSchema: css.customSchema,
  customSchemaTag: css.customSchemaTag,
  customSchemaUri: css.customSchemaUri,
  customInput: css.customInput,
  customHint: css.customHint,
};

// ----------------------------------------------------------------------------
// Screen
// ----------------------------------------------------------------------------

export const Respond: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);

  // i18n for the shared question bodies: the app's own engine wearing
  // respond-core's `I18n` interface — compile-time sound because the app's
  // respond/roles/validation namespaces spread respond-core's catalogs, so
  // every core key is an app key. `t`/`n`/`d` each read the locale signal, so
  // calls stay reactive behind a constant instance.
  const bodiesI18n: I18n = { t, n, d };

  // Fall back to the optimistic set so a just-created survey is answerable
  // immediately, before Koios indexes it (mirrors the results page).
  const indexed = createMemo(() => {
    const snap = app.list.error ? undefined : app.list();
    return snap ? findSurvey(snap.surveys, key()) : undefined;
  });
  const survey = createMemo(
    () => indexed() ?? app.optimisticSurveys().find((a) => a.key === key()),
  );
  const tip = createMemo<ChainTip | undefined>(
    () => (app.list.error ? undefined : app.list())?.tip,
  );

  // The survey's raw responses ride in its lazily-fetched bundle (the list
  // payload carries only counts); they're needed here solely to pre-fill the
  // form from a prior response. Best-effort: an optimistic survey has no
  // bundle to fetch, and a failed fetch just means no pre-fill.
  const [bundle] = createResource(
    () => indexed()?.record.ref,
    (ref) => app.source.surveyBundle(ref),
  );
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

  // Tick once a minute: the survey's open/closed status was computed against the
  // chain tip when the list loaded, so a tab left open across the deadline would
  // otherwise keep offering a submit whose fee buys an excluded response.
  const [nowUnix, setNowUnix] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(
    () => setNowUnix(Math.floor(Date.now() / 1000)),
    60_000,
  );
  onCleanup(() => clearInterval(clock));

  // Unknown while the tip is (a failed list load, an optimistic survey) — then
  // nothing here gates, and the aggregate's own status is all we have.
  const deadlineUnix = createMemo<number | undefined>(() => {
    const def = definition();
    const chainTip = tip();
    if (!def || !chainTip) return undefined;
    return voteDeadlineUnix(def.endEpoch, chainTip, app.config.secondsPerEpoch);
  });
  /** Takes its clock explicitly: the display ticks, the submit gate reads live. */
  const deadlinePassed = (atUnix: number): boolean => {
    const d = deadlineUnix();
    return d !== undefined && atUnix >= d;
  };
  /** Warning while the deadline is close enough that signing at leisure misses it. */
  const deadlineWarning = (): string | undefined => {
    const d = deadlineUnix();
    if (d === undefined) return undefined;
    const left = d - nowUnix();
    if (left <= 0 || left > 10 * 60) return undefined;
    return t("respond.deadlineSoon", { m: n(Math.ceil(left / 60)) });
  };

  // Role choice, drafts and progress: the spine shared with the widget. The app
  // feeds it a wallet-derived responder, the survey's on-chain ref, and the
  // responses riding in the lazily-fetched bundle. `definition()` is the
  // enriched one, so external-content labels swapping in reseeds the form.
  const responder = createMemo<Responder>(() => {
    const id = identity();
    return id ? walletResponder(id) : {};
  });
  const {
    respondable,
    role,
    pickRole,
    credential,
    prior,
    drafts,
    setValue,
    setSkipped,
    total,
    decidedCount,
    answered,
  } = createResponseDraft({
    definition,
    surveyRef: () => survey()?.record.ref,
    responder,
    priorResponses: () => {
      const b = bundle.error ? undefined : bundle();
      return b
        ? dedupeResponses(b.responses).map((x) => x.response)
        : undefined;
    },
    preferredRole: () => app.activeRole() as Role | null,
  });

  const sealedMode = createMemo(() => {
    const mode = definition()?.submissionMode;
    return mode?.type === "sealed" ? mode : null;
  });

  // A sealed survey pinned to a drand chain the bundled tlock can't decrypt:
  // such a vote would be permanently undecryptable, so we block submission
  // outright rather than warn. (Every survey Tessera creates uses quicknet; this
  // only fires for an externally-built definition on another chain.)
  const sealedUnsupported = createMemo(() => {
    const m = sealedMode();
    return m !== null && !isQuicknet(m.chainHash);
  });

  /** Why submitting is impossible right now, if it is. */
  const submitBlocked = (): string | undefined => {
    if (sealedUnsupported()) return t("respond.sealedUnsupportedNote");
    if (deadlinePassed(nowUnix())) return t("respond.deadlinePassed");
    return undefined;
  };

  const [submitting, setSubmitting] = createSignal(false);
  const [busyText, setBusyText] = createSignal(t("respond.submitting"));
  const [stepKey, setStepKey] = createSignal<string | null>(null);
  const [problems, setProblems] = createSignal<string[]>([]);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [queued, setQueued] = createSignal(false);
  // With something already waiting, submitting this response would publish that
  // too — so the button queues instead, and the cart is where it all goes out.
  const queueing = (): boolean => app.cart().length > 0;

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

  // Parse the *manual* rationale anchor: the anchor, `undefined` (none), or
  // "invalid" (problems set). URI required; hash must be 32 bytes of hex. The
  // write/pin path resolves its anchor asynchronously at submit time instead.
  const manualRationaleAnchor = (): ContentAnchor | undefined | "invalid" => {
    if (!app.ui.pro || !rationaleOn() || ratMode() !== "manual")
      return undefined;
    const uri = ratUri().trim();
    const probs: string[] = [];
    if (uri === "") probs.push(t("respond.ratProblemUriRequired"));
    let hash: Uint8Array | null = null;
    try {
      const b = hexToBytes(ratHash().trim());
      if (b.length !== 32) probs.push(t("respond.ratProblemHashBytes"));
      else hash = b;
    } catch {
      probs.push(t("respond.ratProblemHashHex"));
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
    setBusyText(t("respond.pinningRationale"));
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

  // The CBOR encoder is in the wallet seam (lazy) — load it once to measure the
  // real on-chain size of a sealed response without encrypting anything.
  const [cborMod] = createResource(() => import("~/wallet/cbor"));

  // The true on-chain byte size of a sealed submission: the plaintext is padded
  // to `padding_size` (or its own CBOR length if larger), encrypted to a
  // ciphertext of the analytically-known size, and wrapped in the label-17
  // response envelope. We measure that envelope with a zero-filled placeholder
  // ciphertext — same length as the real one — so the Pro preview can show the
  // real size + fee before submit, with no tlock load. undefined for public.
  const sealedOnchainSize = createMemo<number | undefined>(() => {
    const mod = cborMod();
    const sealed = sealedMode();
    const s = survey();
    const r = role();
    const cred = credential();
    const answersMeta = sealedPreview();
    if (!mod || !sealed || !s || r === null || !cred || !answersMeta)
      return undefined;
    try {
      const plaintextLen = Math.max(
        mod.metadatumToCbor(answersMeta).length,
        sealed.paddingSize,
      );
      const ciphertext = new Uint8Array(
        sealedCiphertextSize(plaintextLen, sealed.round),
      );
      const response = buildSealedResponse(
        s.record.ref,
        r,
        cred,
        ciphertext,
        previewRationale(),
      );
      const payload = encodePayload({
        type: "responses",
        responses: [response],
      });
      return mod.metadatumToCbor(payload).length;
    } catch {
      return undefined;
    }
  });

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
      steps.push({ key: "pin", label: t("respond.stepPin") });
    if (sealedMode())
      steps.push({ key: "encrypt", label: t("respond.stepEncrypt") });
    steps.push({
      key: "submit",
      label: t("respond.stepSubmit"),
    });
    return steps;
  });

  const onSubmit = async (queueOnly: boolean) => {
    const def = definition();
    const s = survey();
    const r = role();
    const cred = credential();
    if (!def || !s || r === null || !cred) return;

    // Authoritative deadline check, against the live clock: the submit button
    // disables itself, but a click can beat the minute tick that disables it.
    if (deadlinePassed(Math.floor(Date.now() / 1000))) {
      setProblems([t("respond.deadlinePassed")]);
      return;
    }

    // Manual rationale anchor (Pro) parsed up front so a bad hash surfaces
    // alongside answer problems, before any signing. The write/pin path is
    // resolved asynchronously below (it needs a network round-trip).
    const manualRationale = manualRationaleAnchor();
    if (manualRationale === "invalid") return;

    // Everything the submission is built from is captured at click time:
    // pinning a rationale awaits, and the progress overlay blocks the pointer
    // but not the keyboard, so reading live state afterwards could submit
    // something the validation below never saw. Draft values are replaced
    // immutably on edit, so copying the records detaches them from the store.
    const sealed = sealedMode();
    const draftsNow = drafts.map((d) => ({
      skipped: d.skipped,
      value: d.value,
    }));

    // Validate the answers as plaintext first — for a sealed survey nobody can
    // check them again until the reveal, so they must be well-formed now. The
    // rationale never affects answer validation, so it's resolved after.
    const found = validateResponse(
      { ...def, submissionMode: { type: "public" } },
      buildResponse(s.record.ref, r, cred, def.questions, draftsNow),
    );
    setProblems(found.map(problemText));
    if (found.length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    setStepKey(submitSteps()[0]?.key ?? "submit");
    try {
      // Resolve (and, in write mode, pin) the rationale before building.
      const rationale = await resolveRationale(manualRationale);

      let response = buildResponse(
        s.record.ref,
        r,
        cred,
        def.questions,
        draftsNow,
        rationale,
      );
      if (sealed) {
        // Timelock-encrypt the answers to the survey's drand round, then submit
        // the ciphertext instead of the plaintext answers.
        setStepKey("encrypt");
        setBusyText(t("respond.encrypting"));
        // Only ~/wallet/cbor is loaded lazily — it is the import that gates
        // the heavy evolution-sdk chunk. cip-179/tlock is already statically
        // imported above (tlock-js itself stays lazy inside its client).
        const { evolutionCodec } = await import("~/wallet/cbor");
        const ciphertext = await sealAnswers(
          evolutionCodec,
          collectAnswers(def.questions, draftsNow),
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
      setBusyText(t("respond.submitting"));
      // Prove control of the responder credential via required_signers (CIP-179
      // credential proof) — e.g. forces the wallet to sign with the stake key
      // when responding as a Stakeholder, not just the payment key.
      const action: Action = {
        kind: "response",
        response,
        proveCredentials: [cred],
        title: def.title || undefined,
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
      setBusyText(t("respond.submitting"));
      setStepKey(null);
    }
  };

  return (
    <main class={css.main}>
      <A href={`/survey/${encodeURIComponent(key())}`} class={css.backLink}>
        <span class={css.backArrow}>←</span> {t("respond.backToResults")}
      </A>

      <Show when={submitting() && submitSteps().length > 1}>
        <SubmitProgressModal
          title={
            sealedMode()
              ? t("respond.progressTitleSealed")
              : t("respond.progressTitlePublic")
          }
          steps={submitSteps()}
          currentKey={stepKey()}
        />
      </Show>

      <Show
        when={survey()}
        fallback={
          <Empty
            loading={app.list.loading}
            error={app.list.error}
            onRetry={() => app.reload()}
            text={{
              loading: t("respond.loading"),
              notFound: t("respond.notFound"),
              error: t("respond.loadError"),
              retry: t("respond.retry"),
            }}
          />
        }
      >
        {(s) => (
          <Show
            when={txHash() === null && !queued()}
            fallback={
              <Show when={txHash()} fallback={<QueuedNote />}>
                {(hash) => <SubmittedPanel hash={hash()} surveyKey={key()} />}
              </Show>
            }
          >
            <SurveyHeader
              s={s()}
              def={definition() ?? s().record.definition}
              pro={app.ui.pro}
              role={role()}
              respondable={respondable()}
              // Per-survey choice only — must not rewrite the app-wide active
              // role used by other screens (e.g. the "mine" Explore filter).
              onPickRole={pickRole}
            />

            <Show when={s().cancellationClaimed}>
              <div class={css.cancelClaim}>
                <strong>{t("respond.cancelClaimLead")}</strong>{" "}
                {t("respond.cancelClaimBody")}
              </div>
            </Show>

            <Switch3
              s={s()}
              connected={identity() !== null}
              respondable={respondable()}
            >
              {/* The actual form (open + eligible) */}
              <Show when={prior()}>
                <RespondedBanner role={role()} />
              </Show>
              <Show when={sealedMode()}>
                {(m) => <SealedBanner round={m().round} />}
              </Show>
              <Show when={sealedUnsupported()}>
                <Notice
                  tone="warn"
                  title={t("respond.sealedUnsupportedTitle")}
                  body={t("respond.sealedUnsupportedBody")}
                />
              </Show>
              <Show when={pres.external() && pres.unavailable()}>
                <LabelsAbsentBanner keyStr={key()} />
              </Show>

              <I18nContext.Provider value={() => bodiesI18n}>
                <ClassesContext.Provider value={bodyClasses}>
                  <div class={css.questionList}>
                    <For
                      each={(definition() ?? s().record.definition).questions}
                    >
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
                </ClassesContext.Provider>
              </I18nContext.Provider>

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
                  title={t("respond.problemsTitle")}
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
                  onchainSize={sealedOnchainSize()}
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
          !queued() &&
          (viewStatus(survey()!) === "public" ||
            viewStatus(survey()!) === "sealed") &&
          role() !== null
        }
      >
        <Show when={!app.cartLocked()} fallback={<PublishLocked />}>
          <SubmitBar
            decided={decidedCount()}
            total={total()}
            answered={answered()}
            replacing={prior() !== undefined}
            submitting={submitting()}
            mismatch={mismatch()}
            blocked={submitBlocked()}
            warning={deadlineWarning()}
            network={app.config.network}
            idleText={
              sealedMode()
                ? t("respond.encryptAndSubmit")
                : t("respond.signAndSubmit")
            }
            busyText={busyText()}
            queueing={queueing()}
            onSubmit={() => void onSubmit(false)}
            onQueue={() => void onSubmit(true)}
          />
        </Show>
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
      props.v === "invalid"
        ? t("respond.untalliableTitle")
        : props.v === "cancelled"
          ? t("respond.closedCancelledTitle")
          : t("respond.closedTitle")
    }
    body={
      props.v === "invalid"
        ? t("respond.untalliableBody")
        : props.v === "cancelled"
          ? t("respond.closedCancelledBody")
          : t("respond.closedBody")
    }
  />
);

const ConnectPrompt: Component = () => (
  <Notice
    tone="muted"
    title={t("respond.connectTitle")}
    body={t("respond.connectBody")}
  />
);

const Ineligible: Component<{ def: SurveyDefinition }> = (props) => (
  <div class={css.card}>
    <h3 class={css.ineligibleTitle}>{t("respond.ineligibleTitle")}</h3>
    <p class={css.ineligibleLead}>{t("respond.ineligibleLead")}</p>
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
                    {t("respond.notClaimable")}
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
      <span class={css.respondLabel}>{t("respond.respondLabel")}</span>
      {/* refText carries margin-left:auto, so no spacer node is needed. When
          pro is off, "Responding as" / title don't depend on the spacer. */}
      <Show when={props.pro}>
        <span title={t("respond.refTitle")} class={css.refText}>
          {t("respond.refPrefix", { ref: fullRef(props.s.key) })}
        </span>
      </Show>
    </div>
    <h1 class={css.headerTitle}>
      {props.def.title || t("respond.untitledSurvey")}
    </h1>
    <Show when={props.def.description}>
      <p class={css.headerDesc}>{props.def.description}</p>
    </Show>

    <Show when={props.respondable.length > 0}>
      <div class={css.roleRow}>
        <span class={css.roleRowLabel}>{t("respond.respondingAs")}</span>
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
        {t("respond.alreadyResponded", {
          role:
            props.role !== null
              ? roleLabel(props.role)
              : t("respond.alreadyRespondedRoleFallback"),
        })}
      </div>
      <div class={css.respondedText}>{t("respond.alreadyRespondedText")}</div>
    </div>
  </div>
);

const SealedBanner: Component<{ round: number }> = (props) => (
  <div class={css.cardBanner}>
    <span class={css.bannerIcon}>◆</span>
    <div class={css.bannerBody}>
      <div class={css.bannerTitle}>{t("respond.sealedTitle")}</div>
      <div class={css.bannerText}>
        {t("respond.sealedTextBefore")}
        <b>{t("respond.sealedNoOne")}</b>
        {t("respond.sealedTextAfter", {
          reveal: formatRevealDate(props.round),
        })}
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
      <div class={css.bannerTitle}>{t("respond.labelsAbsentTitle")}</div>
      <div class={css.bannerText}>
        {t("respond.labelsAbsentTextBefore")}
        <span class={css.refInline}>{shortRef(props.keyStr)}</span>
        {t("respond.labelsAbsentTextMid")}
        <b>{t("respond.labelsAbsentCanRespond")}</b>
        {t("respond.labelsAbsentTextAfter")}
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
    <div class={css.card}>
      <div class={css.qHead}>
        <div class={css.qHeadLeft}>
          <span class={css.qChip}>
            {t("respond.questionChip", { n: n(props.index + 1) })}
          </span>
          <span class={css.qType}>{typeMeta(i18n, props.q)}</span>
          <Show when={props.q.required}>
            <span class={css.qRequired}>{t("respond.required")}</span>
          </Show>
        </div>
        <Show when={!props.q.required}>
          <button
            onClick={() => props.onSkip(!skipped())}
            class={css.skipBtn}
            classList={{ [css.skipBtnOn]: skipped() }}
          >
            {skipped() ? t("respond.skipped") : t("respond.skip")}
          </button>
        </Show>
      </div>
      <h3 class={css.qPrompt}>{props.q.prompt || t("respond.noPrompt")}</h3>

      <Show
        when={!skipped()}
        fallback={<p class={css.qSkipped}>{t("respond.skippedNote")}</p>}
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

// ----------------------------------------------------------------------------
// Submit bar, panels, small bits
// ----------------------------------------------------------------------------

const SubmitBar: Component<{
  decided: number;
  total: number;
  /** At least one question carries a recorded answer (not all-skipped). */
  answered: boolean;
  replacing: boolean;
  submitting: boolean;
  mismatch: boolean;
  /** Why submitting is impossible, if it is — shown as a note, disables the button. */
  blocked?: string | undefined;
  /** Submitting is still possible but time-critical (deadline within minutes). */
  warning?: string | undefined;
  network: string;
  idleText: string;
  busyText: string;
  /** True when submitting would queue the response rather than sign it now. */
  queueing: boolean;
  onSubmit: () => void;
  onQueue: () => void;
}> = (props) => {
  const ready = () =>
    props.decided >= props.total &&
    props.total > 0 &&
    props.answered &&
    !props.mismatch &&
    !props.blocked;
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
            {t("respond.decidedCount", {
              decided: n(props.decided),
              total: n(props.total),
            })}
          </span>
          <Show when={props.replacing}>
            <span class={css.replacesNote}>{t("respond.replacesNote")}</span>
          </Show>
          <Show when={props.mismatch}>
            <span class={css.mismatchNote}>
              {t("respond.switchNetwork", { network: props.network })}
            </span>
          </Show>
          <Show when={props.blocked}>
            {(note) => <span class={css.mismatchNote}>{note()}</span>}
          </Show>
          <Show when={props.warning}>
            {(note) => <span class={css.mismatchNote}>{note()}</span>}
          </Show>
        </div>
        <div class={css.submitActions}>
          <Show when={!props.queueing}>
            <button
              onClick={() => props.onQueue()}
              disabled={!ready() || props.submitting}
              class={css.queueBtn}
            >
              {t("cart.addToCart")}
            </button>
          </Show>
          <button
            onClick={() =>
              props.queueing ? props.onQueue() : props.onSubmit()
            }
            disabled={!ready() || props.submitting}
            class={css.submitBtn}
            classList={{ [css.submitBtnEnabled]: ready() && !props.submitting }}
          >
            {props.submitting
              ? props.busyText
              : props.queueing
                ? t("cart.addToCart")
                : props.idleText}{" "}
            <span class={css.submitArrow}>→</span>
          </button>
        </div>
      </div>
    </div>
  );
};

const SubmittedPanel: Component<{ hash: string; surveyKey: string }> = (
  props,
) => {
  const navigate = useNavigate();
  return (
    <SubmissionReceipt
      title={t("respond.submittedTitle")}
      body={t("respond.submittedText")}
      hash={props.hash}
      actions={[
        {
          label: t("respond.viewResults"),
          onClick: () =>
            navigate(`/survey/${encodeURIComponent(props.surveyKey)}`),
        },
      ]}
    />
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
