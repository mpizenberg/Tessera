/**
 * Survey finalization (ARCHITECTURE.md §6.5/§7): once a survey's voting window
 * is safely past, snapshot every counted responder's weight at `end_epoch`,
 * compute the per-role weighted tally, and write the immutable
 * content-addressed artifact.
 *
 * Runs after every snapshot refresh (Node loop + Worker cron alike) and is
 * idempotent by construction:
 *  - weights aggregate **per epoch, not per survey** — the credential union of
 *    all surveys ending at E is fetched once, and `weight_snapshot` rows are
 *    written only when known, so the table is the resume cursor if a run is
 *    cut short (Worker subrequest cap) or a total is temporarily unavailable;
 *  - the artifact insert is INSERT-OR-IGNORE keyed by survey.
 *
 * A survey is emitted only when *complete*: every counted responder has a
 * weight row and every covered role has its electorate total. Sealed surveys
 * get their weights frozen the same way but no artifact yet
 * (TODO(sealed-artifact): emission awaits the reveal-aware tally).
 */

import { Role } from "cip-179";

import {
  artifactHash,
  bytesToHex,
  cancellationVerified,
  laterInChain,
  parseCredentialKey,
  refKey,
  rulesetHash,
  toArtifactQuestions,
  toArtifactResponders,
  voteDeadlineUnix,
  weightedTallySurvey,
  type ArtifactRoleTally,
  type ChainTip,
  type Cip179Records,
  type SurveyRecord,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type TxProof,
  type WeightedResponder,
} from "@tessera/core";

import type { ServerConfig } from "./config";
import type { TallyStore, ValidatedResponseRow, WeightRow } from "./store";

/** Roles artifacts cover (must match core's RULESET_DESCRIPTOR). */
const COVERED_ROLES: readonly number[] = [
  Role.DRep,
  Role.Stakeholder,
  Role.Keyholder,
];

/** Safety margin past the epoch boundary: Koios indexing lag + shallow reorgs. */
const FINALIZE_MARGIN_SECONDS = 600;

/** How each covered role's weights were sourced (artifact provenance). */
const ROLE_ENDPOINTS: Record<number, string> = {
  [Role.DRep]: "drep_voting_power_history",
  [Role.Stakeholder]: "account_stake_history",
  [Role.Keyholder]: "local-count",
};

