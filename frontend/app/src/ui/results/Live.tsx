/**
 * The pre-artifact tally: computed in the browser from the counted on-chain
 * responses, for a public survey still open (or one whose sealed responses the
 * viewer just revealed).
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  type Component,
} from "solid-js";
import {
  bytesToHex,
  proofVerdictKey,
  serializeAnswer,
  type ExcludedRecord,
  type ProofVerdicts,
  type ResponseRecord,
} from "cip-179/domain";
import type { SurveyDefinition, SurveyResponse } from "cip-179";

import { useApp } from "~/state";
import {
  roleBreakdown,
  tallySurvey,
  type QuestionTally,
} from "~/domain/displayTally";
import { roleLabel, shortRef } from "~/ui/format";
import { toCsv, downloadCsv } from "~/util/csv";
import { t, n } from "~/i18n";
import { QuestionResult } from "./cards";
import {
  ExclusionPanel,
  summarizeExclusions,
  type ExclusionSummary,
} from "./Exclusions";
import { IndividualResponses } from "./Individual";
import { InfoNote } from "./parts";
import css from "./results.module.css";

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

/**
 * The tally view, shared by public surveys and revealed sealed surveys. Takes
 * already-plaintext response records (for sealed, these are the decrypted
 * ones), owns the role filter and CSV export, and renders the per-question
 * widgets.
 */
export const LiveResults: Component<{
  def: SurveyDefinition;
  keyStr: string;
  records: ResponseRecord[];
  /**
   * Excluded records, tagged with reason — the single source for both the CSV
   * export and the (derived) count breakdown shown in {@link ExclusionPanel}.
   */
  excludedRecords: readonly ExcludedRecord[];
  /**
   * The serving tier's decided proof verdicts, when the source ships them —
   * presence switches the exclusion panel to its proof-checked copy, and
   * counted records with no verdict yet surface as "awaiting verification".
   */
  verdicts?: ProofVerdicts | undefined;
}> = (props) => {
  const app = useApp();
  // Roles are independent electorates, so there is no "all roles" tally — the
  // view always shows exactly one role. `pickedRole` is the user's explicit
  // choice; `roleFilter` falls back to the first responded role when nothing
  // is picked yet (or the picked role no longer has responses after a refresh).
  const [pickedRole, setPickedRole] = createSignal<number | null>(null);
  const [exclOpen, setExclOpen] = createSignal(false);
  // Reset when navigating between surveys (the component instance is reused).
  createEffect(
    on(
      () => props.keyStr,
      () => {
        setPickedRole(null);
        setExclOpen(false);
      },
      { defer: true },
    ),
  );
  const excludedTotal = (): number => props.excludedRecords.length;
  const exclusionSummary = (): ExclusionSummary[] =>
    summarizeExclusions(props.excludedRecords, props.def.endEpoch);
  // Tallied responses the serving tier hasn't reached a proof verdict on.
  // Undefined when the source ships no verdicts at all (direct Koios) — then
  // nothing is claimed either way.
  const pendingProofs = (): number | undefined =>
    props.verdicts &&
    props.records.filter(
      (r) => props.verdicts![proofVerdictKey(r)] === undefined,
    ).length;

  const publicResponses = createMemo<SurveyResponse[]>(() =>
    props.records
      .map((r) => r.response)
      .filter((r) => r.answers.type === "public"),
  );
  const roleCounts = createMemo(() =>
    roleBreakdown(props.records.map((r) => r.response)),
  );
  const roleFilter = createMemo<number | null>(() => {
    const counts = roleCounts();
    const picked = pickedRole();
    if (picked !== null && counts.some((rc) => rc.role === picked))
      return picked;
    return counts[0]?.role ?? null;
  });
  const filtered = createMemo<SurveyResponse[]>(() =>
    publicResponses().filter((r) => r.role === roleFilter()),
  );
  // Same role filter, but keeping the full record (tx hash) for the per-response
  // breakdown. Mirrors `filtered`, which drops down to bare responses for tallying.
  const filteredRecords = createMemo<ResponseRecord[]>(() =>
    props.records.filter((r) => r.response.role === roleFilter()),
  );
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
        <Show when={(pendingProofs() ?? 0) > 0}>
          <span class={css.pendingPill}>
            {t("survey.pendingProofs", { n: n(pendingProofs()!) })}
          </span>
        </Show>
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

      <Show when={app.list()?.incomplete}>
        <div class={css.incomplete}>{t("survey.incomplete")}</div>
      </Show>

      <Show when={exclOpen() && excludedTotal() > 0}>
        <ExclusionPanel
          excluded={exclusionSummary()}
          endEpoch={props.def.endEpoch}
          proofChecked={props.verdicts !== undefined}
        />
      </Show>

      {/* informational note — these raw counts are indicative, not a verdict */}
      <InfoNote />

      {/* role picker — one role at a time, no combined tally across roles */}
      <Show when={roleCounts().length > 0}>
        <div class={css.roleFilterRow}>
          <span class={css.roleFilterLabel}>{t("survey.roleFilterLabel")}</span>
          <div class={css.roleFilterBtns}>
            <For each={roleCounts()}>
              {(rc) => (
                <RoleFilterBtn
                  label={roleLabel(rc.role)}
                  count={rc.count}
                  on={roleFilter() === rc.role}
                  onClick={() => setPickedRole(rc.role)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>

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
