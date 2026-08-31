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
import { A, useParams } from "@solidjs/router";
import type { SurveyDefinition } from "cip-179";

import {
  auditResponses,
  findSurvey,
  type ChainTip,
  type ProofVerdicts,
  type ResponseAudit,
  type ResponseRecord,
  type SurveyAggregate,
} from "cip-179/domain";
import type { TallyArtifact } from "cip-179/tally";

import { useApp } from "~/state";
import { computeAlignment } from "~/domain/anchorLink";
import { roleBreakdown } from "~/domain/results";
import { walletCanProveOwner, walletOwns } from "~/domain/roles";
import { usePresentation } from "~/enrichment/usePresentation";
import {
  endsText,
  fullRef,
  networkMismatch,
  roleColors,
  roleLabel,
  shortRef,
  viewStatus,
} from "~/ui/format";
import { Results } from "~/ui/results";
import { Empty, type EmptyText } from "~/ui/components/Empty";
import { RoleChips } from "~/ui/components/glyphs";
import { TxNotice } from "~/ui/components/TxNotice";
import { PublishLocked, QueuedNote } from "~/ui/components/CartDrawer";
import type { Action } from "~/wallet/action";
import { t, n } from "~/i18n";
import css from "./Survey.module.css";

export const Survey: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);
  const indexed = createMemo(() => {
    const snap = app.list.error ? undefined : app.list();
    return snap ? findSurvey(snap.surveys, key()) : undefined;
  });
  // A just-created survey isn't indexed yet — fall back to its optimistic twin.
  const survey = createMemo(
    () => indexed() ?? app.optimisticSurveys().find((a) => a.key === key()),
  );

  // The survey's own slice — raw responses (audit/tally/reveal need them),
  // cancellations, tip — fetched lazily; the list payload deliberately carries
  // none of it. Keyed on the *indexed* record: an optimistic survey isn't
  // fetchable yet (nothing on-chain), and auditing it as "no responses" is
  // exactly right.
  const [bundle, { refetch: refetchBundle }] = createResource(
    () => indexed()?.record.ref,
    (ref) => app.source.surveyBundle(ref),
  );
  // Same swallow-the-promise rule as `reload`: a failed retry is already
  // captured in `bundle.error`.
  const retryBundle = (): void => {
    void Promise.resolve(refetchBundle()).catch(() => {});
  };

  // The final tally artifact — only a closed/cancelled survey can have one,
  // and only the serving tier produces them (the direct Koios source answers
  // null by contract). Any fetch error degrades to the raw view, never blocks
  // the page.
  const [artifactRes] = createResource(
    () => {
      const s = indexed();
      return s && s.status !== "active" ? s.record.ref : undefined;
    },
    (ref) => app.source.artifact(ref),
  );
  // A fetch error is captured in `artifactRes.error` (like `bundle`/`list`) and
  // guarded here, degrading to the raw view rather than blocking the page.
  const artifact = (): TallyArtifact | null =>
    (artifactRes.error ? null : artifactRes()) ?? null;

  // External-content surveys: fetch + hash-verify the off-chain presentation
  // doc and render its labels; `pres.def()` falls back to the on-chain
  // definition (count forms, blank titles) until/unless it resolves.
  const pres = usePresentation(() => survey()?.record.definition);
  const def = (): SurveyDefinition | undefined => pres.def();

  // Audit the raw responses for this survey: `counted` is the valid, deduped
  // set to tally; `excluded` is the breakdown. On the serving tier the bundle
  // carries the backend's decided credential-proof verdicts, so proof failures
  // are excluded too (pre-dedup — an unproven later ballot must not supersede
  // a proven earlier one); a response with no verdict yet stays counted. In
  // direct-Koios mode there are no verdicts and the audit is purely on-chain.
  const verdicts = (): ProofVerdicts | undefined =>
    (bundle.error ? undefined : bundle())?.verdicts;
  const audit = createMemo<ResponseAudit>(() => {
    const s = survey();
    const b = bundle.error ? undefined : bundle();
    if (!s || !b) return { counted: [], excludedRecords: [] };
    return auditResponses(b.responses, s.record.definition, b.verdicts);
  });
  const records = createMemo<ResponseRecord[]>(() => audit().counted);

  // Per-role response counts (plain integers, no cross-role percentages —
  // separate electorates aren't comparable as shares of one whole). Works even
  // while sealed: role + credential are plaintext; only the answers are sealed.
  const roleCounts = createMemo(() =>
    roleBreakdown(records().map((r) => r.response)),
  );

  // The chain tip drives the summary's "ends" countdown; guarded like the list
  // read so an errored snapshot degrades to "—" rather than throwing.
  const tip = createMemo<ChainTip | undefined>(
    () => (app.list.error ? undefined : app.list())?.tip,
  );

  // A coarse clock that ticks while the page is open, so a sealed survey's
  // reveal affordance lights up the moment its drand round publishes — without
  // a reload. 30s granularity is plenty against drand's 3s period.
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(
    () => setNow(Math.floor(Date.now() / 1000)),
    30_000,
  );
  onCleanup(() => clearInterval(clock));

  return (
    <main class={css.page}>
      <A href="/" class={css.back}>
        <span class={css.backArrow}>←</span> {t("survey.backAll")}
      </A>

      <Show
        when={survey()}
        fallback={
          <Empty
            loading={app.list.loading}
            error={app.list.error}
            onRetry={() => app.reload()}
            text={emptyText()}
          />
        }
      >
        {(sv) => (
          <>
            <Header
              s={sv()}
              def={def() ?? sv().record.definition}
              keyStr={key()}
              pro={app.ui.pro}
              roleCounts={roleCounts()}
              total={records().length}
              tip={tip()}
              secondsPerEpoch={app.config.secondsPerEpoch}
              nowUnix={now()}
            />

            <Show when={!indexed() && app.optimisticStuck().has(key())}>
              <NotOnChainNotice />
            </Show>

            <Show when={sv().cancellationClaimed}>
              <ClaimedCancellationNotice />
            </Show>

            <Show when={!sv().talliable}>
              <InvalidDefinitionNotice />
            </Show>

            <Show when={pres.external() && pres.unavailable()}>
              <LabelsUnavailable keyStr={key()} />
            </Show>

            <Show
              when={
                viewStatus(sv()) === "public" || viewStatus(sv()) === "sealed"
              }
            >
              <div class={css.respondCtaRow}>
                <A
                  href={`/survey/${encodeURIComponent(key())}/respond`}
                  class={css.respondCta}
                >
                  {t("survey.respondCta")}{" "}
                  <span class={css.respondCtaArrow}>→</span>
                </A>
                {/* Dev-only: answer the same survey through the embeddable
                    <tessera-respond> widget instead, via the reference-host
                    page. Never present in production (see App.tsx). */}
                {import.meta.env.DEV && (
                  <A
                    href={`/dev/widget/${encodeURIComponent(key())}`}
                    class={css.respondDevCta}
                  >
                    <span class={css.respondDevTag}>DEV</span> Respond via
                    widget
                  </A>
                )}
              </div>
            </Show>

            <Show
              when={
                app.wallet() &&
                sv().status === "active" &&
                walletOwns(app.wallet()!.identity, sv().record.definition.owner)
              }
            >
              {/* Cancelling proves the owner credential with a signature, so a
                  script owner this wallet controls can be matched but never
                  cancelled from here. The linking helper signs nothing. */}
              <Show
                when={walletCanProveOwner(
                  app.wallet()!.identity,
                  sv().record.definition.owner,
                )}
              >
                <OwnerControls s={sv()} />
              </Show>
              {/* Linking signs nothing, so the outer walletOwns gate is
                  enough — a script-owned survey can still be advertised even
                  though it can't be cancelled from here. Once an advertising
                  action is discovered the badge card above announces it and
                  this card would read as an undone to-do, so it goes away. */}
              <Show when={sv().govLinks.length === 0}>
                <LinkSurveyCta
                  keyStr={key()}
                  endEpoch={sv().record.definition.endEpoch}
                />
              </Show>
            </Show>

            {/* Results render from the survey's own bundle; until it lands (or
                if it fails) show the same loading/error affordance as the page
                shell, never a tally that silently reads as "0 responses". */}
            <Show
              when={!bundle.loading && !bundle.error}
              fallback={
                <Empty
                  loading={bundle.loading}
                  error={bundle.error}
                  onRetry={retryBundle}
                  text={emptyText()}
                />
              }
            >
              <Results
                s={sv()}
                def={def() ?? sv().record.definition}
                keyStr={key()}
                artifact={artifact()}
                audit={audit()}
                responses={bundle()?.responses ?? []}
                verdicts={verdicts()}
                nowUnix={now()}
              />
            </Show>
          </>
        )}
      </Show>
    </main>
  );
};