export async function finalizeClosedSurveys(
  config: ServerConfig,
  store: TallyStore,
  inputs: TallyInputSource,
  source: Pick<import("@tessera/koios").KoiosDataSource, "txProofs">,
  records: Cip179Records,
  tip: ChainTip,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const spe = config.app.secondsPerEpoch;
  const finalized = await store.finalizedSurveyKeys();

  const candidates = records.surveys.filter(
    (s) =>
      tip.epoch > s.definition.endEpoch &&
      nowSec >=
        voteDeadlineUnix(s.definition.endEpoch, tip, spe) +
          FINALIZE_MARGIN_SECONDS &&
      !finalized.has(refKey(s.ref)),
  );
  if (candidates.length === 0) return;

  // --- cancelled surveys: a cancellation artifact, no weight work ------------
  // The snapshot keeps `proof: null` for cancellations of closed surveys (the
  // scan only verifies open ones), so re-fetch the proofs here.
  const open = await withCancellations(
    config,
    store,
    source,
    records,
    candidates,
    nowSec,
  );

  // --- weight snapshotting, per end epoch ------------------------------------
  const byEpoch = new Map<number, SurveyRecord[]>();
  for (const s of open) {
    const list = byEpoch.get(s.definition.endEpoch);
    if (list) list.push(s);
    else byEpoch.set(s.definition.endEpoch, [s]);
  }

  for (const [epoch, surveys] of byEpoch) {
    // Counted rows per survey (rules 1–3 verdicts joined at tally time).
    const countedBySurvey = new Map<string, ValidatedResponseRow[]>();
    for (const s of surveys) {
      countedBySurvey.set(
        refKey(s.ref),
        await countedRows(store, refKey(s.ref), epoch),
      );
    }

    // Union of counted credentials per role across all surveys ending at E.
    const credsByRole = new Map<number, Set<string>>();
    for (const rows of countedBySurvey.values()) {
      for (const r of rows) {
        let set = credsByRole.get(r.role);
        if (!set) credsByRole.set(r.role, (set = new Set()));
        set.add(r.credential);
      }
    }

    // Fill only missing weight rows; existing rows are the resume cursor.
    const weightByRole = new Map<number, Map<string, WeightRow>>();
    for (const [role, creds] of credsByRole) {
      weightByRole.set(
        role,
        await fillWeights(store, inputs, epoch, role, creds, nowSec),
      );
    }

    // Fill missing electorate totals (null = upstream can't serve it → retry).
    const totalByRole = new Map<number, string | null>();
    for (const role of credsByRole.keys()) {
      totalByRole.set(
        role,
        await fillTotal(store, inputs, epoch, role, nowSec),
      );
    }

    // --- emit, one survey at a time, only when complete -----------------------
    for (const s of surveys) {
      const key = refKey(s.ref);
      if (s.definition.submissionMode.type === "sealed") {
        // Weights are frozen above; emission awaits the reveal-aware tally.
        // TODO(sealed-artifact)
        console.log(`finalize: ${key} is sealed — weights frozen, no artifact`);
        continue;
      }
      const rows = countedBySurvey.get(key)!;
      const missing = incompleteReason(rows, weightByRole, totalByRole);
      if (missing) {
        console.warn(`finalize: ${key} postponed — ${missing}`);
        continue;
      }
      const artifact = buildArtifact(
        config,
        s,
        rows,
        records,
        weightByRole,
        totalByRole,
        nowSec,
      );
      await store.putArtifact({
        surveyKey: key,
        endEpoch: s.definition.endEpoch,
        artifactHash: artifact.hash,
        artifact: artifact.json,
        createdAt: nowSec,
      });
      console.log(`finalize: ${key} → artifact ${artifact.hash}`);
    }
  }
}

/**
 * Emit cancellation artifacts for candidates with an owner-proven, in-window
 * cancellation; return the remaining (non-cancelled) candidates.
 */
async function withCancellations(
  config: ServerConfig,
  store: TallyStore,
  source: Pick<import("@tessera/koios").KoiosDataSource, "txProofs">,
  records: Cip179Records,
  candidates: readonly SurveyRecord[],
  nowSec: number,
): Promise<SurveyRecord[]> {
  const candidateKeys = new Set(candidates.map((s) => refKey(s.ref)));
  const relevant = records.cancellations.filter((c) =>
    candidateKeys.has(refKey(c.target)),
  );
  if (relevant.length === 0) return [...candidates];

  const proofs: Map<string, TxProof | null> = await source.txProofs([
    ...new Set(relevant.map((c) => c.txHash)),
  ]);

  const open: SurveyRecord[] = [];
  for (const s of candidates) {
    const key = refKey(s.ref);
    // The recorded cancellation must be reproducible by a verifier, so the
    // choice among several verified ones is pinned by the ruleset: earliest
    // in chain order (slot, then tx hash).
    const winning = [...relevant]
      .sort((a, b) => a.slot - b.slot || (a.txHash < b.txHash ? -1 : 1))
      .find(
        (c) =>
          refKey(c.target) === key &&
          c.epochNo <= s.definition.endEpoch && // CIP-179: in-window only
          cancellationVerified(
            s.definition.owner,
            proofs.get(c.txHash) ?? null,
          ),
      );
    if (!winning) {
      open.push(s);
      continue;
    }
    const body: TallyBody = {
      rulesetHash: rulesetHash(),
      network: config.app.network,
      survey: surveyIdOf(s),
      sealed: false,
      cancelled: {
        txHash: winning.txHash,
        slot: winning.slot,
        epoch: winning.epochNo,
      },
      perRole: [],
    };
    const artifact: TallyArtifact = {
      tally: body,
      provenance: {
        source: { provider: "koios", baseUrl: config.app.koiosUrl },
        fetchedAt: nowSec,
        byRole: [],
      },
    };
    await store.putArtifact({
      surveyKey: key,
      endEpoch: s.definition.endEpoch,
      artifactHash: artifactHash(body),
      artifact: JSON.stringify(artifact),
      createdAt: nowSec,
    });
    console.log(`finalize: ${key} cancelled by ${winning.txHash}`);
  }
  return open;
}

