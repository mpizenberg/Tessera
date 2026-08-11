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
import { isQuicknet, revealResponses, roundIsAvailable } from "cip-179/tlock";

import { formatRevealDate } from "~/tlock/drand";
import { t, n } from "~/i18n";
import { LiveResults } from "./Live";
import css from "./results.module.css";

/**
 * Sealed-survey results. While the drand round is in the future, responses are
 * collected but unreadable. Once it publishes, a viewer can trigger the reveal —
 * fetch the beacon, decrypt every sealed response (each to a synthetic public
 * one), then hand off to {@link LiveResults}. Reveal is explicit (a button), not
 * automatic, so opening the page never silently kicks off network + crypto work.
 */
export const SealedResults: Component<{
  s: SurveyAggregate;
  def: SurveyDefinition;
  keyStr: string;
  /** Pre-dedup in-window structurally-valid responses (dedup happens post-reveal). */
  inWindow: ResponseRecord[];
  /**
   * Reveal-independent exclusions only (after-deadline, structurally invalid,
   * proof-failed) — proof is answer-independent, so an unproven sealed
   * response is excluded without waiting for the reveal.
   */
  hardExcluded: readonly ExcludedRecord[];
  /** Forwarded to {@link LiveResults} for the post-reveal view. */
  verdicts?: ProofVerdicts | undefined;
  nowUnix: number;
}> = (props) => {
  const mode = () => {
    const m = props.s.record.definition.submissionMode;
    return m.type === "sealed" ? m : null;
  };
  // Pre-reveal responder count: role + credential are plaintext, so structural
  // latest-wins dedup is knowable now; only the answers wait for the reveal.
  const sealedCount = (): number => dedupeResponses(props.inWindow).length;
  const supported = () => {
    const m = mode();
    return m ? isQuicknet(m.chainHash) : false;
  };
  const revealable = () => {
    const m = mode();
    return !!m && roundIsAvailable(m.round, props.nowUnix);
  };

  // Reveal is opt-in: nothing decrypts until the viewer asks for it. Reset on a
  // survey change (the instance is reused across `:key`) so navigating from a
  // revealed survey to another sealed one never auto-starts decryption.
  const [revealRequested, setRevealRequested] = createSignal(false);
  createEffect(
    on(
      () => props.keyStr,
      () => setRevealRequested(false),
      { defer: true },
    ),
  );

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
    const hashes = props.inWindow.map((r) => r.txHash).sort();
    return `${mode()!.round}:${hashes.join(",")}`;
  };

  const [revealed] = createResource(revealKey, async () => {
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
      props.inWindow.map((r) => r.response),
      mode()!.round,
    );
    return auditRevealedResponses(
      props.inWindow,
      results,
      props.s.record.definition,
    );
  });

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
            n: n(sealedCount()),
            responses:
              sealedCount() === 1
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
        <LiveResults
          def={props.def}
          keyStr={props.keyStr}
          records={revealed()!.counted}
          excludedRecords={excludedRecordsWithFailures(revealed()!)}
          verdicts={props.verdicts}
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
            n: n(sealedCount()),
            responses:
              sealedCount() === 1
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