/**
 * Shown when an in-window cancellation referencing this survey exists but
 * couldn't be verified as the owner's (forgery, unsupported owner type, or —
 * for a closed survey in direct-Koios mode — a proof the scan never fetches).
 * An unverified claim never closes a survey, so this is informational: it keeps
 * the attempted suppression visible (finding 6) without acting on it, whether
 * the survey is still open or already ended.
 */
const ClaimedCancellationNotice: Component = () => (
  <div class={css.claimedNotice}>
    <strong>{t("survey.claimedNoticeStrong")}</strong>{" "}
    {t("survey.claimedNoticeRest")}
  </div>
);

/**
 * Shown on an optimistic survey whose defining tx has stayed unconfirmed past
 * the slow threshold: mempool eviction means it may never land (finding 61).
 * The entry is kept — the author needs the receipt to republish — but readers
 * see the doubt instead of a survey presented as fact.
 */
const NotOnChainNotice: Component = () => (
  <div class={css.claimedNotice}>
    <strong>{t("survey.notOnChainNoticeStrong")}</strong>{" "}
    {t("survey.notOnChainNoticeRest")}
  </div>
);

/**
 * Shown when the on-chain definition is spec-invalid (non-v5 or structurally
 * invalid): the survey is untalliable (findings 10/11) — no reproducible tally
 * is produced and responding is blocked, since a conformant reader never counts
 * it.
 */