/** The §6.3 counted set for one survey: valid, proven, in-window, deduped. */
async function countedRows(
  store: TallyStore,
  surveyKey: string,
  endEpoch: number,
): Promise<ValidatedResponseRow[]> {
  const rows = await store.validatedForSurvey(surveyKey);
  const eligible: ValidatedResponseRow[] = [];
  for (const r of rows) {
    if (!r.wellFormed || r.epochNo > endEpoch) continue;
    if (r.proofOk === null) {
      // Enrichment still pending (retried each refresh) — excluded this round.
      console.warn(
        `finalize: ${surveyKey} response ${r.txHash}:${r.responseIndex} has no proof verdict yet — excluded`,
      );
      continue;
    }
    if (!r.proofOk) continue;
    if (!COVERED_ROLES.includes(r.role)) {
      console.warn(
        `finalize: ${surveyKey} drops role-${r.role} response ${r.txHash} (SPO/CC weighting deferred)`,
      );
      continue;
    }
    eligible.push(r);
  }
  // Latest-wins per (role, credential) — same order the ruleset pins.
  const best = new Map<string, ValidatedResponseRow>();
  for (const r of eligible) {
    const id = `${r.role}|${r.credential}`;
    const prev = best.get(id);
    if (!prev || laterInChain(r, prev)) best.set(id, r);
  }
  return [...best.values()];
}

/** Ensure a weight row exists for every credential; return the row map. */
async function fillWeights(
  store: TallyStore,
  inputs: TallyInputSource,
  epoch: number,
  role: number,
  credentials: ReadonlySet<string>,
  nowSec: number,
): Promise<Map<string, WeightRow>> {
  const have = new Map(
    (await store.weightRows(epoch, role)).map((r) => [r.credential, r]),
  );
  const missing = [...credentials].filter((c) => !have.has(c));
  if (missing.length === 0) return have;

  let fetched: WeightRow[];
  if (role === Role.Keyholder) {
    // Count-only role: one responder, one vote — no chain lookup.
    fetched = missing.map((credential) => ({
      epoch,
      role,
      credential,
      weight: "1",
      registered: true,
      fetchedAt: nowSec,
    }));
  } else {
    const creds = missing.map(parseCredentialKey);
    const infos =
      role === Role.DRep
        ? await inputs.drepWeights(epoch, creds)
        : await inputs.stakeholderWeights(epoch, creds);
    fetched = missing.map((credential) => {
      const info = infos.get(credential);
      if (!info) throw new Error(`no weight info for ${credential}`);
      return {
        epoch,
        role,
        credential,
        weight: String(info.weight),
        registered: info.registered,
        fetchedAt: nowSec,
      };
    });
  }
  await store.upsertWeightRows(fetched);
  for (const r of fetched) have.set(r.credential, r);
  return have;
}

