/** Sealed-survey results: the client-side reveal, then the live tally. */

import {
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  on,
  type Component,
} from "solid-js";
import type { SurveyDefinition } from "cip-179";
import {
  auditRevealedResponses,
  dedupeResponses,
  type ExcludedRecord,
  type ProofVerdicts,
  type ResponseRecord,
  type RevealedAudit,
  type SurveyAggregate,
} from "cip-179/domain";
import { revealResponses, roundIsAvailable } from "cip-179/tlock";

import { formatRevealDate } from "~/tlock/drand";
import { t, n } from "~/i18n";
import { LiveResults } from "./Live";
import css from "./results.module.css";

/** A sealed survey's browser reveal, created once per results page. */
export interface SealedReveal {
  /** The drand round the definition pins; null for a public survey. */
  readonly round: () => number | null;
  /** Whether that round has published. */
  readonly available: () => boolean;
  /** Responders after structural dedup — role and credential are plaintext. */
  readonly sealedCount: () => number;
  /** The audit of the current in-window set, once the viewer revealed it. */
  readonly audit: () => RevealedAudit | undefined;
  readonly loading: () => boolean;
  readonly error: () => unknown;
  readonly request: () => void;
}

/**
 * Reveal is opt-in: nothing decrypts until `request()`, so opening the page
 * never silently kicks off network + crypto work. The request resets on a survey
 * change (the instance is reused across `:key`) so navigating from a revealed
 * survey to another sealed one never auto-starts decryption. Both sealed views
 * read the one audit, so toggling between them never decrypts twice.
 */
export function createSealedReveal(
  props: {
    readonly s: SurveyAggregate;
    readonly keyStr: string;
    readonly nowUnix: number;
  },
  /** Pre-dedup in-window structurally-valid responses (dedup happens post-reveal). */
  inWindow: () => readonly ResponseRecord[],
): SealedReveal {
  const mode = () => {
    const m = props.s.record.definition.submissionMode;
    return m.type === "sealed" ? m : null;
  };
  const available = () => {
    const m = mode();
    return !!m && roundIsAvailable(m.round, props.nowUnix);
  };

  const [requested, setRequested] = createSignal(false);
  createEffect(
    on(
      () => props.keyStr,
      () => setRequested(false),
      { defer: true },
    ),
  );

  // The resource source is a fingerprint string, not the bare round number or a
  // fresh `{ records, round }` object: keying on the round alone would freeze the
  // decrypted set to whatever was loaded the instant the round became available
  // (later responses in a new snapshot would never re-tally), while a fresh
  // object would re-decrypt every 30s as the clock behind `available()` ticks.
  // The fingerprint = round + the sorted response tx hashes, so it changes on a
  // genuine membership change but stays stable across ticks and object identity.
  const revealKey = (): string | null => {
    if (
      !(
        requested() &&
        available() &&
        !props.s.sealedUnsupported &&
        !props.s.cancelled
      )
    )
      return null;
    const hashes = inWindow()
      .map((r) => r.txHash)
      .sort();
    return `${mode()!.round}:${hashes.join(",")}`;
  };

  const [revealed] = createResource(revealKey, async (key) => {
    const records = inWindow();
    const round = mode()!.round;
    // Only ~/wallet/cbor is loaded lazily — it is the import that gates the
    // heavy evolution-sdk chunk. cip-179/tlock is already statically imported
    // above (tlock-js itself stays lazy inside its client).
    const { evolutionCodec } = await import("~/wallet/cbor");
    // Decrypt the *full* pre-dedup in-window set, then classify + dedup in core:
    // dedup must run over the valid decrypted responses, never before them, or an
    // invalid later ciphertext would suppress a valid earlier one that then never
    // reveals (finding 2). Validate against the *on-chain* definition (constraints
    // and indices are on-chain; enrichment only relabels), not the display one.
    const results = await revealResponses(
      evolutionCodec,
      records.map((r) => r.response),
      round,
    );
    return {
      key,
      audit: auditRevealedResponses(
        records,
        results,
        props.s.record.definition,
      ),
    };
  });

  return {
    round: () => mode()?.round ?? null,
    available,
    sealedCount: () => dedupeResponses(inWindow()).length,
    // A resource keeps its last value when its source goes null, so an audit
    // is only this survey's while its fingerprint is still the current one.
    audit: () => {
      const v = revealed();
      return v !== undefined && v.key === revealKey() ? v.audit : undefined;
    },
    loading: () => revealed.loading,
    error: () => revealed.error,
    request: () => setRequested(true),
  };
}

