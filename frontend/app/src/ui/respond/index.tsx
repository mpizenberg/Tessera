import {
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import {
  SPEC_VERSION,
  encodeAnswerItem,
  encodePayload,
  validateResponse,
  type ContentAnchor,
  type Metadatum,
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
} from "cip-179/domain";
import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  type Responder,
} from "cardano-tessera-respond-core";
import { createResponseDraft } from "cardano-tessera-respond-ui";
import { walletResponder } from "~/domain/roles";
import { usePresentation } from "~/enrichment/usePresentation";
import { IPFS_PROVIDERS } from "~/enrichment/providers";
import { Empty } from "~/ui/components/Empty";
import { OnchainPreview } from "~/ui/components/OnchainPreview";
import { ErrorBox, ProblemList } from "~/ui/components/Feedback";
import { PublishLocked, QueuedNote } from "~/ui/components/CartDrawer";
import {
  SubmitProgressModal,
  type SubmitStep,
} from "~/ui/components/SubmitProgress";
import { isQuicknet, sealAnswers, sealedCiphertextSize } from "cip-179/tlock";
import { networkMismatch, viewStatus } from "~/ui/format";
import type { Action } from "~/wallet/action";
import { type WalletIdentity } from "~/wallet/types";
import { t, n } from "~/i18n";
import { problemText } from "~/i18n/problem";
import { FormGate, Notice } from "./Gate";
import {
  LabelsAbsentBanner,
  RespondedBanner,
  SealedBanner,
  SurveyHeader,
} from "./Header";
import { QuestionList } from "./Question";
import { RationaleSection } from "./Rationale";
import { SubmitBar, SubmittedPanel } from "./Submit";
import css from "./respond.module.css";

export const Respond: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);

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

            <FormGate
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

              <QuestionList
                questions={(definition() ?? s().record.definition).questions}
                drafts={drafts}
                onChange={setValue}
                onSkip={setSkipped}
              />

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
            </FormGate>
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
