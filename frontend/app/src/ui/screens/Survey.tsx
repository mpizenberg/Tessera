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
  type ContentAnchor,
  type Credential,
  type Question,
  type SurveyDefinition,
  type SurveyRef,
  type SurveyResponse,
} from "cip-179";

import { useApp } from "~/state";
import { findSurvey, refKey, type SurveyAggregate } from "~/domain/survey";
import {
  auditResponses,
  type ExcludedRecord,
  type ExclusionKey,
  type ResponseAudit,
} from "~/domain/audit";
import { walletOwns } from "~/domain/roles";
import { roleBreakdown, tallySurvey, type QuestionTally } from "~/domain/tally";
import type { ResponseRecord } from "~/data/source";
import { usePresentation } from "~/enrichment/usePresentation";
import { IPFS_GATEWAYS } from "~/enrichment/providers";
import { formatRevealDate, isQuicknet, roundIsAvailable } from "~/tlock/drand";
import { roleColors, roleLabel, shortRef, viewStatus } from "~/ui/format";
import { ResultBarCard } from "~/ui/components/ResultBarCard";
import { TxLink } from "~/ui/components/TxLink";
import { toCsv, downloadCsv } from "~/util/csv";
import { bytesToHex } from "~/util/hex";

const BASE_TYPE: Record<Question["type"], string> = {
  custom: "Custom",
  singleChoice: "Single choice",
  multiSelect: "Multi-select",
  ranking: "Ranking",
  numericRange: "Numeric range",
  pointsAllocation: "Points",
  rating: "Rating",
};

type PillKey = ReturnType<typeof viewStatus> | "revealed";

const STATUS_PILL: Record<
  PillKey,
  { label: string; color: string; bg: string; line: string }
