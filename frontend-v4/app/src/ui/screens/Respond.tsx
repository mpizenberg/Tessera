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
  encodePayload,
  validateResponse,
  type ContentAnchor,
  type Credential,
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
import { hexToBytes } from "~/util/hex";
import { formatRevealDate } from "~/tlock/drand";
import { roleColors, roleLabel, shortRef, viewStatus } from "~/ui/format";
import type { WalletIdentity } from "~/wallet/types";

// ----------------------------------------------------------------------------
// Screen
// ----------------------------------------------------------------------------

export const Respond: Component = () => {
  const app = useApp();
  const params = useParams<{ key: string }>();
  const key = () => decodeURIComponent(params.key);

  const survey = createMemo(() =>
    app.snapshot() ? findSurvey(app.snapshot()!.surveys, key()) : undefined,
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

  // Re-seed drafts whenever the survey or chosen role changes (a different role
  // means a different prior response to pre-fill from, or none).
  createEffect(
    on(
      () => [survey()?.key, role()] as const,
      () => {
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

  const setValue = (i: number, value: DraftValue) =>
    setDrafts(i, "value", value);
  const setSkipped = (i: number, skipped: boolean) =>
    setDrafts(i, "skipped", skipped);

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
      app.reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setBusyText("Submitting…");
    }
  };

  return (
    <main
      style={{
        "max-width": "760px",
        margin: "0 auto",
        padding: "22px 24px 140px",
      }}
    >
      <A href={`/survey/${encodeURIComponent(key())}`} style={backLinkStyle()}>
        <span style={{ "font-size": "15px" }}>←</span> Back to results
      </A>

      <Show when={survey()} fallback={<Empty loading={app.snapshot.loading} />}>
        {(s) => (
          <Show
            when={txHash() === null}
            fallback={<SubmittedPanel hash={txHash()!} surveyKey={key()} />}
          >
            <SurveyHeader
              s={s()}
              pro={app.ui.pro}
              role={role()}
              respondable={respondable()}
              onPickRole={(r) => {
                setRoleOverride(r);
                app.setActiveRole(r);
              }}
            />

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

              <div
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "12px",
                  "margin-top": "12px",
                }}
              >
                <For each={s().record.definition.questions}>
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
                <ProblemList problems={problems()} />
              </Show>
              <Show when={submitError()}>
                <ErrorBox message={submitError()!} />
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
  <div style={cardStyle()}>
    <h3
      style={{
        "font-size": "17px",
        "font-weight": "800",
        margin: "0",
        "letter-spacing": "-.01em",
      }}
    >
      You can't respond to this survey
    </h3>
    <p
      style={{
        "font-size": "13.5px",
        color: "var(--muted)",
        "line-height": "1.55",
        margin: "7px 0 0",
      }}
    >
      It's open only to the roles below, and your connected wallet can't claim
      any of them here. (SPO and CC roles need keys browser wallets don't hold.)
    </p>
    <div
      style={{
        display: "flex",
        gap: "7px",
        "margin-top": "13px",
        "flex-wrap": "wrap",
      }}
    >
      <For each={props.def.eligibleRoles}>
        {(r) => {
          const [color, bg] = roleColors(r);
          return <span style={roleChipStyle(color, bg)}>{roleLabel(r)}</span>;
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
  pro: boolean;
  role: Role | null;
  respondable: Role[];
  onPickRole: (r: Role) => void;
}> = (props) => (
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
          "font-family": "var(--mono)",
          "font-size": "11px",
          color: "var(--dim)",
          "letter-spacing": ".04em",
          "text-transform": "uppercase",
        }}
      >
        Respond
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
          ref {shortRef(props.s.key)}
        </span>
      </Show>
    </div>
    <h1
      style={{
        "font-size": "26px",
        "font-weight": "700",
        "letter-spacing": "-.018em",
        "line-height": "1.16",
        margin: "12px 0 0",
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

    <Show when={props.respondable.length > 0}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          "margin-top": "16px",
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "10px",
            "letter-spacing": ".08em",
            "text-transform": "uppercase",
            color: "var(--dim)",
          }}
        >
          Responding as
        </span>
        <For each={props.respondable}>
          {(r) => (
            <button
              onClick={() => props.onPickRole(r)}
              style={rolePickStyle(r === props.role)}
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
  <div
    style={{
      display: "flex",
      "align-items": "flex-start",
      gap: "11px",
      background: "#F0FAF3",
      border: "1px solid var(--ok-line)",
      "border-radius": "13px",
      padding: "13px 16px",
      "margin-top": "14px",
    }}
  >
    <span
      style={{
        width: "20px",
        height: "20px",
        "border-radius": "50%",
        background: "var(--ok)",
        color: "#fff",
        "font-size": "12px",
        "font-weight": "700",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        flex: "none",
        "margin-top": "1px",
      }}
    >
      ✓
    </span>
    <div style={{ flex: "1" }}>
      <div
        style={{
          "font-size": "13.5px",
          "font-weight": "700",
          color: "var(--ok)",
        }}
      >
        You already responded as{" "}
        {props.role !== null ? roleLabel(props.role) : "this role"}
      </div>
      <div
        style={{
          "font-size": "12.5px",
          color: "#3F7A55",
          "line-height": "1.45",
          "margin-top": "3px",
        }}
      >
        Your previous answers are pre-filled. Submitting again publishes a new
        response that fully replaces the earlier one under latest-valid-wins;
        the old one stays on-chain but is no longer tallied.
      </div>
    </div>
  </div>
);

const SealedBanner: Component<{ round: number }> = (props) => (
  <div
    style={{
      display: "flex",
      "align-items": "flex-start",
      gap: "11px",
      background: "#FBFAF6",
      border: "1px solid #F0EBD8",
      "border-radius": "13px",
      padding: "13px 16px",
      "margin-top": "14px",
    }}
  >
    <span
      style={{ "font-size": "15px", color: "var(--warn)", "margin-top": "1px" }}
    >
      ◆
    </span>
    <div style={{ flex: "1" }}>
      <div
        style={{
          "font-size": "13.5px",
          "font-weight": "700",
          color: "#7A6A45",
        }}
      >
        This is a sealed survey
      </div>
      <div
        style={{
          "font-size": "12.5px",
          color: "#7A6A45",
          "line-height": "1.5",
          "margin-top": "3px",
        }}
      >
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
  <div
    style={{
      display: "flex",
      "align-items": "flex-start",
      gap: "11px",
      background: "#FBFAF6",
      border: "1px solid #F0EBD8",
      "border-radius": "13px",
      padding: "13px 16px",
      "margin-top": "14px",
    }}
  >
    <span
      style={{ "font-size": "15px", color: "var(--warn)", "margin-top": "1px" }}
    >
      ⚠
    </span>
    <div style={{ flex: "1" }}>
      <div
        style={{
          "font-size": "13.5px",
          "font-weight": "700",
          color: "#7A6A45",
        }}
      >
        Presentation labels unavailable
      </div>
      <div
        style={{
          "font-size": "12.5px",
          color: "#7A6A45",
          "line-height": "1.5",
          "margin-top": "3px",
        }}
      >
        The off-chain document (
        <span style={{ "font-family": "var(--mono)", "font-size": "11.5px" }}>
          {shortRef(props.keyStr)}
        </span>
        ) couldn't be fetched or failed its hash check, so option labels are
        shown as indices. <b>You can still respond</b> — your answer references
        option indices, validated and tallied normally.
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
  <div style={{ ...cardStyle(), "margin-top": "12px" }}>
    <label
      style={{
        display: "flex",
        "align-items": "center",
        gap: "10px",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={props.on}
        onChange={(e) => props.onToggle(e.currentTarget.checked)}
        style={{
          width: "16px",
          height: "16px",
          "accent-color": "var(--accent)",
        }}
      />
      <span style={{ "font-size": "13.5px", "font-weight": "600", flex: "1" }}>
        Attach a rationale document{" "}
        <span style={{ color: "var(--dim)", "font-weight": "400" }}>
          (off-chain, hash-anchored)
        </span>
      </span>
    </label>
    <Show when={props.on}>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "10px",
          "margin-top": "12px",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            "align-self": "flex-start",
            background: "#F1EADC",
            border: "1px solid #E3DBC9",
            "border-radius": "9px",
            padding: "3px",
          }}
        >
          <button
            type="button"
            style={ratTabStyle(props.mode === "write")}
            onClick={() => props.onMode("write")}
          >
            Write &amp; pin
          </button>
          <button
            type="button"
            style={ratTabStyle(props.mode === "manual")}
            onClick={() => props.onMode("manual")}
          >
            Paste anchor
          </button>
        </div>

        <Show
          when={props.mode === "write"}
          fallback={
            <>
              <div>
                <label style={ratLabelStyle()}>Document URI</label>
                <input
                  type="text"
                  value={props.uri}
                  placeholder="ipfs://… or https://…"
                  onInput={(e) => props.onUri(e.currentTarget.value)}
                  style={{
                    ...numberInputStyle(),
                    "font-family": "var(--mono)",
                    "font-size": "12.5px",
                  }}
                />
              </div>
              <div>
                <label style={ratLabelStyle()}>Hash (blake2b-256, hex)</label>
                <input
                  type="text"
                  value={props.hash}
                  placeholder="64 hex characters"
                  onInput={(e) => props.onHash(e.currentTarget.value)}
                  style={{
                    ...numberInputStyle(),
                    "font-family": "var(--mono)",
                    "font-size": "12.5px",
                  }}
                />
              </div>
              <p
                style={{
                  "font-size": "11.5px",
                  color: "var(--dim)",
                  "line-height": "1.45",
                  margin: "0",
                }}
              >
                Host the document yourself; the hash makes it tamper-evident.
              </p>
            </>
          }
        >
          <div>
            <label style={ratLabelStyle()}>Rationale</label>
            <textarea
              value={props.text}
              rows={4}
              placeholder="Why you answered this way…"
              onInput={(e) => props.onText(e.currentTarget.value)}
              style={{
                ...numberInputStyle(),
                "font-family": "inherit",
                "font-size": "13px",
                "line-height": "1.5",
                resize: "vertical",
              }}
            />
          </div>
          <Show
            when={props.hasPinning}
            fallback={
              <p
                style={{
                  "font-size": "11.5px",
                  color: "var(--warn)",
                  "line-height": "1.45",
                  margin: "0",
                }}
              >
                No IPFS provider is configured — add a token in{" "}
                <A href="/settings" style={{ color: "var(--accent)" }}>
                  Settings
                </A>{" "}
                to pin from here, or switch to “Paste anchor”.
              </p>
            }
          >
            <p
              style={{
                "font-size": "11.5px",
                color: "var(--dim)",
                "line-height": "1.45",
                margin: "0",
              }}
            >
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

function ratTabStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "11.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    border: "none",
    "border-radius": "7px",
    padding: "5px 12px",
    background: on ? "var(--accent)" : "transparent",
    color: on ? "#fff" : "#857B6B",
  };
}

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
    <div style={cardStyle()}>
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
          <span style={qChipStyle()}>Q{props.index + 1}</span>
          <span
            style={{
              "font-family": "var(--mono)",
              "font-size": "10px",
              "letter-spacing": ".06em",
              "text-transform": "uppercase",
              color: "var(--dim)",
            }}
          >
            {typeMeta(props.q)}
          </span>
          <Show when={props.q.required}>
            <span
              style={{
                "font-size": "10px",
                "font-weight": "700",
                color: "var(--danger)",
                background: "var(--danger-bg)",
                "border-radius": "var(--r-3xs)",
                padding: "2px 6px",
              }}
            >
              Required
            </span>
          </Show>
        </div>
        <Show when={!props.q.required}>
          <button
            onClick={() => props.onSkip(!skipped())}
            style={skipBtnStyle(skipped())}
          >
            {skipped() ? "Skipped" : "Skip"}
          </button>
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
        {props.q.prompt || "(no prompt)"}
      </h3>

      <Show
        when={!skipped()}
        fallback={
          <p
            style={{
              "font-size": "12.5px",
              color: "var(--dim)",
              margin: "12px 0 0",
              "font-style": "italic",
            }}
          >
            Skipped — abstaining. Nothing is recorded for this question.
          </p>
        }
      >
        <div style={{ "margin-top": "14px" }}>
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
  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
    <For each={range(optionCount(props.q.options))}>
      {(i) => {
        const on = () => props.v.optionIndex === i;
        return (
          <div
            onClick={() =>
              props.onChange({ type: "singleChoice", optionIndex: i })
            }
            style={optionRowStyle(on())}
          >
            <span style={radioStyle(on())}>
              <Show when={on()}>
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: "#fff",
                  }}
                />
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
      <div
        style={{
          display: "grid",
          "grid-template-columns": "1fr 1fr",
          gap: "8px",
        }}
      >
        <For each={range(optionCount(props.q.options))}>
          {(i) => {
            const on = () => props.v.selected.includes(i);
            return (
              <div onClick={() => toggle(i)} style={optionRowStyle(on())}>
                <span style={checkboxStyle(on())}>
                  <Show when={on()}>✓</Show>
                </span>
                <span>{labelFor(props.q.options, i)}</span>
              </div>
            );
          }}
        </For>
      </div>
      <div
        style={{
          "font-family": "var(--mono)",
          "font-size": "11px",
          color: "var(--dim)",
          "margin-top": "10px",
        }}
      >
        select {props.q.minSelections}–{props.q.maxSelections} ·{" "}
        {props.v.selected.length} chosen
      </div>
      <Show when={props.q.minSelections === 0}>
        <div
          style={{
            display: "flex",
            "align-items": "flex-start",
            gap: "9px",
            background: "#FBFAF6",
            border: "1px solid #F0EBD8",
            "border-radius": "var(--r-md)",
            padding: "10px 12px",
            "margin-top": "10px",
          }}
        >
          <span
            style={{
              "font-size": "12px",
              color: "#7A6A45",
              "line-height": "1.45",
            }}
          >
            <b style={{ color: "#5B4A22" }}>
              "None of these" is a real answer.
            </b>{" "}
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
        <div style={{ "margin-bottom": "10px" }}>
          <For each={ranked()}>
            {(optIdx, pos) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "11px",
                  background: "var(--accent-bg)",
                  border: "1px solid var(--accent-line)",
                  "border-radius": "var(--r-control)",
                  padding: "9px 11px",
                  "margin-bottom": "7px",
                }}
              >
                <span
                  style={{
                    width: "24px",
                    height: "24px",
                    "border-radius": "50%",
                    background: "var(--accent)",
                    color: "#fff",
                    "font-size": "12.5px",
                    "font-weight": "700",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    flex: "none",
                  }}
                >
                  {pos() + 1}
                </span>
                <span
                  style={{
                    "font-size": "14.5px",
                    "font-weight": "600",
                    flex: "1",
                  }}
                >
                  {labelFor(props.q.options, optIdx)}
                </span>
                <button style={rankBtnStyle()} onClick={() => move(pos(), -1)}>
                  ↑
                </button>
                <button style={rankBtnStyle()} onClick={() => move(pos(), 1)}>
                  ↓
                </button>
                <button
                  style={rankBtnStyle("danger")}
                  onClick={() => remove(optIdx)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={pool().length > 0}>
        <div
          style={{
            "font-family": "var(--mono)",
            "font-size": "10.5px",
            color: "var(--dim)",
            "margin-bottom": "8px",
          }}
        >
          tap to add · rank {props.q.minRanked}–{props.q.maxRanked}
        </div>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
          <For each={pool()}>
            {(i) => (
              <button
                onClick={() => add(i)}
                disabled={ranked().length >= props.q.maxRanked}
                style={poolBtnStyle(ranked().length >= props.q.maxRanked)}
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
      <div
        style={{
          display: "flex",
          "align-items": "baseline",
          gap: "10px",
          "justify-content": "center",
          margin: "4px 0 14px",
        }}
      >
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "44px",
            "font-weight": "600",
            color: "var(--accent)",
            "letter-spacing": "-.02em",
          }}
        >
          {props.v.value.toString()}
        </span>
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
            style={numberInputStyle()}
          />
        }
      >
        <input
          type="range"
          min={Number(min)}
          max={Number(max)}
          step={Number(step)}
          value={Number(props.v.value)}
          onInput={(e) => set(BigInt(e.currentTarget.value))}
          style={{ width: "100%", "accent-color": "var(--accent)" }}
        />
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "font-family": "var(--mono)",
            "font-size": "11px",
            color: "var(--dim)",
            "margin-top": "8px",
          }}
        >
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
      <div
        style={{
          display: "flex",
          "align-items": "baseline",
          "justify-content": "flex-end",
          gap: "8px",
          "margin-bottom": "14px",
        }}
      >
        <span
          style={{
            "font-size": "13px",
            "font-weight": "600",
            color: "var(--muted)",
          }}
        >
          Remaining to allocate
        </span>
        <span
          style={{
            "font-family": "var(--mono)",
            "font-size": "15px",
            "font-weight": "700",
            color: remaining() === 0 ? "var(--ok)" : "var(--accent)",
          }}
        >
          {remaining()} pts
        </span>
      </div>
      <For each={range(optionCount(props.q.options))}>
        {(i) => (
          <div style={{ "margin-bottom": "13px" }}>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                "margin-bottom": "7px",
              }}
            >
              <span style={{ "font-size": "14.5px", "font-weight": "600" }}>
                {labelFor(props.q.options, i)}
              </span>
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "10px",
                }}
              >
                <button style={stepBtnStyle()} onClick={() => bump(i, -1)}>
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
                  style={pointsInputStyle()}
                />
                <button style={stepBtnStyle()} onClick={() => bump(i, 1)}>
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
              style={{
                width: "100%",
                display: "block",
                "accent-color": "var(--accent)",
                cursor: "pointer",
              }}
            />
          </div>
        )}
      </For>
      <div
        style={{
          "font-family": "var(--mono)",
          "font-size": "11px",
          color: "var(--faint)",
        }}
      >
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
    <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
      <For each={range(optionCount(props.q.options))}>
        {(optIdx) => (
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              gap: "12px",
              padding: "9px 0",
              "border-top": "1px solid var(--hair)",
              "flex-wrap": "wrap",
            }}
          >
            <span style={{ "font-size": "14.5px", "font-weight": "600" }}>
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
                  style={{ ...numberInputStyle(), width: "120px" }}
                />
              }
            >
              <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
                <For each={levels!}>
                  {(lvl) => {
                    const on = () => props.v.ratings[optIdx] === lvl.value;
                    return (
                      <button
                        onClick={() => setRating(optIdx, lvl.value)}
                        style={ratingBtnStyle(on())}
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
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "10px",
        background: "var(--ink)",
        "border-radius": "var(--r-control)",
        padding: "11px 13px",
        "margin-bottom": "11px",
      }}
    >
      <span
        style={{
          "font-family": "var(--mono)",
          "font-size": "10px",
          "font-weight": "600",
          "letter-spacing": ".06em",
          color: "#7E89A8",
          background: "#1C2536",
          "border-radius": "var(--r-3xs)",
          padding: "3px 7px",
        }}
      >
        schema
      </span>
      <span
        style={{
          "font-family": "var(--mono)",
          "font-size": "11.5px",
          color: "#C4CCDA",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.q.methodSchema.uri}
      </span>
    </div>
    <input
      type="text"
      value={props.v.text}
      placeholder="Your answer"
      onInput={(e) =>
        props.onChange({ type: "custom", text: e.currentTarget.value })
      }
      style={{
        width: "100%",
        border: "1px solid var(--line)",
        "border-radius": "var(--r-control)",
        padding: "13px 14px",
        "font-family": "inherit",
        "font-size": "14.5px",
        color: "var(--ink)",
        outline: "none",
        "box-sizing": "border-box",
      }}
    />
    <p
      style={{
        "font-size": "11.5px",
        color: "var(--dim)",
        "line-height": "1.45",
        margin: "9px 0 0",
      }}
    >
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
  idleText: string;
  busyText: string;
  onSubmit: () => void;
}> = (props) => {
  const ready = () => props.decided >= props.total && props.total > 0;
  return (
    <div
      style={{
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "0",
        "z-index": "30",
        background: "rgba(255,255,255,.92)",
        "backdrop-filter": "blur(10px)",
        "border-top": "1px solid #E7E0D0",
      }}
    >
      <div
        style={{
          "max-width": "760px",
          margin: "0 auto",
          padding: "13px 24px",
          display: "flex",
          "align-items": "center",
          gap: "16px",
          "flex-wrap": "wrap",
        }}
      >
        <div
          style={{ display: "flex", "flex-direction": "column", gap: "5px" }}
        >
          <span
            style={{ display: "flex", "align-items": "center", gap: "4px" }}
          >
            <For each={range(props.total)}>
              {(i) => (
                <span
                  style={{
                    width: "16px",
                    height: "5px",
                    "border-radius": "3px",
                    background:
                      i < props.decided ? "var(--accent)" : "var(--line2)",
                  }}
                />
              )}
            </For>
          </span>
          <span style={{ "font-size": "13.5px", "font-weight": "700" }}>
            {props.decided} of {props.total} decided
          </span>
          <Show when={props.replacing}>
            <span
              style={{
                "font-family": "var(--mono)",
                "font-size": "11px",
                color: "var(--ok)",
              }}
            >
              ✓ replaces your previous response
            </span>
          </Show>
        </div>
        <button
          onClick={() => props.onSubmit()}
          disabled={!ready() || props.submitting}
          style={submitBtnStyle(ready() && !props.submitting)}
        >
          {props.submitting ? props.busyText : props.idleText}{" "}
          <span style={{ "font-size": "15px" }}>→</span>
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
    <div
      style={{ ...cardStyle(), "text-align": "center", "margin-top": "20px" }}
    >
      <span
        style={{
          display: "inline-flex",
          "align-items": "center",
          "justify-content": "center",
          width: "46px",
          height: "46px",
          "border-radius": "13px",
          background: "var(--ok-bg)",
          color: "var(--ok)",
          "font-size": "22px",
        }}
      >
        ✓
      </span>
      <h3
        style={{
          "font-size": "19px",
          "font-weight": "800",
          "letter-spacing": "-.01em",
          margin: "14px 0 0",
        }}
      >
        Response submitted
      </h3>
      <p
        style={{
          "font-size": "14px",
          color: "var(--muted)",
          "line-height": "1.55",
          margin: "8px auto 0",
          "max-width": "440px",
        }}
      >
        Your response was published under metadata label 17. It may take a few
        moments to appear in the tally as the indexer catches up.
      </p>
      <div
        style={{
          "font-family": "var(--mono)",
          "font-size": "11.5px",
          color: "var(--faint)",
          "margin-top": "12px",
          "word-break": "break-all",
        }}
      >
        tx {props.hash}
      </div>
      <button
        onClick={() =>
          navigate(`/survey/${encodeURIComponent(props.surveyKey)}`)
        }
        style={{
          "margin-top": "18px",
          background: "var(--accent)",
          color: "#fff",
          border: "none",
          "border-radius": "var(--r-control)",
          padding: "11px 18px",
          "font-family": "inherit",
          "font-size": "14px",
          "font-weight": "700",
          cursor: "pointer",
        }}
      >
        View results →
      </button>
    </div>
  );
};

const ProblemList: Component<{ problems: string[] }> = (props) => (
  <div
    style={{
      background: "var(--danger-bg)",
      border: "1px solid var(--danger-line)",
      "border-radius": "var(--r-md)",
      padding: "13px 15px",
      "margin-top": "14px",
    }}
  >
    <div
      style={{
        "font-size": "13px",
        "font-weight": "700",
        color: "var(--danger)",
      }}
    >
      Please fix before submitting
    </div>
    <ul
      style={{
        margin: "8px 0 0",
        padding: "0 0 0 18px",
        color: "#8A3A2E",
        "font-size": "12.5px",
        "line-height": "1.6",
      }}
    >
      <For each={props.problems}>{(p) => <li>{p}</li>}</For>
    </ul>
  </div>
);

const ErrorBox: Component<{ message: string }> = (props) => (
  <div
    style={{
      background: "var(--danger-bg)",
      border: "1px solid var(--danger-line)",
      "border-radius": "var(--r-md)",
      padding: "13px 15px",
      "margin-top": "14px",
    }}
  >
    <div
      style={{
        "font-size": "13px",
        "font-weight": "700",
        color: "var(--danger)",
      }}
    >
      Submission failed
    </div>
    <div
      style={{
        "font-size": "12.5px",
        color: "#8A3A2E",
        "line-height": "1.5",
        "margin-top": "5px",
        "word-break": "break-word",
      }}
    >
      {props.message}
    </div>
  </div>
);

const Notice: Component<{
  tone: "warn" | "muted";
  title: string;
  body: string;
}> = (props) => (
  <div
    style={{
      background: "#fff",
      border: `1px solid ${props.tone === "warn" ? "var(--warn-line)" : "var(--line)"}`,
      "border-radius": "var(--r-card)",
      padding: "26px 24px",
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

const Empty: Component<{ loading: boolean }> = (props) => (
  <div
    style={{
      ...cardStyle(),
      "text-align": "center",
      color: "var(--muted)",
      "margin-top": "14px",
    }}
  >
    {props.loading ? "Loading…" : "Survey not found."}
  </div>
);

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
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

// --- styles -----------------------------------------------------------------

function backLinkStyle(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    "font-size": "13.5px",
    "font-weight": "600",
    color: "var(--muted)",
    "text-decoration": "none",
    padding: "6px 0",
  };
}
function cardStyle(): JSX.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-sm)",
    padding: "20px 22px",
    "margin-top": "12px",
  };
}
function qChipStyle(): JSX.CSSProperties {
  return {
    "font-family": "var(--mono)",
    "font-size": "12px",
    "font-weight": "600",
    color: "var(--accent)",
    background: "var(--accent-bg)",
    "border-radius": "var(--r-chip)",
    padding: "5px 8px",
  };
}
function skipBtnStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "12px",
    "font-weight": "700",
    cursor: "pointer",
    "border-radius": "var(--r-chip)",
    padding: "6px 12px",
    border: on ? "1px solid var(--accent)" : "1px solid var(--line)",
    background: on ? "var(--accent-bg)" : "#fff",
    color: on ? "var(--accent)" : "var(--muted)",
  };
}
function rolePickStyle(on: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "12.5px",
    "font-weight": on ? "700" : "600",
    cursor: "pointer",
    "border-radius": "8px",
    padding: "6px 12px",
    border: on ? "1px solid var(--accent)" : "1px solid #E7E0D0",
    background: on ? "var(--accent)" : "#F2ECDE",
    color: on ? "#FBF8F1" : "#6B6356",
  };
}
function roleChipStyle(color: string, bg: string): JSX.CSSProperties {
  return {
    "font-size": "12px",
    "font-weight": "700",
    color,
    background: bg,
    "border-radius": "6px",
    padding: "3px 9px",
  };
}
function optionRowStyle(on: boolean): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "11px",
    cursor: "pointer",
    "border-radius": "var(--r-control)",
    padding: "11px 13px",
    border: on ? "1px solid var(--accent)" : "1px solid var(--line)",
    background: on ? "var(--accent-bg)" : "#fff",
    "font-size": "14.5px",
    "font-weight": "600",
    color: "var(--ink)",
  };
}
function radioStyle(on: boolean): JSX.CSSProperties {
  return {
    width: "18px",
    height: "18px",
    "border-radius": "50%",
    border: on ? "none" : "2px solid var(--line2)",
    background: on ? "var(--accent)" : "#fff",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    flex: "none",
  };
}
function checkboxStyle(on: boolean): JSX.CSSProperties {
  return {
    width: "18px",
    height: "18px",
    "border-radius": "5px",
    border: on ? "none" : "2px solid var(--line2)",
    background: on ? "var(--accent)" : "#fff",
    color: "#fff",
    "font-size": "12px",
    "font-weight": "700",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    flex: "none",
  };
}
function rankBtnStyle(tone?: "danger"): JSX.CSSProperties {
  return {
    width: "26px",
    height: "26px",
    "border-radius": "var(--r-xs)",
    border: `1px solid ${tone === "danger" ? "#F0D2D0" : "var(--accent-line)"}`,
    background: "#fff",
    color: tone === "danger" ? "var(--danger)" : "var(--accent)",
    "font-size": "13px",
    cursor: "pointer",
    "line-height": "1",
    flex: "none",
  };
}
function poolBtnStyle(disabled: boolean): JSX.CSSProperties {
  return {
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "600",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? ".5" : "1",
    "border-radius": "var(--r-control)",
    padding: "8px 12px",
    border: "1px solid var(--line)",
    background: "#F2ECDE",
    color: "var(--body)",
  };
}
function stepBtnStyle(): JSX.CSSProperties {
  return {
    width: "30px",
    height: "30px",
    "border-radius": "var(--r-xs)",
    border: "1px solid var(--line)",
    background: "#fff",
    color: "var(--accent)",
    "font-size": "17px",
    cursor: "pointer",
    "line-height": "1",
    flex: "none",
  };
}
function pointsInputStyle(): JSX.CSSProperties {
  return {
    width: "52px",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-xs)",
    padding: "5px 4px",
    "font-family": "var(--mono)",
    "font-size": "15px",
    "font-weight": "600",
    color: "var(--ink)",
    "text-align": "center",
    outline: "none",
    "box-sizing": "border-box",
  };
}
function ratingBtnStyle(on: boolean): JSX.CSSProperties {
  return {
    "min-width": "34px",
    height: "34px",
    "border-radius": "var(--r-xs)",
    border: on ? "1px solid var(--accent)" : "1px solid var(--line)",
    background: on ? "var(--accent)" : "#fff",
    color: on ? "#fff" : "var(--body)",
    "font-family": "inherit",
    "font-size": "13px",
    "font-weight": "700",
    cursor: "pointer",
    padding: "0 8px",
  };
}
function numberInputStyle(): JSX.CSSProperties {
  return {
    width: "100%",
    border: "1px solid var(--line)",
    "border-radius": "var(--r-control)",
    padding: "12px 14px",
    "font-family": "var(--mono)",
    "font-size": "15px",
    color: "var(--ink)",
    outline: "none",
    "box-sizing": "border-box",
  };
}
function ratLabelStyle(): JSX.CSSProperties {
  return {
    display: "block",
    "font-size": "12px",
    "font-weight": "700",
    color: "var(--muted)",
    "margin-bottom": "6px",
  };
}
function submitBtnStyle(enabled: boolean): JSX.CSSProperties {
  return {
    "margin-left": "auto",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    gap: "9px",
    background: enabled ? "var(--accent)" : "var(--line2)",
    color: enabled ? "#fff" : "var(--dim)",
    border: "none",
    "border-radius": "var(--r-md)",
    padding: "14px 22px",
    "font-family": "inherit",
    "font-size": "14.5px",
    "font-weight": "700",
    cursor: enabled ? "pointer" : "not-allowed",
  };
}
