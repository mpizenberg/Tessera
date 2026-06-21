import { For, Show, createMemo, type Component, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";

import { useApp, type ExploreFilter } from "~/state";
import type { SurveyAggregate } from "~/domain/survey";
import { isClosed, viewStatus, type ViewStatus } from "~/ui/format";
import { FormMosaic, RoleChips, VisGlyph } from "~/ui/components/glyphs";

const COLS = "54px 30px minmax(210px,1fr) 132px 150px 84px";

const FILTERS: ReadonlyArray<{ value: ExploreFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "linked", label: "Governance" },
  { value: "active", label: "Active" },
  { value: "sealed", label: "Sealed" },
  { value: "public", label: "Public" },
  { value: "mine", label: "Mine" },
];

function matchesFilter(a: SurveyAggregate, f: ExploreFilter): boolean {
  const v = viewStatus(a);
  switch (f) {
    case "all":
      return true;
    case "linked":
      return false; // governance linkage needs gov data — wired later
    case "active":
      return !isClosed(v);
    case "sealed":
      return v === "sealed";
    case "public":
      return v === "public";
    case "mine":
      return false; // needs a connected wallet — wired later
  }
}

export const Explore: Component = () => {
  const app = useApp();

  const all = createMemo(() => app.snapshot()?.surveys ?? []);
  const tipEpoch = createMemo(() => app.snapshot()?.tip.epoch ?? 0);

  const counts = createMemo(() => {
    const xs = all();
    const by = (f: ExploreFilter) =>
      xs.filter((a) => matchesFilter(a, f)).length;
    return {
      all: xs.length,
      linked: by("linked"),
      active: by("active"),
      sealed: by("sealed"),
      public: by("public"),
      mine: by("mine"),
    } satisfies Record<ExploreFilter, number>;
  });

  const visible = createMemo(() => {
    const q = app.ui.search.trim().toLowerCase();
    return all()
      .filter((a) => matchesFilter(a, app.ui.filter))
      .filter(
        (a) =>
          q === "" ||
          a.record.definition.title.toLowerCase().includes(q) ||
          a.record.definition.description.toLowerCase().includes(q),
      );
  });

  const openRows = createMemo(() =>
    visible().filter((a) => !isClosed(viewStatus(a))),
  );
  const closedRows = createMemo(() =>
    visible().filter((a) => isClosed(viewStatus(a))),
  );

  return (
    <main
      style={{
        "max-width": "1100px",
        margin: "0 auto",
        padding: "30px 24px 76px",
      }}
    >
      {/* title row + summary */}
      <div
        style={{
          display: "flex",
          "align-items": "flex-end",
          "justify-content": "space-between",
          gap: "16px",
          "border-bottom": "1px solid #E7DFCE",
          "padding-bottom": "14px",
          "flex-wrap": "wrap",
        }}
      >
        <h1
          style={{
            "font-size": "31px",
            "font-weight": "700",
            "letter-spacing": "-.014em",
            margin: "0",
            color: "var(--ink)",
          }}
        >
          Surveys &amp; polls
        </h1>
        <div style={{ display: "flex", "align-items": "center", gap: "16px" }}>
          <span
            style={{
              "font-family": "var(--mono)",
              "font-size": "11.5px",
              color: "var(--dim)",
              "white-space": "nowrap",
            }}
          >
            {all().length} entries · current epoch {tipEpoch()}
          </span>
          <A
            href="/create"
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "7px",
              "white-space": "nowrap",
              background: "var(--accent)",
              color: "#fff",
              "text-decoration": "none",
              "border-radius": "var(--r-control)",
              padding: "9px 14px",
              "font-size": "13px",
              "font-weight": "700",
              "box-shadow": "0 6px 16px -9px var(--accent-shadow)",
            }}
          >
            <span
              style={{
                "font-size": "15px",
                "line-height": "0",
                "margin-top": "-1px",
              }}
            >
              +
            </span>{" "}
            New survey
          </A>
        </div>
      </div>

      {/* filters + search */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          "margin-top": "20px",
          "flex-wrap": "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "7px", "flex-wrap": "wrap" }}>
          <For each={FILTERS}>
            {(f) => (
              <button
                onClick={() => app.setFilter(f.value)}
                style={filterStyle(app.ui.filter === f.value)}
              >
                {f.label}{" "}
                <span style={filterCountStyle(app.ui.filter === f.value)}>
                  {counts()[f.value]}
                </span>
              </button>
            )}
          </For>
        </div>
        <div
          style={{
            "margin-left": "auto",
            display: "flex",
            "align-items": "center",
            gap: "8px",
            background: "var(--surface2)",
            border: "1px solid var(--line)",
            "border-radius": "var(--r-input)",
            padding: "8px 12px",
            "min-width": "190px",
          }}
        >
          <span
            style={{
              width: "13px",
              height: "13px",
              border: "1.5px solid #BFB39A",
              "border-radius": "50%",
              flex: "none",
            }}
          />
          <input
            value={app.ui.search}
            onInput={(e) => app.setSearch(e.currentTarget.value)}
            placeholder="Search surveys…"
            style={{
              border: "none",
              outline: "none",
              "font-family": "inherit",
              "font-size": "13px",
              flex: "1",
              background: "transparent",
              color: "var(--ink)",
            }}
          />
        </div>
      </div>

      {/* register table */}
      <div style={{ "margin-top": "8px" }}>
        <div style={{ "overflow-x": "auto" }}>
          <div style={{ "min-width": "840px" }}>
            <HeaderRow />

            <Show when={app.snapshot.loading}>
              <Notice text="Loading surveys from Koios…" />
            </Show>
            <Show when={app.snapshot.error as unknown}>
              {(err) => (
                <Notice
                  tone="danger"
                  text={`Failed to load: ${String(err())}`}
                />
              )}
            </Show>

            <Show when={!app.snapshot.loading && !app.snapshot.error}>
              <Show when={openRows().length > 0}>
                <SectionLabel
                  dot={
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        "border-radius": "50%",
                        background: "#7E8B6A",
                      }}
                    />
                  }
                  color="#5E7B49"
                  label="Open · accepting responses"
                />
                <For each={openRows()}>
                  {(a) => <Row a={a} tipEpoch={tipEpoch()} pro={app.ui.pro} />}
                </For>
              </Show>

              <Show when={closedRows().length > 0}>
                <SectionLabel
                  dot={
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        "border-radius": "50%",
                        border: "1.5px solid #BBB1A0",
                        "box-sizing": "border-box",
                      }}
                    />
                  }
                  color="#A79C88"
                  label="Closed"
                  note="Ended or withdrawn — read-only."
                  topBorder
                />
                <div style={{ opacity: "0.56" }}>
                  <For each={closedRows()}>
                    {(a) => (
                      <Row a={a} tipEpoch={tipEpoch()} pro={app.ui.pro} />
                    )}
                  </For>
                </div>
              </Show>

              <Show when={visible().length === 0}>
                <Notice text="No surveys match." />
              </Show>
            </Show>
          </div>
        </div>
      </div>

      <Legend />
    </main>
  );
};

