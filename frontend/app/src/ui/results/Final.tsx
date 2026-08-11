/**
 * The final results of a closed survey, rendered from its content-addressed
 * tally artifact.
 */

import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import type { SurveyDefinition, SurveyResponse } from "cip-179";
import type { ResponseRecord } from "cip-179/domain";
import {
  RULESET_DESCRIPTOR,
  artifactHash,
  responderAnswers,
  type TallyArtifact,
} from "cip-179/tally";

import { artifactResults, formatAda, type Weighting } from "~/domain/results";
import { roleLabel, shortRef } from "~/ui/format";
import { TxNotice } from "~/ui/components/TxNotice";
import { downloadCsv, downloadJson } from "~/util/csv";
import { t, n } from "~/i18n";
import { responsesCsv, type CsvEntry } from "./export";
import { InfoNote } from "./Card";
import { QuestionResult, metaFor } from "./Question";

import css from "./results.module.css";

/**
 * The final, server-finalized results of a closed survey, rendered from its
 * content-addressed artifact. One presentation, two weightings of the *same*
 * counted set (the proof-validated responders the artifact committed to):
 * `"chain"` shows each responder's snapshotted stake / voting power (with
 * turnout), `"one"` re-tallies the identical set with one vote per credential.
 * Only DRep/Stakeholder/Keyholder are covered here; the full, inclusive per-role
 * breakdown (SPO/CC included) lives in the raw view, one toggle away.
 *
 * Every float is derived presentation-side in `~/domain/results`.
 */
export const FinalResults: Component<{
  artifact: TallyArtifact;
  def: SurveyDefinition;
  keyStr: string;
  /** The survey's on-chain responses, to rejoin answers for the one-vote view. */
  responses: readonly ResponseRecord[];
  onShowRaw: () => void;
}> = (props) => {
  const [weighting, setWeighting] = createSignal<Weighting>("chain");
  const cancelled = () => props.artifact.tally.cancelled;
  const roles = createMemo(() =>
    artifactResults(props.artifact, props.def, props.responses, weighting()),
  );
  const endEpoch = () => props.artifact.tally.survey.endEpoch;
  const responderTotal = createMemo(() =>
    props.artifact.tally.perRole.reduce(
      (sum, r) => sum + r.responders.length,
      0,
    ),
  );
  // The content address, recomputed locally from the received body — what a
  // verifier reproduces; shown shortened, full value in the title attribute.
  const hash = createMemo(() => artifactHash(props.artifact.tally));

  const exportArtifact = (): void =>
    downloadJson(
      `tessera-${shortRef(props.keyStr)}-artifact.json`,
      JSON.stringify(props.artifact, null, 2),
    );

  // One entry per counted responder, weight reflecting the active switch (chain
  // weight, or 1). `weight_unit` names what the weight measures per role, since
  // it's heterogeneous (voting power vs active stake vs count).
  const exportVotesCsv = (): void => {
    const w = weighting();
    const measures = RULESET_DESCRIPTOR.roleMeasures as Record<string, string>;
    const byKey = new Map<string, SurveyResponse>();
    for (const rec of props.responses)
      byKey.set(`${rec.txHash}|${rec.responseIndex}`, rec.response);
    const entries = props.artifact.tally.perRole.flatMap((role) =>
      role.responders.map((r): CsvEntry => {
        // Sealed artifacts commit each responder's revealed answers; public and
        // legacy artifacts rejoin them from the on-chain response instead.
        const resp = byKey.get(`${r.txHash}|${r.responseIndex}`);
        return {
          disposition: "counted",
          role: role.role,
          credential: r.credential,
          weight: w === "one" ? 1n : BigInt(r.weight),
          weightUnit:
            w === "one" ? "count" : (measures[String(role.role)] ?? ""),
          txHash: r.txHash,
          responseIndex: r.responseIndex,
          answers:
            responderAnswers(r) ??
            (resp?.answers.type === "public" ? resp.answers.answers : null),
          sealed: resp !== undefined,
        };
      }),
    );
    downloadCsv(
      `tessera-${shortRef(props.keyStr)}-${w}.csv`,
      responsesCsv(entries),
    );
  };

  return (
    <>
      <InfoNote onShowRaw={props.onShowRaw} />

      {/* Export the raw artifact + a votes/weights CSV — available even for a
          cancelled survey (the artifact still records the cancellation). */}
      <div class={css.artifactActions}>
        <button class={css.artifactBtn} onClick={exportArtifact}>
          <span class={css.exportIcon}>⤓</span> {t("survey.exportArtifact")}
        </button>
        <button
          class={css.artifactBtn}
          classList={{ [css.artifactBtnDisabled]: responderTotal() === 0 }}
          disabled={responderTotal() === 0}
          onClick={exportVotesCsv}
        >
          <span class={css.exportIcon}>⤓</span> {t("survey.exportVotesCsv")}
        </button>
      </div>

      <Show
        when={!cancelled()}
        fallback={
          <TxNotice
            title={t("survey.weightedCancelledTitle")}
            hash={cancelled()!.txHash}
            body={t("survey.weightedCancelledBody", {
              epoch: n(cancelled()!.epoch),
            })}
          />
        }
      >
        {/* Weighting switch: same counted set, one vote each vs chain weight. */}
        <div class={css.roleFilterRow}>
          <span class={css.roleFilterLabel}>{t("survey.weightingLabel")}</span>
          <div class={css.roleFilterBtns}>
            <button
              class={css.roleFilterBtn}
              classList={{ [css.roleFilterBtnOn]: weighting() === "chain" }}
              onClick={() => setWeighting("chain")}
            >
              {t("survey.weightingChain")}
            </button>
            <button
              class={css.roleFilterBtn}
              classList={{ [css.roleFilterBtnOn]: weighting() === "one" }}
              onClick={() => setWeighting("one")}
            >
              {t("survey.weightingOne")}
            </button>
          </div>
        </div>

        <For each={roles()}>
          {(rv) => (
            <section>
              <div class={css.weightedRoleHead}>
                <span class={css.weightedRoleTitle}>{roleLabel(rv.role)}</span>
                <span class={css.weightedRoleMeta}>
                  {t("survey.weightedCounted", { n: n(rv.responderCount) })}
                  <Show when={rv.total !== null && rv.votedWeight !== null}>
                    {" · "}
                    {t("survey.weightedVotingWeight", {
                      ada: formatAda(rv.votedWeight!),
                    })}
                    <Show when={rv.turnout !== null}>
                      {" · "}
                      {t("survey.weightedTurnout", {
                        pct: (rv.turnout! * 100).toFixed(2),
                      })}
                    </Show>
                  </Show>
                </span>
              </div>
              <div class={css.questionResults}>
                <For each={rv.questions}>
                  {(results, i) => (
                    <QuestionResult
                      q={props.def.questions[i()]}
                      index={i()}
                      results={results}
                      responderCount={rv.responderCount}
                      meta={metaFor(rv.votedWeight !== null)}
                    />
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>

      <p class={css.tallyFootnote} title={hash()}>
        {t("survey.weightedFootnote", {
          epoch: n(endEpoch()),
          provider: props.artifact.provenance.source.provider,
          hash: `${hash().slice(0, 10)}…${hash().slice(-6)}`,
        })}
      </p>
    </>
  );
};
