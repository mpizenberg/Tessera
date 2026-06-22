import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import {
  SPEC_VERSION,
  encodePayload,
  type AnswerItem,
  type Question,
  type SurveyDefinition,
  type SurveyRef,
  type SurveyResponse,
} from "cip-179";

import { useApp } from "~/state";
import { findSurvey, refKey, type SurveyAggregate } from "~/domain/survey";
import {
  auditResponses,
  type ExclusionReason,
  type ResponseAudit,
} from "~/domain/audit";
import { walletOwns } from "~/domain/roles";
import { roleBreakdown, tallySurvey, type QuestionTally } from "~/domain/tally";
import type { ResponseRecord } from "~/data/source";
import { usePresentation } from "~/enrichment/usePresentation";
import { formatRevealDate, isQuicknet, roundIsAvailable } from "~/tlock/drand";
import { roleColors, roleLabel, shortRef, viewStatus } from "~/ui/format";
import { ResultBarCard } from "~/ui/components/ResultBarCard";
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
  const survey = createMemo(() =>
    app.snapshot() ? findSurvey(app.snapshot()!.surveys, key()) : undefined,
  );

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
    if (!snap || !s) return { counted: [], excluded: [], excludedTotal: 0 };
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

  const nowUnix = Math.floor(Date.now() / 1000);

  // Header pill: a sealed survey flips to "Revealed" once its drand round has
  // published (anyone can decrypt from then on).
  const pillKey = (): PillKey => {
    const s = survey();
    if (!s) return "public";
    if (s.sealed && !s.cancelled) {
      const mode = s.record.definition.submissionMode;
      return mode.type === "sealed" && roundIsAvailable(mode.round, nowUnix)
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
                  excluded={audit().excluded}
                  nowUnix={nowUnix}
                />
              }
            >
              <ResultsBody
                def={def() ?? s().record.definition}
                keyStr={key()}
                records={records()}
                excluded={audit().excluded}
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
      app.reload();
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
            tx {hash()}
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
          case "points":
            return (
              <PointsCard
                qLabel={qLabel()}
                typeLabel={`${base} · average allocation`}
                prompt={props.q.prompt}
                t={tally}
              />
            );
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

const PointsCard: Component<{
  qLabel: string;
  typeLabel: string;
  prompt: string;
  t: Extract<QuestionTally, { kind: "points" }>;
}> = (props) => {
  const palette = [
    "var(--accent)",
    "#2E6B5E",
    "#6B4FA0",
    "#9A6B1E",
    "#4F7A3A",
    "#2B4C7E",
  ];
  const color = (i: number) => palette[i % palette.length];
  return (
    <CardShell
      qLabel={props.qLabel}
      typeLabel={props.typeLabel}
      prompt={props.prompt}
      abstain={`${props.t.abstained} abstained`}
    >
      <Show when={props.t.answered > 0} fallback={<NoData />}>
        <div
          style={{
            display: "flex",
            height: "34px",
            "border-radius": "var(--r-sm)",
            overflow: "hidden",
            "margin-top": "16px",
          }}
        >
          <For each={props.t.rows}>
            {(row, i) => (
              <div
                style={{
                  width: `${(row.avg / props.t.budget) * 100}%`,
                  background: color(i()),
                  "min-width": row.avg > 0 ? "2px" : "0",
                }}
              />
            )}
          </For>
        </div>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "11px",
            "margin-top": "14px",
          }}
        >
          <For each={props.t.rows}>
            {(row, i) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "10px",
                }}
              >
                <span
                  style={{
                    width: "11px",
                    height: "11px",
                    "border-radius": "3px",
                    background: color(i()),
                    flex: "none",
                  }}
                />
                <span
                  style={{
                    "font-size": "13.5px",
                    "font-weight": "600",
                    color: "var(--body)",
                    flex: "1",
                  }}
                >
                  {row.label}
                </span>
                <span
                  style={{
                    "font-family": "var(--mono)",
                    "font-size": "13px",
                    "font-weight": "600",
                    color: "var(--accent)",
                    "white-space": "nowrap",
                  }}
                >
                  {row.avg.toFixed(1)} pts
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
  const top = () => props.t.baseMin + props.t.levels - 1;
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