> = {
  public: {
    label: "Open",
    color: "var(--ok)",
    bg: "var(--ok-bg)",
    line: "var(--ok-line)",
  },
  sealed: {
    label: "Sealed",
    color: "var(--warn)",
    bg: "var(--warn-bg)",
    line: "var(--warn-line)",
  },
  revealed: {
    label: "Revealed",
    color: "var(--gov)",
    bg: "var(--gov-bg)",
    line: "var(--gov-line)",
  },
  ended: {
    label: "Closed",
    color: "var(--muted)",
    bg: "var(--surface3)",
    line: "var(--line)",
  },
  cancelled: {
    label: "Withdrawn",
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
      s.record.definition.endEpoch,
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
    <main
      style={{
        "max-width": "820px",
        margin: "0 auto",
        padding: "22px 24px 90px",
      }}
    >
      <A
        href="/"
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "7px",
          "font-size": "13.5px",
          "font-weight": "600",
          color: "var(--muted)",
          "text-decoration": "none",
          padding: "6px 0",
        }}
      >
        <span style={{ "font-size": "15px" }}>←</span> All surveys
      </A>

      <Show when={survey()} fallback={<Empty loading={app.snapshot.loading} />}>
        {(s) => (
          <>
            <Header
              s={s()}
              def={def() ?? s().record.definition}
              keyStr={key()}
              pro={app.ui.pro}
              roleStats={roleStats()}
              total={records().length}
              pillKey={pillKey()}
            />

            <Show when={pres.external() && pres.unavailable()}>
              <LabelsUnavailable keyStr={key()} />
            </Show>

            <Show
              when={
                viewStatus(s()) === "public" || viewStatus(s()) === "sealed"
              }
            >
              <A
                href={`/survey/${encodeURIComponent(key())}/respond`}
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "9px",
                  "margin-top": "16px",
                  background: "var(--accent)",
                  color: "#fff",
                  "text-decoration": "none",
                  "border-radius": "var(--r-md)",
                  padding: "12px 20px",
                  "font-size": "14px",
                  "font-weight": "700",
                  "box-shadow": "0 8px 20px -8px var(--accent-shadow)",
                }}
              >
                Respond to this survey{" "}
                <span style={{ "font-size": "15px" }}>→</span>
              </A>
            </Show>

            <Show
              when={
                app.wallet() &&
                s().status === "active" &&
                walletOwns(app.wallet()!.identity, s().record.definition.owner)
              }
            >
              <OwnerControls s={s()} />
              <LinkActionPanel
                surveyRef={s().record.ref}
                endEpoch={s().record.definition.endEpoch}
              />
            </Show>

            <Show
              when={!s().sealed}
              fallback={
                <SealedResults
                  s={s()}
                  def={def() ?? s().record.definition}
                  keyStr={key()}
                  records={records()}
                  excludedRecords={audit().excludedRecords}
                  nowUnix={now()}
                />
              }
            >
              <ResultsBody
                def={def() ?? s().record.definition}
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
        <div
          style={{
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-line)",
            "border-radius": "var(--r-md)",
            padding: "14px 16px",
            "margin-top": "16px",
          }}
        >
          <div
            style={{
              "font-size": "13.5px",
              "font-weight": "700",
              color: "var(--danger)",
            }}
          >
            Cancellation submitted
          </div>
          <div
            style={{
              "font-family": "var(--mono)",
              "font-size": "11.5px",
              color: "#8A3A2E",
              "margin-top": "5px",
              "word-break": "break-all",
            }}
          >
            <TxLink hash={hash()!} color="#8A3A2E" />
          </div>
          <div
            style={{
              "font-size": "12.5px",
              color: "#8A3A2E",
              "line-height": "1.5",
              "margin-top": "6px",
            }}
          >
            New responses are rejected once it's indexed. The definition stays
            on-chain for reference.
          </div>
        </div>
      }
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "12px",
          "flex-wrap": "wrap",
          background: "#FBFAF6",
          border: "1px solid #F0EBD8",
          "border-radius": "var(--r-md)",
          padding: "12px 15px",
          "margin-top": "16px",
        }}
      >
        <span
          style={{
            "font-size": "12.5px",
            color: "#7A6A45",
            "line-height": "1.45",
          }}
        >
          <b style={{ color: "#5B4A22" }}>You own this survey.</b> You can
          withdraw it — existing responses stay on-chain but new ones are
          rejected.
        </span>
        <Show
          when={confirming()}
          fallback={
            <button
              onClick={() => setConfirming(true)}
              style={{
                "font-family": "inherit",
                "font-size": "13px",
                "font-weight": "700",
                cursor: "pointer",
                color: "var(--danger)",
                background: "#fff",
                border: "1px solid var(--danger-line)",
                "border-radius": "var(--r-input)",
                padding: "9px 14px",
                "white-space": "nowrap",
              }}
            >
              Cancel survey
            </button>
          }
        >
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <button
              onClick={() => void onCancel()}
              disabled={cancelling()}
              style={{
                "font-family": "inherit",
                "font-size": "13px",
                "font-weight": "700",
                cursor: cancelling() ? "not-allowed" : "pointer",
                color: "#fff",
                background: "var(--danger)",
                border: "none",
                "border-radius": "var(--r-input)",
                padding: "9px 14px",
                "white-space": "nowrap",
              }}
            >
              {cancelling() ? "Cancelling…" : "Confirm cancel"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={cancelling()}
              style={{
                "font-family": "inherit",
                "font-size": "13px",
                "font-weight": "700",
                cursor: "pointer",
                color: "var(--muted)",
                background: "#fff",
                border: "1px solid var(--line)",
                "border-radius": "var(--r-input)",
                padding: "9px 14px",
              }}
            >
              Keep
            </button>
          </div>
        </Show>
        <Show when={error()}>
          <div
            style={{
              "flex-basis": "100%",
              "font-size": "12px",
              color: "var(--danger)",
              "word-break": "break-word",
            }}
          >
            {error()}
          </div>
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
  const json = () =>
    JSON.stringify(
      {
        specVersion: SPEC_VERSION,
        kind: "cardano-governance-survey-link",
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
    <div
      style={{
        background: "#F0F2F7",
        border: "1px solid var(--gov-line)",
        "border-radius": "var(--r-lg)",
        padding: "16px 18px",
        "margin-top": "10px",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "9px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            "font-size": "11px",
            "font-weight": "700",
            "letter-spacing": ".03em",
            "text-transform": "uppercase",
            color: "var(--faint)",
            background: "var(--surface3)",
            border: "1px solid var(--line)",
            "border-radius": "var(--r-2xs)",
            padding: "4px 8px",
          }}
        >
          Optional
        </span>
        <h3
          style={{
            "font-size": "15px",
            "font-weight": "800",
            "letter-spacing": "-.01em",
            margin: "0",
          }}
        >
          Link this survey to a governance Info Action
        </h3>
      </div>
      <p
        style={{
          "font-size": "13px",
          color: "var(--muted)",
          "line-height": "1.55",
          margin: "10px 0 0",
        }}
      >
        Linkage is <b>Action → Survey</b>: your survey already exists, so the
        Info Action just points at it. Add this JSON to the Info Action's{" "}
        <span style={{ "font-family": "var(--mono)", "font-size": "12px" }}>
          anchor
        </span>{" "}
        metadata. The action's voting end epoch must equal this survey's{" "}
        <span style={{ "font-family": "var(--mono)", "font-size": "12px" }}>
          end_epoch {props.endEpoch}
        </span>
        , or tooling won't attach it.
      </p>
      <div
        style={{
          position: "relative",
          background: "#0B0E14",
          "border-radius": "var(--r-control)",
          padding: "14px 15px",
          "margin-top": "12px",
        }}
      >
        <button
          onClick={() => void copy()}
          style={{
            position: "absolute",
            top: "10px",
            right: "10px",
            "font-family": "inherit",
            "font-size": "11.5px",
            "font-weight": "700",
            color: "#C4CCDA",
            background: "#1C2536",
            border: "1px solid #2A3346",
            "border-radius": "var(--r-xs)",
            padding: "5px 10px",
            cursor: "pointer",
          }}
        >
          {copied() ? "Copied ✓" : "Copy JSON"}
        </button>
        <pre
          style={{
            margin: "0",
            "font-family": "var(--mono)",
            "font-size": "11.5px",
            "line-height": "1.7",
            color: "#9FE7C0",
            "white-space": "pre-wrap",
            "word-break": "break-word",
          }}
        >
          {json()}
        </pre>
      </div>
      <div
        style={{
          "font-family": "var(--mono)",
          "font-size": "11px",
          color: "var(--dim)",
          "margin-top": "11px",
        }}
      >
        only Info Actions may link · linkage is discovery + epoch-alignment,
        never an eligibility gate
      </div>
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
    <div
      style={{
        "border-bottom": "1px solid #E7DFCE",
        padding: "14px 2px 20px",
        "margin-top": "6px",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            "font-size": "12px",
            "font-weight": "700",
            color: pill().color,
            background: pill().bg,
            border: `1px solid ${pill().line}`,
            "border-radius": "var(--r-pill)",
            padding: "5px 11px",
          }}
        >
          {pill().label}
        </span>
        <Show when={props.s.govLink}>
          <span
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "6px",
              "font-size": "12px",
              "font-weight": "700",
              color: "var(--gov)",
              background: "var(--gov-bg)",
              border: "1px solid var(--gov-line)",
              "border-radius": "var(--r-pill)",
              padding: "5px 11px",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                "border-radius": "50%",
                background: "var(--gov)",
              }}
            />
            Linked to governance
          </span>
        </Show>
        <span style={{ "margin-left": "auto" }} />
        <Show when={props.pro}>
          <span
            style={{
              "font-family": "var(--mono)",
              "font-size": "11px",
              color: "var(--pale)",
            }}
          >
            ref {shortRef(props.keyStr)}
          </span>
        </Show>
      </div>
      <h1
        style={{
          "font-size": "26px",
          "font-weight": "700",
          "letter-spacing": "-.018em",
          "line-height": "1.16",
          margin: "14px 0 0",
          color: "var(--ink)",
        }}
      >
        {props.def.title || "Untitled survey"}
      </h1>
      <Show when={props.def.description}>
        <p
          style={{
            "font-size": "14.5px",
            color: "var(--muted)",
            "line-height": "1.55",
            margin: "8px 0 0",
          }}
        >
          {props.def.description}
        </p>
      </Show>

      <Show when={props.s.govLink}>
        {(link) => (
          <div
            style={{
              display: "flex",
              "align-items": "flex-start",
              gap: "12px",
              background: "#F1F5FA",
              border: "1px solid var(--gov-line)",
              "border-radius": "var(--r-md)",
              padding: "13px 15px",
              "margin-top": "16px",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                "align-items": "center",
                gap: "5px",
                "font-family": "var(--mono)",
                "font-size": "10px",
                "font-weight": "700",
                "letter-spacing": ".04em",
                "text-transform": "uppercase",
                color: "var(--gov)",
                background: "var(--gov-bg)",
                border: "1px solid var(--gov-line)",
                "border-radius": "var(--r-2xs)",
                padding: "4px 7px",
                flex: "none",
                "margin-top": "1px",
              }}
            >
              Info Action
            </span>
            <div style={{ flex: "1", "min-width": "0" }}>
              <div
                style={{
                  "font-size": "13.5px",
                  color: "#3A352B",
                  "line-height": "1.45",
                }}
              >
                <Show
                  when={link().title}
                  fallback={<>Advertised by a governance Info Action</>}
                >
                  Advertised by{" "}
                  <b style={{ color: "var(--ink)" }}>{link().title}</b>
                </Show>{" "}
                <span
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "11.5px",
                    color: "var(--gov)",
                    "word-break": "break-all",
                  }}
                >
                  {link().actionId}
                </span>
              </div>
              <div
                style={{
                  "font-family": "var(--mono)",
                  "font-size": "11px",
                  color: "var(--faint)",
                  "margin-top": "5px",
                }}
              >
                survey &amp; vote both close at epoch {link().endEpoch} · open
                to all eligible roles — casting the linked vote is optional
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.roleStats.length > 0}>
        <div
          style={{
            display: "grid",
            "grid-template-columns": "1fr 1fr",
            gap: "14px",
            "margin-top": "18px",
          }}
        >
          <For each={props.roleStats}>
            {(rs) => {
              const [color, bg] = roleColors(rs.role);
              return (
                <div
                  style={{
                    border: "1px solid var(--line2)",
                    "border-radius": "var(--r-md)",
                    padding: "13px 15px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                    }}
                  >
                    <span
                      style={{
                        "font-size": "12px",
                        "font-weight": "700",
                        color,
                        background: bg,
                        "border-radius": "6px",
                        padding: "2.5px 8px",
                      }}
                    >
                      {roleLabel(rs.role)}
                    </span>
                    <span
                      style={{
                        "font-family": "var(--mono)",
                        "font-size": "13px",
                        "font-weight": "600",
                        color: "var(--ink)",
                      }}
                    >
                      {rs.count}{" "}
                      <span
                        style={{ color: "var(--dim)", "font-size": "11px" }}
                      >
                        · {rs.pct}%
                      </span>
                    </span>
                  </div>
                  <div
                    style={{
                      height: "7px",
                      "border-radius": "var(--r-pill)",
                      background: "var(--track)",
                      overflow: "hidden",
                      "margin-top": "9px",
                    }}
                  >
                    <div
                      style={{
                        width: `${rs.pct}%`,
                        height: "100%",
                        background: color,
                        "border-radius": "var(--r-pill)",
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
  const qLabel = () => `Q${props.index + 1}`;
  return (
    <Show when={props.tally}>
      {(t) => {
        const tally = t();
        const base = BASE_TYPE[props.q.type];
        switch (tally.kind) {
          case "bars": {
            const typeLabel =
              tally.unit === "responders"
                ? `${base} · % of responders`
                : tally.unit === "first preferences"
                  ? `${base} · first preferences`
                  : base;
            return (
              <ResultBarCard
                qLabel={qLabel()}
                typeLabel={typeLabel}
                title={props.q.prompt || "(no prompt)"}
                abstainText={`${tally.abstained} abstained`}
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
                typeLabel={`${base} · distribution`}
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
                typeLabel={`${base} · average allocation`}
                title={props.q.prompt || "(no prompt)"}
                abstainText={`${tally.abstained} abstained`}
                bars={tally.rows.map((row) => ({
                  label: row.label,
                  meta: `${row.avg.toFixed(1)} pts`,
                  pct: max > 0 ? row.avg / max : 0,
                }))}
              />
            );
          }
          case "rating":
            return (
              <RatingCard
                qLabel={qLabel()}
                typeLabel={`${base} · ${tally.numeric ? "numeric grid" : "labelled scale"}`}
                prompt={props.q.prompt}
                t={tally}
              />
            );
          case "custom":
            return (
              <CustomCard
                qLabel={qLabel()}
                typeLabel={`${base} · interpreted off-chain`}
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
  <div
    style={{
      background: "#fff",
      border: "1px solid var(--line)",
      "border-radius": "var(--r-card)",
      padding: "22px",
    }}
  >
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
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "12px",
            "font-weight": "600",
            color: "var(--accent)",
            background: "var(--accent-bg)",
            "border-radius": "var(--r-chip)",
            padding: "5px 8px",
          }}
        >
          {props.qLabel}
        </span>
        <div
          style={{
            "font-family": "var(--mono)",
            "font-size": "10px",
            "letter-spacing": ".06em",
            "text-transform": "uppercase",
            color: "var(--dim)",
          }}
        >
          {props.typeLabel}
        </div>
      </div>
      <Show when={props.abstain}>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "var(--faint)",
            background: "var(--surface3)",
            "border-radius": "var(--r-xs)",
            padding: "5px 9px",
            "white-space": "nowrap",
            flex: "none",
          }}
        >
          {props.abstain}
        </span>
      </Show>
    </div>
    <h3
      style={{
        "font-family": "var(--serif)",
        "font-size": "18px",
        "font-weight": "600",
        "line-height": "1.28",
        margin: "11px 0 0",
        color: "var(--ink)",
      }}
    >
      {props.prompt || "(no prompt)"}
    </h3>
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
      abstain={`${props.t.abstained} abstained`}
    >
      <div style={{ display: "flex", gap: "18px", "margin-top": "6px" }}>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "12px",
            color: "var(--muted)",
          }}
        >
          mean{" "}
          <b style={{ color: "var(--accent)" }}>{props.t.mean.toFixed(2)}</b>
        </span>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "12px",
            color: "var(--muted)",
          }}
        >
          median <b style={{ color: "var(--accent)" }}>{props.t.median}</b>
        </span>
      </div>
      <Show when={props.t.bins.length > 0} fallback={<NoData />}>
        <div
          style={{
            display: "flex",
            "align-items": "flex-end",
            gap: "12px",
            height: "130px",
            "margin-top": "14px",
          }}
        >
          <For each={props.t.bins}>
            {(b) => (
              <div
                style={{
                  flex: "1",
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "center",
                  height: "100%",
                  "justify-content": "flex-end",
                  gap: "7px",
                }}
              >
                <span
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "10.5px",
                    color: "var(--dim)",
                  }}
                >
                  {b.count}
                </span>
                <div
                  style={{
                    width: "100%",
                    flex: "1",
                    display: "flex",
                    "align-items": "flex-end",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: `${Math.round((b.count / max()) * 100)}%`,
                      background:
                        "linear-gradient(180deg,var(--accent-2),var(--accent))",
                      "border-radius": "4px 4px 0 0",
                      "min-height": "2px",
                    }}
                  />
                </div>
                <span
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "12px",
                    "font-weight": "600",
                    color: "var(--body)",
                  }}
                >
                  {b.label}
                </span>
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
      abstain={`${props.t.abstained} abstained`}
    >
      <Show when={props.t.levelLabels}>
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            gap: "8px 16px",
            "margin-top": "14px",
          }}
        >
          <For each={props.t.levelLabels!}>
            {(label, i) => (
              <span
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "6px",
                  "font-size": "12px",
                  color: "var(--muted)",
                  "font-weight": "600",
                }}
              >
                <span
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "10px",
                    color: "var(--dim)",
                  }}
                >
                  {i()}
                </span>
                {label}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.t.answered > 0} fallback={<NoData />}>
        <div
          style={{
            "margin-top": "16px",
            display: "flex",
            "flex-direction": "column",
            gap: "14px",
          }}
        >
          <For each={props.t.rows}>
            {(row) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "14px",
                }}
              >
                <span
                  style={{
                    "font-size": "14px",
                    "font-weight": "600",
                    width: "120px",
                    flex: "none",
                  }}
                >
                  {row.label}
                </span>
                <div
                  style={{
                    flex: "1",
                    height: "13px",
                    "border-radius": "var(--r-pill)",
                    background: "var(--track)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pctOf(row.avg, props.t.baseMin, top())}%`,
                      height: "100%",
                      background:
                        "linear-gradient(90deg,var(--accent),var(--accent-2))",
                      "border-radius": "var(--r-pill)",
                    }}
                  />
                </div>
                <span
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "14px",
                    "font-weight": "600",
                    color: "var(--accent)",
                    width: "108px",
                    "text-align": "right",
                  }}
                >
                  {avgLabel(row.avg)}
                </span>
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
    <div
      style={{
        display: "flex",
        "align-items": "baseline",
        gap: "9px",
        "margin-top": "14px",
      }}
    >
      <span
        style={{
          "font-family": "var(--mono)",
          "font-size": "30px",
          "font-weight": "600",
          color: "var(--accent)",
        }}
      >
        {props.t.answered}
      </span>
      <span style={{ "font-size": "13.5px", color: "var(--muted)" }}>
        free-form answers · tallied per the external schema
      </span>
    </div>
    <Show when={props.t.samples.length > 0}>
      <div
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          gap: "8px",
          "margin-top": "14px",
        }}
      >
        <For each={props.t.samples}>
          {(x) => (
            <span
              style={{
                "font-size": "13px",
                color: "var(--body)",
                background: "var(--surface)",
                border: "1px solid var(--line2)",
                "border-radius": "var(--r-chip)",
                padding: "7px 11px",
              }}
            >
              “{x}”
            </span>
          )}
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
    style={{
      display: "inline-flex",
      "align-items": "center",
      gap: "7px",
      "font-family": "inherit",
      "font-size": "12.5px",
      "font-weight": props.on ? "700" : "600",
      cursor: "pointer",
      "border-radius": "8px",
      padding: "6px 12px",
      border: props.on ? "1px solid var(--accent)" : "1px solid #E7E0D0",
      background: props.on ? "var(--accent)" : "#F2ECDE",
      color: props.on ? "#FBF8F1" : "#6B6356",
    }}
  >
    {props.label}
    <span
      style={{
        "font-family": "var(--mono)",
        "font-size": "10.5px",
        color: props.on ? "rgba(251,248,241,.75)" : "#A79C88",
      }}
    >
      {props.count}
    </span>
  </button>
);