/**
 * Sealed-survey results. While the drand round is in the future, responses are
 * collected but unreadable. Once it publishes, a viewer can trigger the reveal —
 * fetch the beacon, decrypt every sealed response (each to a synthetic public
 * one), then hand off to {@link LiveResults}.
 */
export const SealedResults: Component<{
  s: SurveyAggregate;
  def: SurveyDefinition;
  keyStr: string;
  reveal: SealedReveal;
  /**
   * Reveal-independent exclusions only (after-deadline, structurally invalid,
   * proof-failed) — proof is answer-independent, so an unproven sealed
   * response is excluded without waiting for the reveal.
   */
  hardExcluded: readonly ExcludedRecord[];
  /** Forwarded to {@link LiveResults} for the post-reveal view. */
  verdicts?: ProofVerdicts | undefined;
}> = (props) => {
  // Post-reveal exclusions, folded into the on-chain categories from which the
  // count breakdown derives. `undecryptable` = a response that didn't decrypt or
  // didn't decode (Tessera can't always tell which, so the label stays neutral);
  // `invalid` = one that decoded but violated the survey's constraints. Both are
  // only knowable after reveal, so they're appended here, not in the pure audit.
  const excludedRecordsWithFailures = (r: RevealedAudit): ExcludedRecord[] => [
    ...props.hardExcluded,
    ...r.superseded.map((record) => ({ key: "superseded" as const, record })),
    ...r.invalid.map((record) => ({ key: "invalid" as const, record })),
    ...r.failed.map((record) => ({ key: "undecryptable" as const, record })),
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
      <Match when={props.s.sealedUnsupported}>
        <SealedStateNotice
          tone="warn"
          title={t("survey.sealedUnsupportedTitle")}
          body={t("survey.sealedUnsupportedBody")}
        />
      </Match>
      <Match when={!props.reveal.available()}>
        <SealedStateNotice
          tone="warn"
          title={t("survey.sealedTitle")}
          body={t("survey.sealedBody", {
            n: n(props.reveal.sealedCount()),
            responses:
              props.reveal.sealedCount() === 1
                ? t("survey.responseSingular")
                : t("survey.responsePlural"),
            date: formatRevealDate(props.reveal.round()!),
          })}
        />
      </Match>
      <Match when={props.reveal.audit()}>
        {(audit) => (
          <LiveResults
            def={props.def}
            keyStr={props.keyStr}
            records={audit().counted}
            excludedRecords={excludedRecordsWithFailures(audit())}
            verdicts={props.verdicts}
          />
        )}
      </Match>
      <Match when={true}>
        <RevealNotice reveal={props.reveal} />
      </Match>
    </Switch>
  );
};

/**
 * What a revealable sealed survey shows in place of anything that reads its
 * answers: the reveal button, then progress, then the error if it failed.
 */
export const RevealNotice: Component<{ reveal: SealedReveal }> = (props) => (
  <Switch>
    <Match when={props.reveal.loading()}>
      <SealedStateNotice
        tone="muted"
        title={t("survey.revealingTitle")}
        body={t("survey.revealingBody")}
      />
    </Match>
    <Match when={props.reveal.error()}>
      <SealedStateNotice
        tone="warn"
        title={t("survey.revealErrorTitle")}
        body={messageOf(props.reveal.error())}
      />
    </Match>
    <Match when={true}>
      <SealedStateNotice
        tone="muted"
        title={t("survey.sealedRevealableTitle")}
        body={t("survey.sealedRevealableBody", {
          date: formatRevealDate(props.reveal.round()!),
          n: n(props.reveal.sealedCount()),
          responses:
            props.reveal.sealedCount() === 1
              ? t("survey.responseSingular")
              : t("survey.responsePlural"),
        })}
        action={{
          label: t("survey.revealAll"),
          onClick: () => props.reveal.request(),
        }}
      />
    </Match>
  </Switch>
);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