/**
 * Expandable audit of why responses weren't counted. Only the categories
 * provable from on-chain data alone (after-deadline, superseded) appear here;
 * ledger-state exclusions (role membership re-checked at the snapshot,
 * credential-proof failures) need an indexer and are called out as absent.
 */
const ExclusionPanel: Component<{
  excluded: readonly ExclusionReason[];
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
  /** Client-detectable exclusions, for the audit breakdown. */
  excluded: readonly ExclusionReason[];
  /** Optional line under the counter (e.g. reveal provenance). */
  note?: string;
}> = (props) => {
  const [roleFilter, setRoleFilter] = createSignal<number | "all">("all");
  const [exclOpen, setExclOpen] = createSignal(false);
  const excludedTotal = (): number =>
    props.excluded.reduce((a, e) => a + e.count, 0);

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
  const tallies = createMemo<QuestionTally[]>(() =>
    tallySurvey(props.def, filtered(), filtered().length),
  );

  const exportCsv = () => {
    const header = [
      "response_tx",
      "role",
      "credential",
      "question_index",
      "question_type",
      "answer",
    ];
    const body = props.records.flatMap((rec) => {
      const r = rec.response;
      const cred =
        r.credential.type === "key"
          ? `key:${hex(r.credential.keyHash)}`
          : `script:${hex(r.credential.scriptHash)}`;
      if (r.answers.type !== "public") {
        return [
          [rec.txHash, roleLabel(r.role), cred, "", "sealed", "(ciphertext)"],
        ];
      }
      return r.answers.answers.map((a) => [
        rec.txHash,
        roleLabel(r.role),
        cred,
        String(a.questionIndex),
        a.type,
        serializeAnswer(a),
      ]);
    });
    downloadCsv(
      `tessera-${shortRef(props.keyStr)}.csv`,
      toCsv([header, ...body]),
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
          excluded={props.excluded}
          endEpoch={props.def.endEpoch}
        />
      </Show>

      <Show when={props.note}>
        <div
          style={{
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "var(--gov)",
            "margin-top": "10px",
          }}
        >
          {props.note}
        </div>
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
 * collected but unreadable. Once it publishes, fetch the beacon and decrypt
 * every sealed response (each to a synthetic public one), then hand off to
 * {@link ResultsBody}. Reveal runs automatically on view.
 */
const SealedResults: Component<{
  s: SurveyAggregate;
  def: SurveyDefinition;
  keyStr: string;
  records: ResponseRecord[];
  excluded: readonly ExclusionReason[];
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

  const [revealed] = createResource(
    () =>
      revealable() && supported() && !props.s.cancelled
        ? { records: props.records, round: mode()!.round }
        : null,
    async (src) => {
      const { revealResponses } = await import("~/tlock/seal");
      const { results, failed } = await revealResponses(
        src.records.map((r) => r.response),
        src.round,
      );
      const recs = src.records.flatMap((r, i) => {
        const pub = results[i];
        return pub ? [{ ...r, response: pub }] : [];
      });
      return { records: recs, failed };
    },
  );

  const revealNote = (count: number, failed: number) =>
    failed > 0
      ? `revealed from ${count} sealed response${count === 1 ? "" : "s"} · ${failed} failed to decrypt`
      : `revealed from ${count} sealed response${count === 1 ? "" : "s"}`;

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
          excluded={props.excluded}
          note={revealNote(revealed()!.records.length, revealed()!.failed)}
        />
      </Match>
    </Switch>
  );
};

const SealedStateNotice: Component<{
  tone: "warn" | "muted";
  title: string;
  body: string;
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