const HeaderRow: Component = () => {
  const cell = (label: string, align?: "center" | "right"): JSX.Element => (
    <span
      style={{
        "font-family": "var(--mono)",
        "font-size": "9.5px",
        "letter-spacing": ".09em",
        "text-transform": "uppercase",
        color: "#B0A488",
        "font-weight": "600",
        "text-align": align ?? "left",
      }}
    >
      {label}
    </span>
  );
  return (
    <div
      style={{
        display: "grid",
        "grid-template-columns": COLS,
        gap: "14px",
        "align-items": "center",
        padding: "10px 6px",
        "border-bottom": "1px solid #DDD3C0",
      }}
    >
      {cell("Form", "center")}
      <span />
      {cell("Survey")}
      {cell("Eligible")}
      {cell("Ends")}
      {cell("Replies", "right")}
    </div>
  );
};

const SectionLabel: Component<{
  dot: JSX.Element;
  color: string;
  label: string;
  note?: string;
  topBorder?: boolean;
}> = (props) => (
  <div
    style={{
      display: "flex",
      "align-items": "baseline",
      gap: "9px",
      padding: props.topBorder ? "18px 6px 8px" : "16px 6px 8px",
      ...(props.topBorder ? { "border-top": "1px solid #ECE2D0" } : {}),
    }}
  >
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
        "font-family": "var(--mono)",
        "font-size": "9.5px",
        "font-weight": "600",
        "letter-spacing": ".06em",
        "text-transform": "uppercase",
        color: props.color,
      }}
    >
      {props.dot}
      {props.label}
    </span>
    <Show when={props.note}>
      <span style={{ "font-size": "12px", color: "#B0A488" }}>
        {props.note}
      </span>
    </Show>
  </div>
);

function endsLabel(v: ViewStatus, endEpoch: number, tipEpoch: number): string {
  switch (v) {
    case "public": {
      const left = endEpoch - tipEpoch;
      return left <= 0
        ? "ends this epoch"
        : `in ${left} epoch${left === 1 ? "" : "s"}`;
    }
    case "sealed":
      return "sealed until reveal";
    case "ended":
      return "closed";
    case "cancelled":
      return "withdrawn";
  }
}

