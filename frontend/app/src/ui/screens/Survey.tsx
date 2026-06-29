import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import {
  SPEC_VERSION,
  encodePayload,
  type AnswerItem,
  type Credential,
  type Question,
  type SurveyDefinition,
  type SurveyRef,
  type SurveyResponse,
} from "cip-179";

import { useApp } from "~/state";
import { findSurvey, refKey, type SurveyAggregate } from "~/domain/survey";
import { humanizeAnswer, serializeAnswer } from "~/domain/answer";
import {
  auditResponses,
  responseIsCountable,
  type ExcludedRecord,
  type ExclusionKey,
  type ResponseAudit,
} from "~/domain/audit";
import { walletOwns } from "~/domain/roles";
import { roleBreakdown, tallySurvey, type QuestionTally } from "~/domain/tally";
import type { ResponseRecord } from "~/data/source";
import { usePresentation } from "~/enrichment/usePresentation";
import { formatRevealDate, isQuicknet, roundIsAvailable } from "~/tlock/drand";
import {
  fullRef,
  roleColors,
  roleLabel,
  safeExternalHref,
  shortRef,
  viewStatus,
} from "~/ui/format";
import { ResultBarCard } from "~/ui/components/ResultBarCard";
import { TxLink } from "~/ui/components/TxLink";
import { toCsv, downloadCsv } from "~/util/csv";
import { bytesToHex } from "~/util/hex";
import { t, n } from "~/i18n";
import css from "./Survey.module.css";

const BASE_TYPE_KEY: Record<Question["type"], string> = {
  custom: "typeCustom",
  singleChoice: "typeSingleChoice",
  multiSelect: "typeMultiSelect",
  ranking: "typeRanking",
  numericRange: "typeNumericRange",
  pointsAllocation: "typePointsAllocation",
  rating: "typeRating",
};

/** Localized base type label; resolved at render time so it tracks the locale. */
const baseType = (type: Question["type"]): string =>
  t(`survey.${BASE_TYPE_KEY[type]}` as Parameters<typeof t>[0]);

type PillKey = ReturnType<typeof viewStatus> | "revealed";

/** Pill styling per status; `labelKey` is resolved through `t()` at render. */
const STATUS_PILL: Record<
  PillKey,
  { labelKey: string; color: string; bg: string; line: string }
> = {
  public: {
    labelKey: "pillOpen",
    color: "var(--ok)",
    bg: "var(--ok-bg)",
    line: "var(--ok-line)",
  },
  sealed: {
    labelKey: "pillSealed",
    color: "var(--warn)",
    bg: "var(--warn-bg)",
    line: "var(--warn-line)",
  },
  revealed: {
    labelKey: "pillRevealed",
    color: "var(--gov)",
    bg: "var(--gov-bg)",
    line: "var(--gov-line)",
  },
  ended: {
    labelKey: "pillClosed",
    color: "var(--muted)",
    bg: "var(--surface3)",
    line: "var(--line)",
  },
  cancelled: {
    labelKey: "pillWithdrawn",
    color: "var(--danger)",
    bg: "var(--danger-bg)",
    line: "var(--danger-line)",
  },
};

export const Survey: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);
  const survey = createMemo(() => {
    const snap = app.snapshot();
    const found = snap ? findSurvey(snap.surveys, key()) : undefined;
    // A just-created survey isn't indexed yet — fall back to its optimistic twin.
    return found ?? app.optimisticSurveys().find((a) => a.key === key());
  });

  // External-content surveys: fetch + hash-verify the off-chain presentation
  // doc and render its labels; `pres.def()` falls back to the on-chain
  // definition (count forms, blank titles) until/unless it resolves.
  const pres = usePresentation(() => survey()?.record.definition);
  const def = (): SurveyDefinition | undefined => pres.def();

  // Audit the raw responses for this survey: `counted` is the valid, deduped
  // set to tally; `excluded` is the client-detectable breakdown (after-deadline
  // + superseded). Ledger-state exclusions (role/credential) are indexer-side.
  const audit = createMemo<ResponseAudit>(() => {
    const snap = app.snapshot();
    const s = survey();
    if (!snap || !s) return { counted: [], excludedRecords: [] };
    const raw = snap.records.responses.filter(
      (r) => refKey(r.response.surveyRef) === key(),
    );
    return auditResponses(
      raw,
      s.record.definition,
      snap.tip,
      app.config.secondsPerEpoch,
    );
  });
  const records = createMemo<ResponseRecord[]>(() => audit().counted);

  // Role participation. Works even while sealed — role and credential are
  // plaintext in the envelope; only the answers are encrypted.
  const roleStats = createMemo(() => {
    const rows = roleBreakdown(records().map((r) => r.response));
    const total = Math.max(1, records().length);
    return rows.map((r) => ({
      ...r,
      pct: Math.round((r.count / total) * 100),
    }));
  });

  // A coarse clock that ticks while the page is open, so a sealed survey's
  // reveal affordance lights up the moment its drand round publishes — without
  // a reload. 30s granularity is plenty against drand's 3s period.
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(
    () => setNow(Math.floor(Date.now() / 1000)),
    30_000,
  );
  onCleanup(() => clearInterval(clock));

  // Header pill: a sealed survey flips to "Revealed" once its drand round has
  // published (anyone can decrypt from then on).
  const pillKey = (): PillKey => {
    const s = survey();
    if (!s) return "public";
    if (s.sealed && !s.cancelled) {
      const mode = s.record.definition.submissionMode;
      return mode.type === "sealed" && roundIsAvailable(mode.round, now())
        ? "revealed"
        : "sealed";
    }
    return viewStatus(s);
  };

  return (
    <main class={css.page}>
      <A href="/" class={css.back}>
        <span class={css.backArrow}>←</span> {t("survey.backAll")}
      </A>

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
        {(sv) => (
          <>
            <Header
              s={sv()}
              def={def() ?? sv().record.definition}
              keyStr={key()}
              pro={app.ui.pro}
              roleStats={roleStats()}
              total={records().length}
              pillKey={pillKey()}
            />

            <Show when={sv().cancellationClaimed}>
              <ClaimedCancellationNotice />
            </Show>

            <Show when={pres.external() && pres.unavailable()}>
              <LabelsUnavailable keyStr={key()} />
            </Show>

            <Show
              when={
                viewStatus(sv()) === "public" || viewStatus(sv()) === "sealed"
              }
            >
              <A
                href={`/survey/${encodeURIComponent(key())}/respond`}
                class={css.respondCta}
              >
                {t("survey.respondCta")}{" "}
                <span class={css.respondCtaArrow}>→</span>
              </A>
            </Show>

            <Show
              when={
                app.wallet() &&
                sv().status === "active" &&
                walletOwns(app.wallet()!.identity, sv().record.definition.owner)
              }
            >
              <OwnerControls s={sv()} />
              {/* Once an Info Action already advertises this survey, the
                  copy-paste linking helper is redundant — hide it. */}
              <Show when={!sv().govLink}>
                <LinkActionPanel
                  surveyRef={sv().record.ref}
                  endEpoch={sv().record.definition.endEpoch}
                />
              </Show>
            </Show>

            <Show
              when={!sv().sealed}
              fallback={
                <SealedResults
                  s={sv()}
                  def={def() ?? sv().record.definition}
                  keyStr={key()}
                  records={records()}
                  excludedRecords={audit().excludedRecords}
                  nowUnix={now()}
                />
              }
            >
              <ResultsBody
                def={def() ?? sv().record.definition}
                keyStr={key()}
                records={records()}
                excludedRecords={audit().excludedRecords}
              />
            </Show>
          </>
        )}
      </Show>
    </main>
  );
};

