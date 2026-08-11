import { Show, createMemo, createResource, type Component } from "solid-js";
import { A, useParams } from "@solidjs/router";
import type { Role, SealedSubmissionMode, SurveyDefinition } from "cip-179";

import { useApp } from "~/state";
import { dedupeResponses, findSurvey } from "cip-179/domain";
import type { Responder } from "cardano-tessera-respond-core";
import { createResponseDraft } from "cardano-tessera-respond-ui";
import { walletResponder } from "~/domain/roles";
import { usePresentation } from "~/enrichment/usePresentation";
import { Empty } from "~/ui/components/Empty";
import { OnchainPreview } from "~/ui/components/OnchainPreview";
import { ErrorBox, ProblemList } from "~/ui/components/Feedback";
import { PublishLocked, QueuedNote } from "~/ui/components/CartDrawer";
import { SubmitProgressModal } from "~/ui/components/SubmitProgress";
import { networkMismatch, viewStatus } from "~/ui/format";
import type { WalletIdentity } from "~/wallet/types";
import { t } from "~/i18n";
import { FormGate, Notice } from "./Gate";
import {
  LabelsAbsentBanner,
  RespondedBanner,
  SealedBanner,
  SurveyHeader,
} from "./Header";
import { QuestionList } from "./Question";
import { RationaleSection, createRationale } from "./Rationale";
import { SubmitBar, SubmittedPanel } from "./Submit";
import { createDeadline } from "./deadline";
import {
  createOnchainPreview,
  createSubmission,
  sealedUnsupported,
} from "./submission";
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
  const pres = usePresentation(() => survey()?.record.definition);
  const definition = (): SurveyDefinition | undefined => pres.def();
  const identity = (): WalletIdentity | null => app.wallet()?.identity ?? null;
  // Block submitting while the wallet is on a different network than the app, so
  // the signature can't be built against the wrong chain. Mirrors create + propose.
  const mismatch = (): boolean =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  // Role choice, drafts and progress: the spine shared with the widget. The app
  // feeds it a wallet-derived responder, the survey's on-chain ref, and the
  // responses riding in the lazily-fetched bundle. `definition()` is the
  // enriched one, so external-content labels swapping in reseeds the form.
  const responder = createMemo<Responder>(() => {
    const id = identity();
    return id ? walletResponder(id) : {};
  });
  const draft = createResponseDraft({
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

  const sealedMode = createMemo<SealedSubmissionMode | null>(() => {
    const mode = definition()?.submissionMode;
    return mode?.type === "sealed" ? mode : null;
  });

  const source = {
    definition,
    surveyRef: () => survey()?.record.ref,
    role: draft.role,
    credential: draft.credential,
    drafts: draft.drafts,
    sealedMode,
  };
  const deadline = createDeadline(definition);
  const rationale = createRationale();
  const preview = createOnchainPreview(source, rationale);
  const submission = createSubmission({ source, deadline, rationale });

  /** Why submitting is impossible right now, if it is. */
  const submitBlocked = (): string | undefined => {
    if (sealedUnsupported(sealedMode))
      return t("respond.sealedUnsupportedNote");
    if (deadline.passedNow()) return t("respond.deadlinePassed");
    return undefined;
  };

  return (
    <main class={css.main}>
      <A href={`/survey/${encodeURIComponent(key())}`} class={css.backLink}>
        <span class={css.backArrow}>←</span> {t("respond.backToResults")}
      </A>

      <Show when={submission.submitting() && submission.steps().length > 1}>
        <SubmitProgressModal
          title={
            sealedMode()
              ? t("respond.progressTitleSealed")
              : t("respond.progressTitlePublic")
          }
          steps={submission.steps()}
          currentKey={submission.stepKey()}
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
            when={submission.txHash() === null && !submission.queued()}
            fallback={
              <Show when={submission.txHash()} fallback={<QueuedNote />}>
                {(hash) => <SubmittedPanel hash={hash()} surveyKey={key()} />}
              </Show>
            }
          >
            <SurveyHeader
              s={s()}
              def={definition() ?? s().record.definition}
              pro={app.ui.pro}
              role={draft.role()}
              respondable={draft.respondable()}
              // Per-survey choice only — must not rewrite the app-wide active
              // role used by other screens (e.g. the "mine" Explore filter).
              onPickRole={draft.pickRole}
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
              respondable={draft.respondable()}
            >
              {/* The actual form (open + eligible) */}
              <Show when={draft.prior()}>
                <RespondedBanner role={draft.role()} />
              </Show>
              <Show when={sealedMode()}>
                {(m) => <SealedBanner round={m().round} />}
              </Show>
              <Show when={sealedUnsupported(sealedMode)}>
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
                drafts={draft.drafts}
                onChange={draft.setValue}
                onSkip={draft.setSkipped}
              />

              <Show when={app.ui.pro}>
                <RationaleSection r={rationale} />
              </Show>

              <Show when={submission.problems().length > 0}>
                <ProblemList
                  title={t("respond.problemsTitle")}
                  problems={submission.problems()}
                />
              </Show>
              <Show when={submission.error()}>
                <ErrorBox message={submission.error()!} />
              </Show>

              <Show when={app.ui.pro}>
                <OnchainPreview
                  payload={preview.payload()}
                  sealed={sealedMode() !== null}
                  paddingSize={preview.paddingSize()}
                  onchainSize={preview.onchainSize()}
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
          submission.txHash() === null &&
          !submission.queued() &&
          (viewStatus(survey()!) === "public" ||
            viewStatus(survey()!) === "sealed") &&
          draft.role() !== null
        }
      >
        <Show when={!app.cartLocked()} fallback={<PublishLocked />}>
          <SubmitBar
            decided={draft.decidedCount()}
            total={draft.total()}
            answered={draft.answered()}
            replacing={draft.prior() !== undefined}
            submitting={submission.submitting()}
            mismatch={mismatch()}
            blocked={submitBlocked()}
            warning={deadline.warning()}
            network={app.config.network}
            idleText={
              sealedMode()
                ? t("respond.encryptAndSubmit")
                : t("respond.signAndSubmit")
            }
            busyText={submission.busyText()}
            queueing={submission.queueing()}
            onSubmit={() => void submission.submit(false)}
            onQueue={() => void submission.submit(true)}
          />
        </Show>
      </Show>
    </main>
  );
};
