/**
 * A survey's results. Which of the three views renders is `resultsView()`'s
 * decision; this owns the viewer's toggle between them, the sealed-specific
 * split of the audit, and the browser reveal both sealed-survey views read.
 */

import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  type Component,
} from "solid-js";
import type { SurveyDefinition } from "cip-179";
import type {
  ExcludedRecord,
  ProofVerdicts,
  ResponseAudit,
  ResponseRecord,
  SurveyAggregate,
} from "cip-179/domain";
import type { TallyArtifact } from "cip-179/tally";

import { resultsView } from "~/domain/resultsRouting";
import { t } from "~/i18n";
import { FinalResults } from "./Final";
import { LiveResults } from "./Live";
import { SealedResults, createSealedReveal } from "./Sealed";
import css from "./results.module.css";

export const Results: Component<{
  s: SurveyAggregate;
  /** The (possibly enrichment-relabelled) definition to render against. */
  def: SurveyDefinition;
  keyStr: string;
  /** The finalized tally artifact, when the serving tier has emitted one. */
  artifact: TallyArtifact | null;
  audit: ResponseAudit;
  /** The survey's raw on-chain responses, for the final view's answer rejoin. */
  responses: readonly ResponseRecord[];
  verdicts?: ProofVerdicts | undefined;
  nowUnix: number;
}> = (props) => {
  // Viewer toggle: the artifact view is the default whenever one exists; the
  // browser-computed tally stays one click away. solid-router reuses this
  // component instance across `:key` changes, so reset it by hand or the choice
  // leaks into the next survey (finding 11).
  const [showRaw, setShowRaw] = createSignal(false);
  createEffect(
    on(
      () => props.keyStr,
      () => setShowRaw(false),
      { defer: true },
    ),
  );

  const view = (): ReturnType<typeof resultsView> =>
    resultsView(props.s.sealed, Boolean(props.artifact), showRaw());

  // Sealed surveys defer dedup to *after* reveal-time validation: while sealed,
  // `auditResponses` can only check a ciphertext structurally, so its latest-wins
  // dedup would let an invalid later ballot suppress a valid earlier one, silently
  // disenfranchising the responder (finding 2). So hand `SealedResults` the full
  // pre-dedup in-window set (structurally valid = counted ∪ its superseded
  // leftovers) plus only the reveal-independent exclusions; it decrypts every
  // one, validates, and re-dedups over the *valid* set. Order is irrelevant —
  // `dedupeResponses` picks the chain-latest regardless of input order.
  const sealedInWindow = createMemo<ResponseRecord[]>(() => [
    ...props.audit.counted,
    ...props.audit.excludedRecords
      .filter((e) => e.key === "superseded")
      .map((e) => e.record),
  ]);
  const sealedHardExcluded = createMemo<readonly ExcludedRecord[]>(() =>
    props.audit.excludedRecords.filter((e) => e.key !== "superseded"),
  );
  const reveal = createSealedReveal(props, sealedInWindow);
  // A sealed artifact commits no answers and its on-chain ones are ciphertext,
  // so the final view rejoins against the revealed responses once there are
  // some. Superseded ones stay in: the rejoin is by chain coordinate, and the
  // artifact's counted set is the backend's, not this browser's dedup.
  const finalResponses = createMemo<readonly ResponseRecord[]>(() => {
    const audit = reveal.audit();
    return audit ? [...audit.counted, ...audit.superseded] : props.responses;
  });

  return (
    <Switch>
      {/* Server-emitted, hash-verifiable tally — public and sealed alike route
          here once an artifact exists (unless toggled off). */}
      <Match when={view() === "final"}>
        <FinalResults
          artifact={props.artifact!}
          def={props.def}
          keyStr={props.keyStr}
          responses={finalResponses()}
          reveal={props.s.sealed ? reveal : undefined}
          onShowRaw={() => setShowRaw(true)}
        />
      </Match>
      {/* Sealed client reveal — the trust-minimized path, one click away
          whenever an artifact also exists. */}
      <Match when={view() === "sealed"}>
        <BackToFinal
          show={Boolean(props.artifact)}
          onClick={() => setShowRaw(false)}
        />
        <SealedResults
          s={props.s}
          def={props.def}
          keyStr={props.keyStr}
          reveal={reveal}
          hardExcluded={sealedHardExcluded()}
          verdicts={props.verdicts}
        />
      </Match>
      <Match when={view() === "raw"}>
        <BackToFinal
          show={Boolean(props.artifact)}
          onClick={() => setShowRaw(false)}
        />
        <LiveResults
          def={props.def}
          keyStr={props.keyStr}
          records={props.audit.counted}
          excludedRecords={props.audit.excludedRecords}
          verdicts={props.verdicts}
        />
      </Match>
    </Switch>
  );
};

const BackToFinal: Component<{ show: boolean; onClick: () => void }> = (
  props,
) => (
  <Show when={props.show}>
    <button class={css.excludedToggle} onClick={() => props.onClick()}>
      {t("survey.weightedShowFinal")}
    </button>
  </Show>
);