/**
 * Shown when a cancellation referencing this survey exists but couldn't be
 * verified as the owner's (forgery, unsupported owner type, or unfetchable
 * proof). The survey stays open — an unverified claim never closes it — so this
 * is informational, making the attempted suppression visible without acting on it.
 */
const ClaimedCancellationNotice: Component = () => (
  <div class={css.claimedNotice}>
    <strong>{t("survey.claimedNoticeStrong")}</strong>{" "}
    {t("survey.claimedNoticeRest")}
  </div>
);

// ----------------------------------------------------------------------------
// Owner controls (cancel)
// ----------------------------------------------------------------------------

/**
 * Shown only to the connected wallet that owns an *active* survey. Cancelling
 * publishes a tag-2 cancellation referencing this survey, proving the owner
 * credential via required_signers (CIP-179 mechanism A). The definition stays
 * on-chain; new responses are rejected from then on.
 */
const OwnerControls: Component<{ s: SurveyAggregate }> = (props) => {
  const app = useApp();
  const [confirming, setConfirming] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [hash, setHash] = createSignal<string | null>(null);

  const onCancel = async () => {
    const def = props.s.record.definition;
    setCancelling(true);
    setError(null);
    try {
      const payload = encodePayload({
        type: "cancellations",
        cancellations: [props.s.record.ref],
      });
      const h = await app.submitMetadata(payload, [def.owner]);
      setHash(h);
      app.trackTx({ txHash: h, kind: "cancel", surveyKey: props.s.key });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Show
      when={hash() === null}
      fallback={
        <div class={css.cancelSubmitted}>
          <div class={css.cancelSubmittedTitle}>
            {t("survey.cancelSubmittedTitle")}
          </div>
          <div class={css.cancelSubmittedHash}>
            <TxLink hash={hash()!} color="var(--danger-ink)" />
          </div>
          <div class={css.cancelSubmittedBody}>
            {t("survey.cancelSubmittedBody")}
          </div>
        </div>
      }
    >
      <div class={css.ownerBar}>
        <span class={css.ownerText}>
          <b class={css.ownerTextStrong}>{t("survey.ownerTextStrong")}</b>{" "}
          {t("survey.ownerText")}
        </span>
        <Show
          when={confirming()}
          fallback={
            <button onClick={() => setConfirming(true)} class={css.cancelBtn}>
              {t("survey.cancelSurvey")}
            </button>
          }
        >
          <div class={css.confirmRow}>
            <button
              onClick={() => void onCancel()}
              disabled={cancelling()}
              class={css.confirmBtn}
            >
              {cancelling()
                ? t("survey.cancelling")
                : t("survey.confirmCancel")}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={cancelling()}
              class={css.keepBtn}
            >
              {t("survey.keep")}
            </button>
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
// Owner: link this survey to a governance Info Action
// ----------------------------------------------------------------------------

/**
 * Linkage is canonicalized **Action → Survey**: the survey already exists, so an
 * Info Action just advertises it by carrying this JSON in its anchor metadata.
 * Shown to the owner of an active survey; purely a copy-paste helper (no tx).
 * Tooling attaches the link only if the action's voting end epoch equals this
 * survey's `end_epoch`.
 */
const LinkActionPanel: Component<{ surveyRef: SurveyRef; endEpoch: number }> = (
  props,
) => {
  // The `cip179` object to nest inside the action's CIP-108 `body` (so it is
  // part of the canonicalized, author-witnessed body). See CIP-179 for the
  // matching `@context` terms that keep the anchor a valid JSON-LD document.
  const json = () =>
    JSON.stringify(
      {
        specVersion: SPEC_VERSION,
        kind: "survey-link",
        surveyTxId: bytesToHex(props.surveyRef.txId),
        surveyIndex: props.surveyRef.index,
      },
      null,
      2,
    );
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the JSON is on screen to copy manually */
    }
  };
  return (
    <div class={css.linkPanel}>
      <div class={css.linkHead}>
        <span class={css.linkOptional}>{t("survey.linkOptional")}</span>
        <h3 class={css.linkTitle}>{t("survey.linkTitle")}</h3>
      </div>
      <p class={css.linkBody}>
        {t("survey.linkBody1")} <b>{t("survey.linkBodyDirection")}</b>
        {t("survey.linkBody2")} <span class={css.linkMono}>cip179</span>{" "}
        {t("survey.linkBody3")} <span class={css.linkMono}>body</span>{" "}
        {t("survey.linkBody4")} <span class={css.linkMono}>@context</span>{" "}
        {t("survey.linkBody5")}{" "}
        <span class={css.linkMono}>end_epoch {props.endEpoch}</span>
        {t("survey.linkBody6")}
      </p>
      <div class={css.linkCodeBox}>
        <button onClick={() => void copy()} class={css.linkCopy}>
          {copied() ? t("survey.copied") : t("survey.copyJson")}
        </button>
        <pre class={css.linkCode}>{json()}</pre>
      </div>
      <div class={css.linkFootnote}>{t("survey.linkFootnote")}</div>
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
  roleStats: Array<{ role: number; count: number; pct: number }>;
  total: number;
  pillKey: PillKey;
}> = (props) => {
  const pill = () => STATUS_PILL[props.pillKey];
  return (
    <div class={css.header}>
      <div class={css.headerTop}>
        <span
          class={css.pill}
          style={{
            "--pill-color": pill().color,
            "--pill-bg": pill().bg,
            "--pill-line": pill().line,
          }}
        >
          {t(`survey.${pill().labelKey}` as Parameters<typeof t>[0])}
        </span>
        <Show when={props.s.govLink}>
          <span class={css.govPill}>
            <span class={css.govPillDot} />
            {t("survey.govPill")}
          </span>
        </Show>
        <Show when={props.pro}>
          <span title={t("survey.refTitle")} class={css.headerRefLead}>
            {t("survey.refLead", { ref: fullRef(props.keyStr) })}
          </span>
        </Show>
      </div>
      <h1 class={css.headerTitle}>
        {props.def.title || t("survey.untitledSurvey")}
      </h1>
      <Show when={props.def.description}>
        <p class={css.headerDesc}>{props.def.description}</p>
      </Show>

      <Show when={props.s.govLink}>
        {(link) => (
          <div class={css.govLinkCard}>
            <span class={css.govLinkBadge}>{t("survey.govLinkBadge")}</span>
            <div class={css.govLinkMain}>
              <div class={css.govLinkText}>
                <Show
                  when={link().title}
                  fallback={<>{t("survey.govLinkAdvertisedFallback")}</>}
                >
                  {t("survey.govLinkAdvertisedBy")}{" "}
                  <b class={css.govLinkTextStrong}>{link().title}</b>
                </Show>{" "}
                <span class={css.govLinkActionId}>{link().actionId}</span>
              </div>
              <div class={css.govLinkMeta}>
                {t("survey.govLinkMeta", { epoch: link().endEpoch })}
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.roleStats.length > 0}>
        <div class={css.roleGrid}>
          <For each={props.roleStats}>
            {(rs) => {
              const [color, bg] = roleColors(rs.role);
              return (
                <div class={css.roleCard}>
                  <div class={css.roleCardHead}>
                    <span
                      class={css.roleChip}
                      style={{ "--role-color": color, "--role-bg": bg }}
                    >
                      {roleLabel(rs.role)}
                    </span>
                    <span class={css.roleCount}>
                      {n(rs.count)}{" "}
                      <span class={css.roleCountPct}>
                        {t("survey.roleCountPct", { pct: n(rs.pct) })}
                      </span>
                    </span>
                  </div>
                  <div class={css.roleTrack}>
                    <div
                      class={css.roleBar}
                      style={{
                        "--role-pct": `${rs.pct}%`,
                        "--role-color": color,
                      }}
                    />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Per-question result widgets
// ----------------------------------------------------------------------------

const QuestionResult: Component<{
  q: Question;
  index: number;
  tally: QuestionTally | undefined;
}> = (props) => {
  const qLabel = () => t("survey.qLabel", { n: props.index + 1 });
  const join = (suffix: string): string =>
    t("survey.typeLabelJoined", { base: baseType(props.q.type), suffix });
  return (
    <Show when={props.tally}>
      {(tallyOf) => {
        const tally = tallyOf();
        switch (tally.kind) {
          case "bars": {
            const typeLabel =
              tally.unit === "responders"
                ? join(t("survey.typeSuffixResponders"))
                : tally.unit === "first preferences"
                  ? join(t("survey.typeSuffixFirstPreferences"))
                  : baseType(props.q.type);
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={typeLabel}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.abstained", { n: n(tally.abstained) })}
                bars={tally.bars.map((b) => ({
                  label: b.label,
                  meta:
                    tally.unit === "responders" && tally.answered > 0
                      ? `${Math.round((b.count / tally.answered) * 100)}%`
                      : String(b.count),
                  pct: b.pct,
                }))}
              />
            );
          }
          case "histogram":
            return (
              <HistogramCard
                qLabel={qLabel()}
                typeLabel={join(t("survey.typeSuffixDistribution"))}
                prompt={props.q.prompt}
                t={tally}
              />
            );
          case "points": {
            // One bar per option, like multi-select. Bars are normalized to the
            // leading option's average so the longest fills the track; the meta
            // shows the average points allocated (out of the question's budget).
            const max = Math.max(0, ...tally.rows.map((r) => r.avg));
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={join(t("survey.typeSuffixAverageAllocation"))}
                title={props.q.prompt || t("survey.noPrompt")}
                abstainText={t("survey.abstained", { n: n(tally.abstained) })}
                bars={tally.rows.map((row) => ({
                  label: row.label,
                  meta: t("survey.pointsMeta", { avg: row.avg.toFixed(1) }),
                  pct: max > 0 ? row.avg / max : 0,
                }))}
              />
            );
          }
          case "rating":
            return (
              <RatingCard
                qLabel={qLabel()}
                typeLabel={join(
                  tally.numeric
                    ? t("survey.typeSuffixNumericGrid")
                    : t("survey.typeSuffixLabelledScale"),
                )}
                prompt={props.q.prompt}
                t={tally}
              />
            );
          case "custom":
            return (
              <CustomCard
                qLabel={qLabel()}
                typeLabel={join(t("survey.typeSuffixInterpretedOffchain"))}
                prompt={props.q.prompt}
                t={tally}
              />
            );
        }
      }}
    </Show>
  );
};

const CardShell: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  abstain?: string;
  children: JSX.Element;
}> = (props) => (
  <div class={css.card}>
    <div class={css.cardHead}>
      <div class={css.cardHeadLeft}>
        <span class={css.qChip}>{props.qLabel}</span>
        <div class={css.typeLabel}>{props.typeLabel}</div>
      </div>
      <Show when={props.abstain}>
        <span class={css.abstain}>{props.abstain}</span>
      </Show>
    </div>
    <h3 class={css.cardTitle}>{props.prompt || t("survey.noPrompt")}</h3>
    {props.children}
  </div>
);

const HistogramCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "histogram" }>;
}> = (props) => {
  const max = () => Math.max(1, ...props.t.bins.map((b) => b.count));
  return (
    <CardShell
      qLabel={props.qLabel}
      typeLabel={props.typeLabel}
      prompt={props.prompt}
      abstain={t("survey.abstained", { n: n(props.t.abstained) })}
    >
      <div class={css.histStats}>
        <span class={css.histStat}>
          {t("survey.histMean")}{" "}
          <b class={css.histStatValue}>{props.t.mean.toFixed(2)}</b>
        </span>
        <span class={css.histStat}>
          {t("survey.histMedian")}{" "}
          <b class={css.histStatValue}>{n(props.t.median)}</b>
        </span>
      </div>
      <Show when={props.t.bins.length > 0} fallback={<NoData />}>
        <div class={css.histBars}>
          <For each={props.t.bins}>
            {(b) => (
              <div class={css.histCol}>
                <span class={css.histCount}>{n(b.count)}</span>
                <div class={css.histColTrack}>
                  <div
                    class={css.histBar}
                    style={{
                      "--hist-h": `${Math.round((b.count / max()) * 100)}%`,
                    }}
                  />
                </div>
                <span class={css.histLabel}>{b.label}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </CardShell>
  );
};

const RatingCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "rating" }>;
}> = (props) => {
  const top = () => props.t.baseMin + (props.t.levels - 1) * props.t.step;
  const avgLabel = (avg: number): string => {
    if (props.t.numeric) return avg.toFixed(2);
    const labels = props.t.levelLabels;
    if (!labels) return avg.toFixed(2);
    return `${labels[Math.round(avg)] ?? "—"} (${avg.toFixed(2)})`;
  };
  return (
    <CardShell
      qLabel={props.qLabel}
      typeLabel={props.typeLabel}
      prompt={props.prompt}
      abstain={t("survey.abstained", { n: n(props.t.abstained) })}
    >
      <Show when={props.t.levelLabels}>
        <div class={css.ratingLegend}>
          <For each={props.t.levelLabels!}>
            {(label, i) => (
              <span class={css.ratingLegendItem}>
                <span class={css.ratingLegendIndex}>{i()}</span>
                {label}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.t.answered > 0} fallback={<NoData />}>
        <div class={css.ratingRows}>
          <For each={props.t.rows}>
            {(row) => (
              <div class={css.ratingRow}>
                <span class={css.ratingRowLabel}>{row.label}</span>
                <div class={css.ratingTrack}>
                  <div
                    class={css.ratingBar}
                    style={{
                      "--rating-pct": `${pctOf(row.avg, props.t.baseMin, top())}%`,
                    }}
                  />
                </div>
                <span class={css.ratingAvg}>{avgLabel(row.avg)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </CardShell>
  );
};

const CustomCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "custom" }>;
}> = (props) => (
  <CardShell
    qLabel={props.qLabel}
    typeLabel={props.typeLabel}
    prompt={props.prompt}
  >
    <div class={css.customCount}>
      <span class={css.customCountValue}>{n(props.t.answered)}</span>
      <span class={css.customCountLabel}>{t("survey.customCountLabel")}</span>
    </div>
    <Show when={props.t.samples.length > 0}>
      <div class={css.customSamples}>
        <For each={props.t.samples}>
          {(x) => <span class={css.customSample}>“{x}”</span>}
        </For>
      </div>
    </Show>
  </CardShell>
);

// ----------------------------------------------------------------------------
// Small bits
// ----------------------------------------------------------------------------

const RoleFilterBtn: Component<{
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    onClick={() => props.onClick()}
    class={css.roleFilterBtn}
    classList={{ [css.roleFilterBtnOn]: props.on }}
  >
    {props.label}
    <span
      class={css.roleFilterCount}
      classList={{ [css.roleFilterCountOn]: props.on }}
    >
      {n(props.count)}
    </span>
  </button>
);

const NoData: Component = () => (
  <p class={css.noData}>{t("survey.noResponsesYet")}</p>
);

// ----------------------------------------------------------------------------
// Results body (public, or revealed-sealed) + sealed reveal pipeline
// ----------------------------------------------------------------------------

/** One row of the exclusion breakdown: a category with its rendered count. */
interface ExclusionSummary {
  readonly key: ExclusionKey;
  readonly label: string;
  readonly hint: string;
  readonly count: number;
}

// Presentation for each exclusion category, kept in one place (`after-deadline`
// folds in the survey's end_epoch; the rest are static). The domain layer only
// emits the `ExclusionKey` — the English lives here.
function exclusionMeta(
  key: ExclusionKey,
  endEpoch: number,
): { label: string; hint: string } {
  switch (key) {
    case "after-deadline":
      return {
        label: t("survey.exclAfterDeadlineLabel"),
        hint: t("survey.exclAfterDeadlineHint", { epoch: endEpoch }),
      };
    case "invalid":
      return {
        label: t("survey.exclInvalidLabel"),
        hint: t("survey.exclInvalidHint"),
      };
    case "superseded":
      return {
        label: t("survey.exclSupersededLabel"),
        hint: t("survey.exclSupersededHint"),
      };
    case "undecryptable":
      return {
        label: t("survey.exclUndecryptableLabel"),
        hint: t("survey.exclUndecryptableHint"),
      };
  }
}

const EXCLUSION_ORDER: readonly ExclusionKey[] = [
  "after-deadline",
  "invalid",
  "superseded",
  "undecryptable",
];

/**
 * Derive the per-category count summary from the flat excluded records (the
 * single source of truth), in a fixed display order — dropping empty categories.
 */
function summarizeExclusions(
  records: readonly ExcludedRecord[],
  endEpoch: number,
): ExclusionSummary[] {
  return EXCLUSION_ORDER.flatMap((key) => {
    const count = records.filter((r) => r.key === key).length;
    return count > 0 ? [{ key, ...exclusionMeta(key, endEpoch), count }] : [];
  });
}

/**
 * Expandable audit of why responses weren't counted. Only the categories
 * provable from on-chain data alone (after-deadline, superseded) appear here;
 * ledger-state exclusions (role membership re-checked at the snapshot,
 * credential-proof failures) need an indexer and are called out as absent.
 */
const ExclusionPanel: Component<{
  excluded: readonly ExclusionSummary[];
  endEpoch: number;
}> = (props) => {
  const max = (): number => Math.max(1, ...props.excluded.map((e) => e.count));
  return (
    <div class={css.exclPanel}>
      <div class={css.exclHead}>
        <span class={css.exclHeadTitle}>{t("survey.exclHeadTitle")}</span>
        <span class={css.exclHeadNote}>{t("survey.exclHeadNote")}</span>
      </div>
      <div class={css.exclBody}>
        <For each={props.excluded}>
          {(e) => (
            <div class={css.exclRow}>
              <div class={css.exclRowMain}>
                <div class={css.exclRowLabel}>{e.label}</div>
                <div class={css.exclRowHint}>{e.hint}</div>
              </div>
              <div class={css.exclTrack}>
                <div
                  class={css.exclBar}
                  style={{ "--excl-pct": `${(e.count / max()) * 100}%` }}
                />
              </div>
              <span class={css.exclCount}>{n(e.count)}</span>
            </div>
          )}
        </For>
        <p class={css.exclFootnote}>
          {t("survey.exclFootnote1")}{" "}
          <span class={css.exclFootnoteMono}>end_epoch {props.endEpoch}</span>{" "}
          {t("survey.exclFootnote2")}
        </p>
      </div>
    </div>
  );
};

/** How many individual responses to render before the "show all" expansion. */
const RESPONSE_PAGE = 50;

/**
 * Per-response breakdown: one card per counted response, showing the voter
 * (role + credential), each answer rendered against the (enriched) definition's
 * labels, a link to the response transaction, and — when present — a link that
 * opens the voter's rationale document in a new tab.
 *
 * Everything here is already plaintext on-chain (for sealed surveys these are
 * the post-reveal decrypted records), so this exposes nothing the explorer or
 * CSV export doesn't. Starts collapsed and renders incrementally so a survey
 * with many responses doesn't mount hundreds of cards eagerly.
 */
const IndividualResponses: Component<{
  def: SurveyDefinition;
  records: ResponseRecord[];
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [limit, setLimit] = createSignal(RESPONSE_PAGE);
  const shown = createMemo(() =>
    open() ? props.records.slice(0, limit()) : [],
  );
  const remaining = () => props.records.length - shown().length;

  return (
    <div class={css.individual}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={props.records.length === 0}
        class={css.individualToggle}
        classList={{
          [css.individualToggleDisabled]: props.records.length === 0,
        }}
      >
        {t("survey.individualResponses")}
        <span class={css.individualCount}>{n(props.records.length)}</span>
        <span class={css.individualCaret}>{open() ? "▴" : "▾"}</span>
      </button>

      <Show when={open()}>
        <div class={css.individualList}>
          <For each={shown()}>
            {(rec) => <ResponseCard rec={rec} def={props.def} />}
          </For>
        </div>
        <Show when={remaining() > 0}>
          <button
            onClick={() => setLimit((prev) => prev + RESPONSE_PAGE)}
            class={css.showMore}
          >
            {t("survey.showMore", {
              n: n(Math.min(RESPONSE_PAGE, remaining())),
              left: n(remaining()),
            })}
          </button>
        </Show>
      </Show>
    </div>
  );
};

const ResponseCard: Component<{
  rec: ResponseRecord;
  def: SurveyDefinition;
}> = (props) => {
  const r = () => props.rec.response;
  const publicAnswers = (): readonly AnswerItem[] | null => {
    const ans = r().answers;
    return ans.type === "public" ? ans.answers : null;
  };
  const [color, bg] = roleColors(r().role);
  return (
    <div class={css.responseCard}>
      <div class={css.responseHead}>
        <span
          class={css.responseRole}
          style={{ "--role-color": color, "--role-bg": bg }}
        >
          {roleLabel(r().role)}
        </span>
        <span title={fullCred(r().credential)} class={css.responseCred}>
          {shortCred(r().credential)}
        </span>
        <Show when={r().rationale}>
          {(anchor) => (
            // Only render the link when the (attacker-controlled, on-chain)
            // rationale URI resolves to a safe https/ipfs href; a `javascript:`
            // or other scheme yields null and no link at all.
            <Show when={safeExternalHref(anchor().uri)}>
              {(href) => (
                <a
                  href={href()}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("survey.responseRationaleTitle")}
                  class={css.responseRationale}
                >
                  {t("survey.responseRationale")}
                </a>
              )}
            </Show>
          )}
        </Show>
        <span class={css.responseTx}>
          <TxLink hash={props.rec.txHash} color="var(--dim)" />
        </span>
      </div>

      <Show
        when={publicAnswers()}
        fallback={
          <div class={css.responseSealed}>{t("survey.responseSealed")}</div>
        }
      >
        {(answers) => (
          <div class={css.responseAnswers}>
            <For each={answers()}>
              {(a) => {
                const q = props.def.questions[a.questionIndex];
                return (
                  <div class={css.responseAnswer}>
                    <span class={css.responseAnswerQ}>
                      {t("survey.responseAnswerQ", { n: a.questionIndex + 1 })}
                    </span>
                    <div class={css.responseAnswerMain}>
                      <div class={css.responseAnswerPrompt}>
                        {q?.prompt || t("survey.noPrompt")}
                      </div>
                      <div class={css.responseAnswerValue}>
                        {humanizeAnswer(a, q)}
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
};

/**
 * The tally view, shared by public surveys and revealed sealed surveys. Takes
 * already-plaintext response records (for sealed, these are the decrypted
 * ones), owns the role filter and CSV export, and renders the per-question
 * widgets.
 */
const ResultsBody: Component<{
  def: SurveyDefinition;
  keyStr: string;
  records: ResponseRecord[];
  /**
   * Excluded records, tagged with reason — the single source for both the CSV
   * export and the (derived) count breakdown shown in {@link ExclusionPanel}.
   */
  excludedRecords: readonly ExcludedRecord[];
}> = (props) => {
  const app = useApp();
  const [roleFilter, setRoleFilter] = createSignal<number | "all">("all");
  const [exclOpen, setExclOpen] = createSignal(false);
  const excludedTotal = (): number => props.excludedRecords.length;
  const exclusionSummary = (): ExclusionSummary[] =>
    summarizeExclusions(props.excludedRecords, props.def.endEpoch);

  const publicResponses = createMemo<SurveyResponse[]>(() =>
    props.records
      .map((r) => r.response)
      .filter((r) => r.answers.type === "public"),
  );
  const roleStats = createMemo(() => {
    const rows = roleBreakdown(props.records.map((r) => r.response));
    const total = Math.max(1, props.records.length);
    return rows.map((r) => ({
      ...r,
      pct: Math.round((r.count / total) * 100),
    }));
  });
  const filtered = createMemo<SurveyResponse[]>(() => {
    const f = roleFilter();
    return f === "all"
      ? publicResponses()
      : publicResponses().filter((r) => r.role === f);
  });
  // Same role filter, but keeping the full record (tx hash) for the per-response
  // breakdown. Mirrors `filtered`, which drops down to bare responses for tallying.
  const filteredRecords = createMemo<ResponseRecord[]>(() => {
    const f = roleFilter();
    return f === "all"
      ? props.records
      : props.records.filter((r) => r.response.role === f);
  });
  const tallies = createMemo<QuestionTally[]>(() =>
    tallySurvey(props.def, filtered(), filtered().length),
  );

  const exportCsv = () => {
    const header = [
      "disposition",
      "response_tx",
      "role",
      "credential",
      "question_index",
      "question_type",
      "answer",
    ];
    const credOf = (r: SurveyResponse): string =>
      r.credential.type === "key"
        ? `key:${bytesToHex(r.credential.keyHash)}`
        : `script:${bytesToHex(r.credential.scriptHash)}`;
    // Counted responses: one row per answer (or one ciphertext row if a sealed
    // payload reaches here unrevealed).
    const counted = props.records.flatMap((rec) => {
      const r = rec.response;
      const cred = credOf(r);
      if (r.answers.type !== "public") {
        return [
          [
            "counted",
            rec.txHash,
            roleLabel(r.role),
            cred,
            "",
            "sealed",
            "(ciphertext)",
          ],
        ];
      }
      return r.answers.answers.map((a) => [
        "counted",
        rec.txHash,
        roleLabel(r.role),
        cred,
        String(a.questionIndex),
        a.type,
        serializeAnswer(a),
      ]);
    });
    // Excluded responses: envelope only (tx + reason + identity) so an auditor
    // can open each one on-chain; answers are left blank (sealed/malformed ones
    // aren't readable, and we keep the row shape uniform across reasons).
    const excluded = props.excludedRecords.map(({ key, record }) => [
      key,
      record.txHash,
      roleLabel(record.response.role),
      credOf(record.response),
      "",
      "",
      "",
    ]);
    downloadCsv(
      `tessera-${shortRef(props.keyStr)}.csv`,
      toCsv([header, ...counted, ...excluded]),
    );
  };

  return (
    <>
      {/* counted + export */}
      <div class={css.countedRow}>
        <span class={css.countedPill}>
          <span class={css.countedDot} />
          {t("survey.counted", { n: n(publicResponses().length) })}
        </span>
        <Show when={excludedTotal() > 0}>
          <button
            onClick={() => setExclOpen((o) => !o)}
            class={css.excludedToggle}
          >
            {t("survey.excluded", { n: n(excludedTotal()) })}{" "}
            <span class={css.excludedCaret}>{exclOpen() ? "▴" : "▾"}</span>
          </button>
        </Show>
        <button
          onClick={exportCsv}
          disabled={props.records.length === 0}
          class={css.exportBtn}
          classList={{ [css.exportBtnDisabled]: props.records.length === 0 }}
        >
          <span class={css.exportIcon}>⤓</span> {t("survey.exportCsv")}
        </button>
      </div>

      <Show when={app.snapshot()?.records.incomplete}>
        <div class={css.incomplete}>{t("survey.incomplete")}</div>
      </Show>

      <Show when={exclOpen() && excludedTotal() > 0}>
        <ExclusionPanel
          excluded={exclusionSummary()}
          endEpoch={props.def.endEpoch}
        />
      </Show>

      {/* weighting disclaimer */}
      <div class={css.disclaimer}>
        <span class={css.disclaimerBadge}>{t("survey.disclaimerBadge")}</span>
        <span class={css.disclaimerText}>
          {t("survey.disclaimerText1")}{" "}
          <b>{t("survey.disclaimerNoWeighting")}</b>{" "}
          {t("survey.disclaimerText2")}
        </span>
      </div>

      {/* role filter */}
      <div class={css.roleFilterRow}>
        <span class={css.roleFilterLabel}>{t("survey.roleFilterLabel")}</span>
        <div class={css.roleFilterBtns}>
          <RoleFilterBtn
            label={t("survey.roleFilterAll")}
            count={publicResponses().length}
            on={roleFilter() === "all"}
            onClick={() => setRoleFilter("all")}
          />
          <For each={roleStats()}>
            {(rs) => (
              <RoleFilterBtn
                label={roleLabel(rs.role)}
                count={rs.count}
                on={roleFilter() === rs.role}
                onClick={() => setRoleFilter(rs.role)}
              />
            )}
          </For>
        </div>
      </div>

      {/* per-question results */}
      <div class={css.questionResults}>
        <For each={props.def.questions}>
          {(q, i) => (
            <QuestionResult q={q} index={i()} tally={tallies()[i()]} />
          )}
        </For>
      </div>

      <IndividualResponses def={props.def} records={filteredRecords()} />

      <p class={css.tallyFootnote}>
        {t("survey.tallyFootnote", { n: n(publicResponses().length) })}
      </p>
    </>
  );
};

/**
 * Sealed-survey results. While the drand round is in the future, responses are
 * collected but unreadable. Once it publishes, a viewer can trigger the reveal —
 * fetch the beacon, decrypt every sealed response (each to a synthetic public
 * one), then hand off to {@link ResultsBody}. Reveal is explicit (a button), not
 * automatic, so opening the page never silently kicks off network + crypto work.
 */
const SealedResults: Component<{
  s: SurveyAggregate;
  def: SurveyDefinition;
  keyStr: string;
  records: ResponseRecord[];
  excludedRecords: readonly ExcludedRecord[];
  nowUnix: number;
}> = (props) => {
  const mode = () => {
    const m = props.s.record.definition.submissionMode;
    return m.type === "sealed" ? m : null;
  };
  const supported = () => {
    const m = mode();
    return m ? isQuicknet(m.chainHash) : false;
  };
  const revealable = () => {
    const m = mode();
    return !!m && roundIsAvailable(m.round, props.nowUnix);
  };

  // Reveal is opt-in: nothing decrypts until the viewer asks for it.
  const [revealRequested, setRevealRequested] = createSignal(false);

  // The resource source is a fingerprint string, not the bare round number or a
  // fresh `{ records, round }` object: keying on the round alone would freeze the
  // decrypted set to whatever was loaded the instant the round became available
  // (later responses in a new snapshot would never re-tally), while a fresh
  // object would re-decrypt every 30s as the clock behind `revealable()` ticks.
  // The fingerprint = round + the sorted response tx hashes, so it changes on a
  // genuine membership change but stays stable across ticks and object identity.
  const revealKey = (): string | null => {
    if (
      !(revealRequested() && revealable() && supported() && !props.s.cancelled)
    )
      return null;
    const hashes = props.records.map((r) => r.txHash).sort();
    return `${mode()!.round}:${hashes.join(",")}`;
  };

  const [revealed] = createResource(revealKey, async () => {
    const { revealResponses } = await import("~/tlock/seal");
    // Validate revealed answers against the *on-chain* definition (constraints
    // and indices are on-chain; enrichment only relabels), not the display one.
    const onChainDef = props.s.record.definition;
    const records = props.records;
    const results = await revealResponses(
      records.map((r) => r.response),
      mode()!.round,
    );
    const recs: ResponseRecord[] = [];
    // Decrypt/decode failures (null result) vs. responses that decrypt+decode
    // cleanly but break the survey's constraints — kept apart so the audit can
    // name each correctly, and so a malformed sealed ballot can't inflate a tally.
    const failedRecords: ResponseRecord[] = [];
    const invalidRecords: ResponseRecord[] = [];
    records.forEach((r, i) => {
      const pub = results[i];
      if (pub === null) {
        failedRecords.push(r);
      } else if (!responseIsCountable(onChainDef, pub)) {
        // Keep the *decoded* response so the CSV/audit shows what it claimed.
        invalidRecords.push({ ...r, response: pub });
      } else {
        recs.push({ ...r, response: pub });
      }
    });
    return { records: recs, failedRecords, invalidRecords };
  });

  // Post-reveal exclusions, folded into the on-chain categories from which the
  // count breakdown derives. `undecryptable` = a response that didn't decrypt or
  // didn't decode (Tessera can't always tell which, so the label stays neutral);
  // `invalid` = one that decoded but violated the survey's constraints. Both are
  // only knowable after reveal, so they're appended here, not in the pure audit.
  const excludedRecordsWithFailures = (
    failedRecords: readonly ResponseRecord[],
    invalidRecords: readonly ResponseRecord[],
  ): ExcludedRecord[] => [
    ...props.excludedRecords,
    ...invalidRecords.map((record) => ({ key: "invalid" as const, record })),
    ...failedRecords.map((record) => ({
      key: "undecryptable" as const,
      record,
    })),
  ];

  return (
    <Switch>
      <Match when={props.s.cancelled}>
        <SealedStateNotice
          tone="muted"
          title={t("survey.sealedCancelledTitle")}
          body={t("survey.sealedCancelledBody")}
        />
      </Match>
      <Match when={!supported()}>
        <SealedStateNotice
          tone="warn"
          title={t("survey.sealedUnsupportedTitle")}
          body={t("survey.sealedUnsupportedBody")}
        />
      </Match>
      <Match when={!revealable()}>
        <SealedStateNotice
          tone="warn"
          title={t("survey.sealedTitle")}
          body={t("survey.sealedBody", {
            n: n(props.records.length),
            responses:
              props.records.length === 1
                ? t("survey.responseSingular")
                : t("survey.responsePlural"),
            date: formatRevealDate(mode()!.round),
          })}
        />
      </Match>
      <Match when={revealed.loading}>
        <SealedStateNotice
          tone="muted"
          title={t("survey.revealingTitle")}
          body={t("survey.revealingBody")}
        />
      </Match>
      <Match when={revealed.error}>
        <SealedStateNotice
          tone="warn"
          title={t("survey.revealErrorTitle")}
          body={
            revealed.error instanceof Error
              ? revealed.error.message
              : String(revealed.error)
          }
        />
      </Match>
      <Match when={revealed()}>
        <ResultsBody
          def={props.def}
          keyStr={props.keyStr}
          records={revealed()!.records}
          excludedRecords={excludedRecordsWithFailures(
            revealed()!.failedRecords,
            revealed()!.invalidRecords,
          )}
        />
      </Match>
      {/* Reached only when revealable, supported, not cancelled, and the viewer
          hasn't triggered the reveal yet — offer the button. */}
      <Match when={true}>
        <SealedStateNotice
          tone="muted"
          title={t("survey.sealedRevealableTitle")}
          body={t("survey.sealedRevealableBody", {
            date: formatRevealDate(mode()!.round),
            n: n(props.records.length),
            responses:
              props.records.length === 1
                ? t("survey.responseSingular")
                : t("survey.responsePlural"),
          })}
          action={{
            label: t("survey.revealAll"),
            onClick: () => setRevealRequested(true),
          }}
        />
      </Match>
    </Switch>
  );
};

const SealedStateNotice: Component<{
  tone: "warn" | "muted";
  title: string;
  body: string;
  /** Optional call-to-action rendered as a button under the body. */
  action?: { label: string; onClick: () => void };
}> = (props) => (
  <div
    class={css.sealedNotice}
    classList={{ [css.sealedNoticeWarn]: props.tone === "warn" }}
  >
    <div
      class={css.sealedNoticeTitle}
      classList={{ [css.sealedNoticeTitleWarn]: props.tone === "warn" }}
    >
      {props.title}
    </div>
    <p class={css.sealedNoticeBody}>{props.body}</p>
    <Show when={props.action}>
      {(action) => (
        <button onClick={() => action().onClick()} class={css.sealedNoticeBtn}>
          {action().label}
        </button>
      )}
    </Show>
  </div>
);

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

const Empty: Component<{
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
}> = (props) => (
  <div class={css.empty}>
    <Show
      when={props.error}
      fallback={props.loading ? t("survey.loading") : t("survey.notFound")}
    >
      <div class={css.emptyError}>{t("survey.loadError")}</div>
      <button
        type="button"
        onClick={() => props.onRetry?.()}
        class={css.retryBtn}
      >
        {t("survey.retry")}
      </button>
    </Show>
  </div>
);

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function pctOf(avg: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((avg - min) / (max - min)) * 100));
}

/** Compact one-line form of a responder credential, full value in `title`. */
function shortCred(cred: Credential): string {
  const h =
    cred.type === "key"
      ? bytesToHex(cred.keyHash)
      : bytesToHex(cred.scriptHash);
  const prefix = cred.type === "key" ? "key" : "script";
  return `${prefix}:${h.slice(0, 12)}…${h.slice(-6)}`;
}

function fullCred(cred: Credential): string {
  return cred.type === "key"
    ? `key:${bytesToHex(cred.keyHash)}`
    : `script:${bytesToHex(cred.scriptHash)}`;
}