const InvalidDefinitionNotice: Component = () => (
  <div class={css.claimedNotice}>
    <strong>{t("survey.invalidNoticeStrong")}</strong>{" "}
    {t("survey.invalidNoticeRest")}
  </div>
);

// ----------------------------------------------------------------------------
// Owner controls (cancel)
// ----------------------------------------------------------------------------

/**
 * Shown only to the connected wallet that owns an *active* survey and can prove
 * it. Cancelling publishes a tag-2 cancellation referencing this survey,
 * proving the owner credential via required_signers (CIP-179 mechanism A). The
 * definition stays on-chain; new responses are rejected from then on.
 */
const OwnerControls: Component<{ s: SurveyAggregate }> = (props) => {
  const app = useApp();
  const [confirming, setConfirming] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [hash, setHash] = createSignal<string | null>(null);
  const [queued, setQueued] = createSignal(false);
  // With something already waiting, cancelling would publish that too — so the
  // button queues instead, and the cart is where it all goes out.
  const queueing = (): boolean => app.cart().length > 0;
  // Block cancelling while the wallet is on a different network than the app, so
  // the cancellation isn't broadcast to the wrong chain (a paid no-op that leaves
  // the real survey open). Mirrors the create/respond/propose submit gates.
  const mismatch = (): boolean =>
    networkMismatch(app.wallet()?.identity.networkId, app.config.network);

  const cancellation = (): Action => {
    const def = props.s.record.definition;
    return {
      kind: "cancel",
      cancellation: props.s.record.ref,
      proveCredentials: [def.owner],
      title: def.title || undefined,
    };
  };

  const onCancel = async (queueOnly: boolean) => {
    if (queueOnly) {
      app.enqueue([cancellation()]);
      setQueued(true);
      return;
    }
    setCancelling(true);
    setError(null);
    try {
      const hashes = await app.submitOrQueue([cancellation()]);
      if (hashes) setHash(hashes[0] ?? null);
      else setQueued(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Show
      when={hash() === null && !queued()}
      fallback={
        <Show when={hash()} fallback={<QueuedNote />}>
          {(h) => (
            <TxNotice
              title={t("survey.cancelSubmittedTitle")}
              hash={h()}
              body={t("survey.cancelSubmittedBody")}
            />
          )}
        </Show>
      }
    >
      <div class={css.ownerBar}>
        <span class={css.ownerText}>
          <b class={css.ownerTextStrong}>{t("survey.ownerTextStrong")}</b>{" "}
          {t("survey.ownerText")}
        </span>
        <Show when={!app.cartLocked()} fallback={<PublishLocked />}>
          <Show
            when={confirming()}
            fallback={
              <button
                onClick={() => setConfirming(true)}
                disabled={mismatch()}
                class={css.cancelBtn}
              >
                {t("survey.cancelSurvey")}
              </button>
            }
          >
            <div class={css.confirmRow}>
              <button
                onClick={() => void onCancel(queueing())}
                disabled={cancelling() || (mismatch() && !queueing())}
                class={css.confirmBtn}
              >
                {cancelling()
                  ? t("survey.cancelling")
                  : queueing()
                    ? t("cart.addToCart")
                    : t("survey.confirmCancel")}
              </button>
              <Show when={!queueing()}>
                <button
                  onClick={() => void onCancel(true)}
                  disabled={cancelling()}
                  class={css.keepBtn}
                >
                  {t("cart.addToCart")}
                </button>
              </Show>
              <button
                onClick={() => setConfirming(false)}
                disabled={cancelling()}
                class={css.keepBtn}
              >
                {t("survey.keep")}
              </button>
            </div>
          </Show>
        </Show>
        <Show when={mismatch()}>
          <div class={css.ownerError}>
            {t("survey.switchNetwork", { network: app.config.network })}
          </div>
        </Show>
        <Show when={error()}>
          <div class={css.ownerError}>{error()}</div>
        </Show>
      </div>
    </Show>
  );
};

// ----------------------------------------------------------------------------
// Owner: link this survey to a governance action
// ----------------------------------------------------------------------------

/**
 * Owner-only entry to the link tool (`/survey/:key/link`), shown while the
 * survey has no discovered advertising action. Owner-gating is a Tessera
 * product choice about whom the tool helps — CIP-179 lets anyone propose a
 * linking action, and a link never implies common authorship. CIP-179 v5 allows several
 * links and the tool itself still accepts an already-linked survey, but the
 * card disappears once one exists — the linked-action badge already tells the
 * story. It also closes once the submission window has passed: an action
 * proposed after `end_epoch − gov_action_lifetime` outlives the survey and
 * can never link it.
 */
const LinkSurveyCta: Component<{ keyStr: string; endEpoch: number }> = (
  props,
) => {
  const app = useApp();
  const tip = () => (app.list.error ? undefined : app.list())?.tip;
  const alignment = createMemo(() =>
    computeAlignment({
      hasLink: true,
      tip: tip(),
      surveyEndEpoch: props.endEpoch,
      secondsPerEpoch: app.config.secondsPerEpoch,
    }),
  );
  const passedWindow = () => {
    const w = alignment()?.window;
    const now = tip();
    return w && now && now.epoch > w.submitEpoch ? w : undefined;
  };
  return (
    <div class={css.linkPanel}>
      <h3 class={css.linkTitle}>{t("survey.linkTitle")}</h3>
      <Show
        when={!passedWindow()}
        fallback={
          <p class={css.linkBody}>
            {t("survey.linkWindowClosed", {
              submitEpoch: passedWindow()!.submitEpoch,
            })}
          </p>
        }
      >
        <p class={css.linkBody}>{t("survey.linkHint")}</p>
        <A
          href={`/survey/${encodeURIComponent(props.keyStr)}/link`}
          class={css.linkCta}
        >
          {t("survey.linkCta")} →
        </A>
      </Show>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Header
// ----------------------------------------------------------------------------

const Header: Component<{
  s: SurveyAggregate;
  def: SurveyDefinition;
  keyStr: string;
  pro: boolean;
  roleCounts: ReadonlyArray<{ role: number; count: number }>;
  total: number;
  tip: ChainTip | undefined;
  secondsPerEpoch: number;
  nowUnix: number;
}> = (props) => {
  const ends = (): string =>
    props.tip
      ? endsText(props.s, props.tip, props.secondsPerEpoch, props.nowUnix)
      : "—";
  return (
    <div class={css.header}>
      <Show when={props.pro}>
        <div class={css.headerTop}>
          <span title={t("survey.refTitle")} class={css.headerRefLead}>
            {t("survey.refLead", { ref: fullRef(props.keyStr) })}
          </span>
        </div>
      </Show>
      <h1 class={css.headerTitle}>
        {props.def.title || t("survey.untitledSurvey")}
      </h1>
      <Show when={props.def.description}>
        <p class={css.headerDesc}>{props.def.description}</p>
      </Show>

      <For each={props.s.govLinks}>
        {(link) => (
          <div class={css.govLinkCard}>
            <span class={css.govLinkBadge}>{t("survey.govLinkBadge")}</span>
            <div class={css.govLinkMain}>
              <div class={css.govLinkText}>
                <Show
                  when={link.title}
                  fallback={<>{t("survey.govLinkAdvertisedFallback")}</>}
                >
                  {t("survey.govLinkAdvertisedBy")}{" "}
                  <b class={css.govLinkTextStrong}>{link.title}</b>
                </Show>{" "}
                <span class={css.govLinkActionId}>{link.actionId}</span>
              </div>
              <div class={css.govLinkMeta}>
                {t("survey.govLinkMeta", { epoch: link.endEpoch })}
              </div>
            </div>
          </div>
        )}
      </For>

      <div class={css.summary}>
        <div class={css.summaryMeta}>
          <SummaryItem label={t("survey.summaryQuestions")}>
            <span class={css.summaryValue}>
              {n(props.def.questions.length)}
            </span>
          </SummaryItem>
          <Show when={props.def.eligibleRoles.length > 0}>
            <SummaryItem label={t("survey.summaryEligible")}>
              <RoleChips roles={props.def.eligibleRoles} />
            </SummaryItem>
          </Show>
          <SummaryItem label={t("survey.summaryEnds")}>
            <span class={css.summaryValue}>{ends()}</span>
          </SummaryItem>
          <SummaryItem label={t("survey.summaryResponses")}>
            <span class={css.summaryValue}>{n(props.total)}</span>
          </SummaryItem>
        </div>

        {/* Plain per-role response counts — no percentages, no comparative
            bars: separate electorates aren't slices of one whole. */}
        <Show when={props.roleCounts.length > 0}>
          <div class={css.summaryRoles}>
            <For each={props.roleCounts}>
              {(rc) => {
                const [color, bg] = roleColors(rc.role);
                return (
                  <span class={css.summaryRole}>
                    <span
                      class={css.summaryRoleChip}
                      style={{ "--role-color": color, "--role-bg": bg }}
                    >
                      {roleLabel(rc.role)}
                    </span>
                    <span class={css.summaryRoleCount}>{n(rc.count)}</span>
                  </span>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

/** One labelled metadata pair in the survey summary card. */
const SummaryItem: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <div class={css.summaryItem}>
    <span class={css.summaryLabel}>{props.label}</span>
    {props.children}
  </div>
);

// ----------------------------------------------------------------------------
// Final weighted results (artifact view)
// ----------------------------------------------------------------------------

/**
 * External-content survey whose off-chain presentation document couldn't be
 * fetched or failed its hash check. Labels are missing, but the survey is fully
 * answerable and tallyable from on-chain data (indices + constraints).
 */
const LabelsUnavailable: Component<{ keyStr: string }> = (props) => (
  <div class={css.labelsUnavailable}>
    <span class={css.labelsIcon}>⚠</span>
    <div class={css.labelsMain}>
      <div class={css.labelsTitle}>{t("survey.labelsTitle")}</div>
      <p class={css.labelsBody}>
        {t("survey.labelsBody1")}
        <span class={css.labelsMono}>{shortRef(props.keyStr)}</span>
        {t("survey.labelsBody2")} <b>{t("survey.labelsBodyAccurate")}</b>{" "}
        {t("survey.labelsBody3")} <i>{t("survey.labelsBodyIndices")}</i>
        {t("survey.labelsBody4")}
      </p>
    </div>
  </div>
);

/** Read through a getter at each call site, so it re-reads on a locale switch. */
const emptyText = (): EmptyText => ({
  loading: t("survey.loading"),
  notFound: t("survey.notFound"),
  error: t("survey.loadError"),
  retry: t("survey.retry"),
});