const Row: Component<{ a: SurveyAggregate; tipEpoch: number; pro: boolean }> = (
  props,
) => {
  const navigate = useNavigate();
  const def = () => props.a.record.definition;
  const v = () => viewStatus(props.a);
  const closed = () => isClosed(v());
  return (
    <div
      onClick={() => navigate(`/survey/${encodeURIComponent(props.a.key)}`)}
      style={{
        display: "grid",
        "grid-template-columns": COLS,
        gap: "14px",
        "align-items": "center",
        padding: "12px 6px",
        "border-bottom": "1px solid #ECE2D0",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "5px",
        }}
      >
        <FormMosaic count={def().questions.length} />
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "9.5px",
            "font-weight": "600",
            color: closed() ? "#B3A892" : "#A98A6E",
          }}
        >
          {def().questions.length}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          "justify-content": "center",
          "align-items": "center",
        }}
      >
        <VisGlyph status={v()} />
      </div>
      <div style={{ "min-width": "0" }}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            "min-width": "0",
          }}
        >
          <span
            style={{
              "font-family": "var(--serif)",
              "font-size": "16px",
              "font-weight": "600",
              "letter-spacing": "-.005em",
              color: closed() ? "#5C5648" : "var(--ink)",
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
            }}
          >
            {def().title || "Untitled · external content"}
          </span>
        </div>
        <div
          style={{
            "font-size": "12px",
            color: "#A79C88",
            "white-space": "nowrap",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "margin-top": "2px",
          }}
        >
          {def().description ||
            "Presentation text unavailable — on-chain structure intact."}
        </div>
      </div>
      <RoleChips roles={def().eligibleRoles} />
      <div>
        <div
          style={{
            "font-size": "13px",
            "font-weight": "500",
            color: closed() ? "#8A8270" : "#5A5246",
          }}
        >
          {endsLabel(v(), def().endEpoch, props.tipEpoch)}
        </div>
        <Show when={props.pro}>
          <div
            style={{
              "font-family": "var(--mono)",
              "font-size": "10.5px",
              color: closed() ? "#9C9486" : "var(--gov)",
              "margin-top": "2px",
            }}
          >
            epoch {def().endEpoch} · {props.a.record.txHash.slice(0, 8)}…
          </div>
        </Show>
      </div>
      <div style={{ "text-align": "right" }}>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "13px",
            "font-weight": "600",
            color: closed() ? "#6C6657" : "var(--ink)",
          }}
        >
          {v() === "cancelled" ? "—" : props.a.responseCount}
        </span>
      </div>
    </div>
  );
};

const Legend: Component = () => (
  <div
    style={{
      display: "flex",
      "align-items": "center",
      gap: "9px",
      "margin-top": "14px",
      padding: "0 2px",
      "flex-wrap": "wrap",
    }}
  >
    <FormMosaic count={4} size={14} />
    <span style={{ "font-size": "11.5px", color: "#A79C88" }}>
      Form — one tile per question.
    </span>
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "6px",
        "margin-left": "10px",
      }}
    >
      <span
        style={{
          width: "11px",
          height: "11px",
          "border-radius": "50%",
          border: "2px solid #7E8B6A",
          "box-sizing": "border-box",
        }}
      />
      <span style={{ "font-size": "11.5px", color: "#A79C88" }}>public</span>
      <span style={{ "margin-left": "6px", display: "inline-flex" }}>
        <VisGlyph status="sealed" />
      </span>
      <span style={{ "font-size": "11.5px", color: "#A79C88" }}>
        sealed until reveal
      </span>
    </span>
  </div>
);

const Notice: Component<{ text: string; tone?: "danger" }> = (props) => (
  <div
    style={{
      padding: "26px 6px",
      "text-align": "center",
      "font-size": "13.5px",
      color: props.tone === "danger" ? "var(--danger)" : "var(--muted)",
    }}
  >
    {props.text}
  </div>
);

function filterStyle(on: boolean): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    "border-radius": "8px",
    padding: "6px 12px",
    "white-space": "nowrap",
    border: on ? "1px solid var(--accent)" : "1px solid #E7E0D0",
    background: on ? "var(--accent)" : "#F2ECDE",
    color: on ? "#FBF8F1" : "#6B6356",
  };
}

function filterCountStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "10.5px",
    "font-weight": "600",
    color: on ? "rgba(251,248,241,.75)" : "#A79C88",
  };
}