/** Ensure the (epoch, role) total exists when fetchable; null = retry later. */
async function fillTotal(
  store: TallyStore,
  inputs: TallyInputSource,
  epoch: number,
  role: number,
  nowSec: number,
): Promise<string | null> {
  if (role === Role.Keyholder) return null; // count-only: no electorate total
  const existing = await store.epochTotal(epoch, role);
  if (existing !== null) return existing;
  const total =
    role === Role.DRep
      ? await inputs.drepTotal(epoch)
      : await inputs.stakeholderTotal(epoch);
  if (total === null) return null;
  await store.putEpochTotal(
    epoch,
    role,
    String(total),
    role === Role.DRep ? "drep_epoch_summary" : "epoch_info",
    nowSec,
  );
  return String(total);
}

/** Why a survey can't be emitted yet, or null when complete. */
function incompleteReason(
  rows: readonly ValidatedResponseRow[],
  weightByRole: ReadonlyMap<number, ReadonlyMap<string, WeightRow>>,
  totalByRole: ReadonlyMap<number, string | null>,
): string | null {
  for (const r of rows) {
    if (!weightByRole.get(r.role)?.has(r.credential)) {
      return `weight for ${r.credential} (role ${r.role}) not snapshotted yet`;
    }
  }
  for (const role of new Set(rows.map((r) => r.role))) {
    if (role !== Role.Keyholder && totalByRole.get(role) == null) {
      return `role-${role} electorate total unavailable (retrying)`;
    }
  }
  return null;
}

function surveyIdOf(s: SurveyRecord): TallyBody["survey"] {
  return {
    txId: bytesToHex(s.ref.txId),
    index: s.ref.index,
    endEpoch: s.definition.endEpoch,
  };
}

/** Assemble the weighted-tally artifact for one complete survey. */
function buildArtifact(
  config: ServerConfig,
  s: SurveyRecord,
  rows: readonly ValidatedResponseRow[],
  records: Cip179Records,
  weightByRole: ReadonlyMap<number, ReadonlyMap<string, WeightRow>>,
  totalByRole: ReadonlyMap<number, string | null>,
  nowSec: number,
): { json: string; hash: string } {
  // Join each counted row back to its full response payload (the validation
  // table stores verdicts, not answers).
  const responseByKey = new Map(
    records.responses.map((r) => [`${r.txHash}:${r.responseIndex}`, r]),
  );

  const rolesPresent = [...new Set(rows.map((r) => r.role))].sort(
    (a, b) => a - b,
  );
  const perRole: ArtifactRoleTally[] = [];
  for (const role of rolesPresent) {
    const responders: WeightedResponder[] = [];
    for (const r of rows) {
      if (r.role !== role) continue;
      const weight = weightByRole.get(role)?.get(r.credential);
      const record = responseByKey.get(`${r.txHash}:${r.responseIndex}`);
      if (!weight || !record) continue; // guarded by incompleteReason
      if (!weight.registered) {
        // §6.1: membership at end_epoch is a hard filter (weight-0 registered
        // credentials stay counted; unregistered ones don't).
        console.warn(
          `finalize: ${refKey(s.ref)} drops unregistered ${r.credential}`,
        );
        continue;
      }
      responders.push({
        credentialKey: r.credential,
        weight: BigInt(weight.weight),
        txHash: r.txHash,
        response: record.response,
      });
    }
    perRole.push({
      role,
      total: totalByRole.get(role) ?? null,
      responders: toArtifactResponders(responders),
      questions: toArtifactQuestions(
        weightedTallySurvey(s.definition, responders),
      ),
    });
  }

  const tally: TallyBody = {
    rulesetHash: rulesetHash(),
    network: config.app.network,
    survey: surveyIdOf(s),
    sealed: false,
    perRole,
  };
  const artifact: TallyArtifact = {
    tally,
    provenance: {
      source: { provider: "koios", baseUrl: config.app.koiosUrl },
      fetchedAt: nowSec,
      byRole: rolesPresent.map((role) => ({
        role,
        endpoint: ROLE_ENDPOINTS[role] ?? "unknown",
      })),
    },
  };
  return { json: JSON.stringify(artifact), hash: artifactHash(tally) };
}