const NoData: Component = () => (
  <p style={{ "font-size": "12.5px", color: "var(--dim)", margin: "14px 0 0" }}>
    No responses yet.
  </p>
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
        label: "Submitted after the deadline",
        hint: `recorded past end_epoch ${endEpoch}`,
      };
    case "superseded":
      return {
        label: "Superseded by a later response",
        hint: "same role + credential · latest-wins",
      };
    case "undecryptable":
      return {
        label: "Couldn't be decrypted or decoded",
        hint: "malformed or non-conformant payload",
      };
  }
}

const EXCLUSION_ORDER: readonly ExclusionKey[] = [
  "after-deadline",
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
    <div
      style={{
        "margin-top": "12px",
        border: "1px solid var(--warn-line)",
        "border-radius": "var(--r-md)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          background: "#FBFAF6",
          "border-bottom": "1px solid #F0EBD8",
          padding: "12px 16px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            "font-size": "12.5px",
            "font-weight": "700",
            color: "#7A6A45",
          }}
        >
          Why responses weren't counted
        </span>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "#A89878",
          }}
        >
          on-chain checks only
        </span>
      </div>
      <div style={{ background: "#fff", padding: "4px 16px 14px" }}>
        <For each={props.excluded}>
          {(e) => (
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "14px",
                padding: "11px 0",
                "border-top": "1px solid #F6F2E8",
              }}
            >
              <div style={{ flex: "1", "min-width": "0" }}>
                <div
                  style={{
                    "font-size": "13.5px",
                    "font-weight": "600",
                    color: "var(--body)",
                  }}
                >
                  {e.label}
                </div>
                <div
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "10.5px",
                    color: "#A89878",
                    "margin-top": "2px",
                  }}
                >
                  {e.hint}
                </div>
              </div>
              <div
                style={{
                  width: "120px",
                  flex: "none",
                  height: "8px",
                  "border-radius": "var(--r-pill)",
                  background: "#F4ECE0",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(e.count / max()) * 100}%`,
                    height: "100%",
                    "border-radius": "var(--r-pill)",
                    background: "#E0857B",
                  }}
                />
              </div>
              <span
                style={{
                  "font-family": "var(--mono)",
                  "font-size": "13px",
                  "font-weight": "600",
                  color: "var(--warn)",
                  width: "28px",
                  "text-align": "right",
                  flex: "none",
                }}
              >
                {e.count}
              </span>
            </div>
          )}
        </For>
        <p
          style={{
            "font-size": "11.5px",
            color: "#A89878",
            "line-height": "1.5",
            margin: "11px 0 0",
          }}
        >
          Excluded responses stay on-chain but aren't tallied. Eligibility
          checks that need ledger state — role membership re-verified at the{" "}
          <span style={{ "font-family": "var(--mono)", "font-size": "11px" }}>
            end_epoch {props.endEpoch}
          </span>{" "}
          snapshot, credential proofs — are resolved by an indexer and aren't
          reflected here.
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
    <div style={{ "margin-top": "26px" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={props.records.length === 0}
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "8px",
          "font-family": "inherit",
          "font-size": "12.5px",
          "font-weight": "700",
          color: "var(--body)",
          background: "#fff",
          border: "1px solid var(--line)",
          "border-radius": "var(--r-input)",
          padding: "8px 13px",
          cursor: props.records.length ? "pointer" : "not-allowed",
          opacity: props.records.length ? "1" : ".5",
        }}
      >
        Individual responses
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "var(--dim)",
          }}
        >
          {props.records.length}
        </span>
        <span style={{ "font-size": "9px" }}>{open() ? "▴" : "▾"}</span>
      </button>

      <Show when={open()}>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            "margin-top": "12px",
          }}
        >
          <For each={shown()}>
            {(rec) => <ResponseCard rec={rec} def={props.def} />}
          </For>
        </div>
        <Show when={remaining() > 0}>
          <button
            onClick={() => setLimit((n) => n + RESPONSE_PAGE)}
            style={{
              "margin-top": "12px",
              "font-family": "inherit",
              "font-size": "12.5px",
              "font-weight": "700",
              color: "var(--accent)",
              background: "#fff",
              border: "1px solid var(--accent-line)",
              "border-radius": "var(--r-input)",
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            Show {Math.min(RESPONSE_PAGE, remaining())} more ({remaining()}{" "}
            left)
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
    <div
      style={{
        border: "1px solid var(--line)",
        "border-radius": "var(--r-md)",
        padding: "13px 15px",
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "9px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            "font-size": "11.5px",
            "font-weight": "700",
            color,
            background: bg,
            "border-radius": "6px",
            padding: "2.5px 8px",
            flex: "none",
          }}
        >
          {roleLabel(r().role)}
        </span>
        <span
          title={fullCred(r().credential)}
          style={{
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "var(--faint)",
          }}
        >
          {shortCred(r().credential)}
        </span>
        <span style={{ "margin-left": "auto" }} />
        <Show when={r().rationale}>
          {(anchor) => (
            <a
              href={anchorHttpUrl(anchor())}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the voter's rationale document in a new tab (not hash-verified)"
              style={{
                "font-size": "11.5px",
                "font-weight": "700",
                color: "var(--accent)",
                "text-decoration": "none",
              }}
            >
              rationale ↗
            </a>
          )}
        </Show>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "10.5px",
            "max-width": "150px",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          <TxLink hash={props.rec.txHash} color="var(--dim)" />
        </span>
      </div>

      <Show
        when={publicAnswers()}
        fallback={
          <div
            style={{
              "font-family": "var(--mono)",
              "font-size": "11.5px",
              color: "var(--dim)",
              "margin-top": "10px",
            }}
          >
            (sealed — not yet revealed)
          </div>
        }
      >
        {(answers) => (
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "7px",
              "margin-top": "11px",
            }}
          >
            <For each={answers()}>
              {(a) => {
                const q = props.def.questions[a.questionIndex];
                return (
                  <div style={{ display: "flex", gap: "10px" }}>
                    <span
                      style={{
                        "font-family": "var(--mono)",
                        "font-size": "11px",
                        "font-weight": "600",
                        color: "var(--accent)",
                        flex: "none",
                        "padding-top": "1px",
                      }}
                    >
                      Q{a.questionIndex + 1}
                    </span>
                    <div style={{ "min-width": "0" }}>
                      <div
                        style={{
                          "font-size": "12px",
                          color: "var(--muted)",
                          "line-height": "1.4",
                        }}
                      >
                        {q?.prompt || "(no prompt)"}
                      </div>
                      <div
                        style={{
                          "font-size": "13px",
                          "font-weight": "600",
                          color: "var(--body)",
                          "line-height": "1.45",
                          "margin-top": "1px",
                        }}
                      >
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
        ? `key:${hex(r.credential.keyHash)}`
        : `script:${hex(r.credential.scriptHash)}`;
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
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          "margin-top": "14px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "7px",
            "font-size": "12.5px",
            "font-weight": "700",
            color: "var(--ok)",
            background: "var(--ok-bg)",
            border: "1px solid var(--ok-line)",
            "border-radius": "var(--r-sm)",
            padding: "7px 12px",
          }}
        >
          <span
            style={{
              width: "7px",
              height: "7px",
              "border-radius": "50%",
              background: "var(--ok)",
            }}
          />
          {publicResponses().length} counted
        </span>
        <Show when={excludedTotal() > 0}>
          <button
            onClick={() => setExclOpen((o) => !o)}
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "7px",
              "font-family": "inherit",
              "font-size": "12.5px",
              "font-weight": "700",
              color: "var(--warn)",
              background: "#FFF8EC",
              border: "1px solid var(--warn-line)",
              "border-radius": "var(--r-sm)",
              padding: "7px 12px",
              cursor: "pointer",
            }}
          >
            {excludedTotal()} excluded{" "}
            <span style={{ "font-size": "9px" }}>{exclOpen() ? "▴" : "▾"}</span>
          </button>
        </Show>
        <button
          onClick={exportCsv}
          disabled={props.records.length === 0}
          style={{
            "margin-left": "auto",
            display: "inline-flex",
            "align-items": "center",
            gap: "7px",
            "font-family": "inherit",
            "font-size": "13px",
            "font-weight": "700",
            color: "var(--accent)",
            background: "#fff",
            border: "1px solid var(--accent-line)",
            "border-radius": "var(--r-input)",
            padding: "9px 14px",
            cursor: props.records.length ? "pointer" : "not-allowed",
            opacity: props.records.length ? "1" : ".5",
          }}
        >
          <span style={{ "font-size": "14px" }}>⤓</span> Export CSV
        </button>
      </div>

      <Show when={exclOpen() && excludedTotal() > 0}>
        <ExclusionPanel
          excluded={exclusionSummary()}
          endEpoch={props.def.endEpoch}
        />
      </Show>

      {/* weighting disclaimer */}
      <div
        style={{
          display: "flex",
          "align-items": "flex-start",
          gap: "10px",
          background: "#FBFAF6",
          border: "1px solid #F0EBD8",
          "border-radius": "var(--r-md)",
          padding: "12px 15px",
          "margin-top": "14px",
        }}
      >
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "9.5px",
            "font-weight": "600",
            "letter-spacing": ".06em",
            "text-transform": "uppercase",
            color: "var(--warn)",
            background: "var(--warn-bg)",
            border: "1px solid var(--warn-line)",
            "border-radius": "var(--r-2xs)",
            padding: "4px 7px",
            flex: "none",
            "margin-top": "1px",
          }}
        >
          raw
        </span>
        <span
          style={{
            "font-size": "12.5px",
            color: "#7A6A45",
            "line-height": "1.5",
          }}
        >
          These are raw recorded responses — one per credential.{" "}
          <b>No weighting is applied;</b> stake-, pledge-, or quadratic
          weighting is downstream and out of scope for CIP-179.
        </span>
      </div>

      {/* role filter */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          margin: "22px 0 6px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "10.5px",
            "letter-spacing": ".08em",
            "text-transform": "uppercase",
            color: "var(--dim)",
            "font-weight": "600",
          }}
        >
          Tally by role
        </span>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          <RoleFilterBtn
            label="All"
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
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "14px",
          "margin-top": "8px",
        }}
      >
        <For each={props.def.questions}>
          {(q, i) => (
            <QuestionResult q={q} index={i()} tally={tallies()[i()]} />
          )}
        </For>
      </div>

      <IndividualResponses def={props.def} records={filteredRecords()} />

      <p
        style={{
          "text-align": "center",
          "font-family": "var(--mono)",
          "font-size": "10.5px",
          color: "#B8AE99",
          margin: "22px 0 0",
          "line-height": "1.6",
        }}
      >
        tally derived independently from on-chain data ·{" "}
        {publicResponses().length} responses counted
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

  // The resource source is just the round number (a stable primitive), not a
  // fresh `{ records, round }` object — otherwise the ticking clock behind
  // `revealable()` would hand createResource a new object every 30s and
  // re-decrypt every response on each tick. Records are read in the fetcher.
  const revealRound = (): number | null =>
    revealRequested() && revealable() && supported() && !props.s.cancelled
      ? mode()!.round
      : null;

  const [revealed] = createResource(revealRound, async (round) => {
    const { revealResponses } = await import("~/tlock/seal");
    const records = props.records;
    const results = await revealResponses(
      records.map((r) => r.response),
      round,
    );
    const recs = records.flatMap((r, i) => {
      const pub = results[i];
      return pub ? [{ ...r, response: pub }] : [];
    });
    // The records that failed (null result) — kept for the audit/CSV so an
    // auditor can chase each undecodable ballot on-chain.
    const failedRecords = records.filter((_, i) => results[i] === null);
    return { records: recs, failedRecords };
  });

  // Decrypt/decode failures are responses collected but not counted — fold them
  // into the exclusion records (tagged `undecryptable`) alongside the on-chain
  // categories, from which the count breakdown derives. The failure is only
  // known after reveal, so it's appended here rather than in the pure on-chain
  // audit. Tessera can't always tell a decryption failure from a decode failure
  // (a malformed plaintext that decrypts but doesn't parse), so the label stays
  // neutral about which it was.
  const excludedRecordsWithFailures = (
    failedRecords: readonly ResponseRecord[],
  ): ExcludedRecord[] => [
    ...props.excludedRecords,
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
          title="This survey was cancelled"
          body="The owner withdrew it. Any sealed responses stay on-chain but aren't tallied."
        />
      </Match>
      <Match when={!supported()}>
        <SealedStateNotice
          tone="warn"
          title="Unsupported drand chain"
          body="This sealed survey pins a drand chain Tessera can't decrypt — only quicknet is supported here."
        />
      </Match>
      <Match when={!revealable()}>
        <SealedStateNotice
          tone="warn"
          title="Answers are sealed"
          body={`${props.records.length} encrypted response${props.records.length === 1 ? "" : "s"} collected. They open ${formatRevealDate(mode()!.round)} — no one, not even the owner, can read them until the drand round publishes.`}
        />
      </Match>
      <Match when={revealed.loading}>
        <SealedStateNotice
          tone="muted"
          title="Revealing…"
          body="Fetching the drand beacon and decrypting responses."
        />
      </Match>
      <Match when={revealed.error}>
        <SealedStateNotice
          tone="warn"
          title="Couldn't reveal"
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
          )}
        />
      </Match>
      {/* Reached only when revealable, supported, not cancelled, and the viewer
          hasn't triggered the reveal yet — offer the button. */}
      <Match when={true}>
        <SealedStateNotice
          tone="muted"
          title="Answers can now be revealed"
          body={`The drand round published on ${formatRevealDate(mode()!.round)}. Revealing decrypts all ${props.records.length} sealed response${props.records.length === 1 ? "" : "s"} in your browser and tallies them.`}
          action={{
            label: "Reveal all responses",
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
    style={{
      background: "#fff",
      border: `1px solid ${props.tone === "warn" ? "var(--warn-line)" : "var(--line)"}`,
      "border-radius": "var(--r-card)",
      padding: "26px",
      "margin-top": "16px",
      "text-align": "center",
    }}
  >
    <div
      style={{
        "font-size": "16px",
        "font-weight": "800",
        color: props.tone === "warn" ? "var(--warn)" : "var(--ink)",
      }}
    >
      {props.title}
    </div>
    <p
      style={{
        "font-size": "13.5px",
        color: "var(--muted)",
        "line-height": "1.55",
        margin: "8px auto 0",
        "max-width": "460px",
      }}
    >
      {props.body}
    </p>
    <Show when={props.action}>
      {(action) => (
        <button
          onClick={() => action().onClick()}
          style={{
            "margin-top": "16px",
            "font-family": "inherit",
            "font-size": "13.5px",
            "font-weight": "700",
            cursor: "pointer",
            border: "none",
            "border-radius": "var(--r-control)",
            padding: "10px 18px",
            background: "var(--accent)",
            color: "#fff",
          }}
        >
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
  <div
    style={{
      display: "flex",
      "align-items": "flex-start",
      gap: "12px",
      background: "#FBFAF6",
      border: "1px solid #F0EBD8",
      "border-radius": "var(--r-lg)",
      padding: "15px 17px",
      "margin-top": "14px",
    }}
  >
    <span
      style={{
        width: "26px",
        height: "26px",
        "border-radius": "var(--r-chip)",
        background: "var(--warn-bg)",
        border: "1px solid var(--warn-line)",
        color: "var(--warn)",
        "font-size": "14px",
        "font-weight": "700",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        flex: "none",
      }}
    >
      ⚠
    </span>
    <div style={{ flex: "1", "min-width": "0" }}>
      <div
        style={{ "font-size": "14px", "font-weight": "700", color: "#7A6A45" }}
      >
        Presentation labels unavailable
      </div>
      <p
        style={{
          "font-size": "12.5px",
          color: "#7A6A45",
          "line-height": "1.5",
          margin: "5px 0 0",
        }}
      >
        The off-chain document (
        <span style={{ "font-family": "var(--mono)", "font-size": "11.5px" }}>
          {shortRef(props.keyStr)}
        </span>
        ) couldn't be fetched or failed its hash check, so titles and option
        labels can't be shown. <b>Results are still accurate</b> — every
        question type, count and constraint is on-chain, and answers reference
        option <i>indices</i>, which are tallied normally.
      </p>
    </div>
  </div>
);

const Empty: Component<{ loading: boolean }> = (props) => (
  <div
    style={{
      background: "#fff",
      border: "1px solid var(--line)",
      "border-radius": "var(--r-card)",
      padding: "30px 24px",
      "margin-top": "14px",
      "text-align": "center",
      color: "var(--muted)",
    }}
  >
    {props.loading ? "Loading…" : "Survey not found."}
  </div>
);

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function pctOf(avg: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((avg - min) / (max - min)) * 100));
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function serializeAnswer(a: AnswerItem): string {
  switch (a.type) {
    case "singleChoice":
      return String(a.optionIndex);
    case "multiSelect":
      return a.optionIndices.join("|");
    case "ranking":
      return a.ranking.join(">");
    case "numeric":
      return a.value.toString();
    case "pointsAllocation":
      return a.allocations.map((p) => `${p.optionIndex}:${p.points}`).join("|");
    case "rating":
      return a.ratings.map((r) => `${r.optionIndex}:${r.rating}`).join("|");
    case "custom":
      return typeof a.value === "string" ? a.value : "[custom]";
  }
}

/**
 * Human-readable label for an option index, using the (possibly enriched)
 * definition's labels. Falls back to a 1-based "Option N" when labels aren't
 * present — count-mode questions, or external-content surveys whose
 * presentation document hasn't resolved.
 */
function optionLabelOf(q: Question | undefined, index: number): string {
  if (q && "options" in q && q.options.type === "options") {
    return q.options.labels[index] ?? `Option ${index + 1}`;
  }
  return `Option ${index + 1}`;
}

/** Render a single answer item against its question, using option labels. */
function humanizeAnswer(a: AnswerItem, q: Question | undefined): string {
  switch (a.type) {
    case "singleChoice":
      return optionLabelOf(q, a.optionIndex);
    case "multiSelect":
      return a.optionIndices.length === 0
        ? "(none selected)"
        : a.optionIndices.map((i) => optionLabelOf(q, i)).join(", ");
    case "ranking":
      return a.ranking
        .map((i, n) => `${n + 1}. ${optionLabelOf(q, i)}`)
        .join("  ›  ");
    case "numeric":
      return a.value.toString();
    case "pointsAllocation":
      return a.allocations
        .map((p) => `${optionLabelOf(q, p.optionIndex)}: ${p.points}`)
        .join(",  ");
    case "rating":
      return a.ratings
        .map((r) => `${optionLabelOf(q, r.optionIndex)}: ${r.rating}`)
        .join(",  ");
    case "custom":
      return typeof a.value === "string" ? a.value : "[custom value]";
  }
}

/** Compact one-line form of a responder credential, full value in `title`. */
function shortCred(cred: Credential): string {
  const h = cred.type === "key" ? hex(cred.keyHash) : hex(cred.scriptHash);
  const prefix = cred.type === "key" ? "key" : "script";
  return `${prefix}:${h.slice(0, 12)}…${h.slice(-6)}`;
}

function fullCred(cred: Credential): string {
  return cred.type === "key"
    ? `key:${hex(cred.keyHash)}`
    : `script:${hex(cred.scriptHash)}`;
}

/**
 * Browser-openable URL for a content anchor. `ipfs://` is rewritten to the
 * first public gateway (we don't hash-verify here — this is a "go look at the
 * raw document" link, not a trusted fetch); `https://` is used verbatim.
 */
function anchorHttpUrl(anchor: ContentAnchor): string {
  return anchor.uri.startsWith("ipfs://")
    ? IPFS_GATEWAYS[0] + anchor.uri.slice("ipfs://".length)
    : anchor.uri;
}
