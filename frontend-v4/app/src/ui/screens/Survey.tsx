import {
  For,
  Show,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import type { AnswerItem, Question, SurveyResponse } from "cip-179";

import { useApp } from "~/state";
import {
  dedupeResponses,
  findSurvey,
  refKey,
  type SurveyAggregate,
} from "~/domain/survey";
import { roleBreakdown, tallySurvey, type QuestionTally } from "~/domain/tally";
import type { ResponseRecord } from "~/data/source";
import { roleColors, roleLabel, shortRef, viewStatus } from "~/ui/format";
import { ResultBarCard } from "~/ui/components/ResultBarCard";
import { toCsv, downloadCsv } from "~/util/csv";

const BASE_TYPE: Record<Question["type"], string> = {
  custom: "Custom",
  singleChoice: "Single choice",
  multiSelect: "Multi-select",
  ranking: "Ranking",
  numericRange: "Numeric range",
  pointsAllocation: "Points",
  rating: "Rating",
};

const STATUS_PILL: Record<
  ReturnType<typeof viewStatus>,
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
  const [roleFilter, setRoleFilter] = createSignal<number | "all">("all");

  const survey = createMemo(() =>
    app.snapshot() ? findSurvey(app.snapshot()!.surveys, key()) : undefined,
  );

  // Deduped response records targeting this survey (latest-valid-wins).
  const records = createMemo<ResponseRecord[]>(() => {
    const snap = app.snapshot();
    if (!snap) return [];
    return dedupeResponses(
      snap.records.responses.filter(
        (r) => refKey(r.response.surveyRef) === key(),
      ),
    );
  });

  const publicResponses = createMemo<SurveyResponse[]>(() =>
    records()
      .map((r) => r.response)
      .filter((r) => r.answers.type === "public"),
  );

  const roleStats = createMemo(() => {
    const rows = roleBreakdown(records().map((r) => r.response));
    const total = Math.max(1, records().length);
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

  const tallies = createMemo<QuestionTally[]>(() => {
    const s = survey();
    return s
      ? tallySurvey(s.record.definition, filtered(), filtered().length)
      : [];
  });

  const exportCsv = () => {
    const s = survey();
    if (!s) return;
    const header = [
      "response_tx",
      "role",
      "credential",
      "question_index",
      "question_type",
      "answer",
    ];
    const body = records().flatMap((rec) => {
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
    downloadCsv(`tessera-${shortRef(key())}.csv`, toCsv([header, ...body]));
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
              keyStr={key()}
              pro={app.ui.pro}
              roleStats={roleStats()}
              total={records().length}
            />

            <Show
              when={viewStatus(s()) !== "sealed"}
              fallback={<SealedNotice />}
            >
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
                <button
                  onClick={exportCsv}
                  disabled={records().length === 0}
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
                    cursor: records().length ? "pointer" : "not-allowed",
                    opacity: records().length ? "1" : ".5",
                  }}
                >
                  <span style={{ "font-size": "14px" }}>⤓</span> Export CSV
                </button>
              </div>

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
                <div
                  style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}
                >
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
                <For each={s().record.definition.questions}>
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
            </Show>
          </>
        )}
      </Show>
    </main>
  );
};

// ----------------------------------------------------------------------------
// Header
// ----------------------------------------------------------------------------

const Header: Component<{
  s: SurveyAggregate;
  keyStr: string;
  pro: boolean;
  roleStats: Array<{ role: number; count: number; pct: number }>;
  total: number;
}> = (props) => {
  const v = () => viewStatus(props.s);
  const pill = () => STATUS_PILL[v()];
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
        {props.s.record.definition.title || "Untitled survey"}
      </h1>
      <Show when={props.s.record.definition.description}>
        <p
          style={{
            "font-size": "14.5px",
            color: "var(--muted)",
            "line-height": "1.55",
            margin: "8px 0 0",
          }}
        >
          {props.s.record.definition.description}
        </p>
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

const SealedNotice: Component = () => (
  <div
    style={{
      background: "#fff",
      border: "1px solid var(--warn-line)",
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
        color: "var(--warn)",
      }}
    >
      Answers are sealed
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
      Responses stay encrypted until the survey's drand round publishes. Reveal
      &amp; tally land in a later milestone.
    </p>
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
