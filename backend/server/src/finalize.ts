/**
 * Survey finalization (ARCHITECTURE.md §6.2, TALLY-SPEC.md §5): once a survey's voting window
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
 *  - sealed reveal has the same cursor in `sealed_reveal`: each ciphertext's
 *    outcome is written as it is decrypted, so a pass that runs out of decrypt
 *    budget mid-survey resumes rather than starting the survey over;
 *  - the artifact insert is INSERT-OR-IGNORE keyed by survey.
 *
 * A survey is emitted only when *complete*: every counted-candidate response
 * has a final proof verdict and block index, every counted responder has a
 * weight row, and every covered role has its electorate total. Any of these
 * still pending postpones emission to a later cron (artifacts are immutable, so
 * emitting early would freeze a legitimately valid response out forever) — and
 * a postponed survey is what holds the pass's floor down, since the floor is
 * exactly "the oldest epoch still holding something to decide".
 * Sealed surveys additionally wait for their drand round to publish, then
 * decrypt their in-window responses — over as many passes as the decrypt budget
 * needs — and tally the revealed answers; a sealed survey on an unsupported
 * (non-quicknet) drand chain is skipped forever.
 */

import { isSurveyTalliable, Role, type SurveyResponse } from "cip-179";

import {
  auditRevealedResponses,
  byCancellationChainOrder,
  bytesToHex,
  mechanismAProven,
  laterInChain,
  parseCredentialKey,
  refKey,
  scriptCredentialHash,
  voteDeadlineUnix,
  type CancellationRecord,
  type ChainTip,
  type GovLink,
  type ResponseRecord,
  type SurveyRecord,
  type TxProof,
} from "cip-179/domain";
import {
  RULESET_DESCRIPTOR,
  artifactHash,
  assembleTallyBody,
  cancelledTallyBody,
  fromJsonSafe,
  toJsonSafe,
  type RoleTally,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type WeightedResponder,
} from "cip-179/tally";
import { isQuicknet, roundIsAvailable } from "cip-179/tlock";

import type { ServerConfig } from "./config";
import { tlockSealedReveal, type SealedRevealFn } from "./sealedReveal";
import type {
  ArtifactKeys,
  SealedRevealRow,
  SnapshotStore,
  TallyStore,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import { validationKey } from "./store";

/** The tally seam plus the stored-row reads the candidate walk needs. */
export type FinalizeStore = TallyStore &
  Pick<SnapshotStore, "unfinalizedClosedSurveyRows" | "responseRowsForSurveys">;

/**
 * Per-pass cap on sealed decryptions across all surveys — the decrypt share of
 * the CPU one cron invocation gets (`wrangler.toml`). One `decryptWithBeacon`
 * measures ~20 ms on workerd, so this is ~3 s there and ~9 s on a core three
 * times slower: under a third of the ceiling, leaving the rest of the pass its
 * parsing, proof checks and hashing. No survey is too big for it — outcomes are
 * persisted per response as they are decrypted, so spending the cap mid-survey
 * just resumes next pass.
 */
const MAX_SEALED_DECRYPTS_PER_PASS = 150;

/**
 * A reveal outcome as the cursor stores it: the decrypted response in the wire
 * form the artifact commits, or null for a ciphertext that didn't decrypt or
 * didn't decode.
 */
function encodeRevealed(response: SurveyResponse | null): string | null {
  return response === null ? null : JSON.stringify(toJsonSafe(response));
}

function decodeRevealed(stored: string | null): SurveyResponse | null {
  return stored === null
    ? null
    : (fromJsonSafe(JSON.parse(stored)) as SurveyResponse);
}

/**
 * Roles artifacts cover — derived from the hashed ruleset descriptor (not a
 * hand-kept copy) so the emitter can't drift from the verifier, which reads the
 * same source (finding 29).
 */
const COVERED_ROLES: readonly number[] = [...RULESET_DESCRIPTOR.coveredRoles];

/**
 * Reorg depth past the vote deadline (~30 blocks), measured on the covered
 * chain prefix. Indexing lag is not this margin's job: the epoch gate covers
 * it, since the tip cannot outrun the indexer it is read from.
 */
const FINALIZE_MARGIN_SECONDS = 600;

/** Refs named in the untalliable summary before it degrades to a count. */
const UNTALLIABLE_LOG_REFS = 10;

/** How each covered role's weights were sourced (artifact provenance). */
const ROLE_ENDPOINTS: Record<number, string> = {
  [Role.DRep]: "drep_voting_power_history",
  [Role.Stakeholder]: "account_stake_history",
  [Role.Keyholder]: "local-count",
};

/** What one refresh hands the pass about the state it runs against. */
export interface FinalizeGates {
  readonly tip: ChainTip;
  /**
   * The scan couldn't be trusted to be whole — a dropped metadata batch or a
   * catch-up run. Nothing finalizes.
   */
  readonly incomplete: boolean;
  /** The instant the integrated prefix reaches; null before any cursor. */
  readonly coveredThroughUnix: number | null;
  /**
   * The governance pass's frontier: a candidate whose expiration is at or above
   * it still has links in motion and waits, while below it the candidate row's
   * own slice is the settled set an artifact may commit to.
   */
  readonly settlementFloor: number;
  /**
   * This pass's own frontier: the lowest end epoch that still holds a survey to
   * decide. Everything below it is finalized or permanently untalliable, so the
   * candidate read skips it.
   */
  readonly finalizationFloor: number;
}

/** What the pass leaves behind: what it emitted, and where its frontier now is. */
export interface FinalizeOutcome {
  /**
   * The artifacts this pass emitted, as key sets — what the refresh stamps
   * the cancelled overlay from without reading `tally_artifact` back.
   */
  readonly emitted: ArtifactKeys;
  /**
   * The finalization floor to bank, or null when the pass decided nothing and
   * the banked one must stand.
   */
  readonly floor: number | null;
}

export async function finalizeClosedSurveys(
  config: ServerConfig,
  store: FinalizeStore,
  inputs: TallyInputSource,
  source: Pick<import("cardano-tessera-koios").KoiosDataSource, "txProofs">,
  gates: FinalizeGates,
  reveal: SealedRevealFn = tlockSealedReveal,
): Promise<FinalizeOutcome> {
  const { tip, incomplete, coveredThroughUnix, settlementFloor } = gates;
  const artifactKeys: ArtifactKeys = {
    finalized: new Set(),
    cancelled: new Set(),
  };
  // An incomplete scan (a dropped metadata batch or the page cap) may be
  // missing a responder tx or a cancellation for *any* survey, and we can't tell
  // which — so no artifact this refresh is safe to hash. Postpone all of them.
  if (incomplete) {
    console.warn("finalize: snapshot incomplete — skipping finalization");
    return { emitted: artifactKeys, floor: null };
  }
  // Nothing integrated yet (fresh database, first run failed): nothing is
  // safely past its deadline on the covered prefix.
  if (coveredThroughUnix === null) {
    console.warn("finalize: no scan cursor banked — skipping finalization");
    return { emitted: artifactKeys, floor: null };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const spe = config.app.secondsPerEpoch;

  // Candidates come from the stored rows — closed at this tip, no artifact
  // yet, from the frontier up — revived from their wire JSON. Each row also
  // carries every cancellation targeting its survey, which is exactly the
  // evidence the cancellation walk below needs. A survey finalizes only once
  // the scan cursor has covered its vote deadline plus the reorg margin: the
  // covered instant can never exceed the wall clock, and during catch-up a
  // survey's responses may not all be integrated yet.
  const candidateRows = await store.unfinalizedClosedSurveyRows(
    gates.finalizationFloor,
    tip.epoch,
  );
  // Where the frontier stands once this pass is done: the lowest epoch still
  // holding a candidate it expects to decide. A survey it *decided* — emitted,
  // or judged permanently untalliable — stops holding the floor down and drops
  // out of the candidate set for good, which is what keeps the read bounded
  // rather than growing with the residue that never produces an artifact.
  const undecided = new Map(
    candidateRows.map((r) => [r.surveyKey, r.endEpoch]),
  );
  const settle = (): FinalizeOutcome => {
    for (const key of artifactKeys.finalized) undecided.delete(key);
    let floor = tip.epoch;
    for (const endEpoch of undecided.values())
      floor = Math.min(floor, endEpoch);
    return { emitted: artifactKeys, floor };
  };
  const cancellationsByKey = new Map(
    candidateRows.map((r) => [
      r.surveyKey,
      fromJsonSafe(JSON.parse(r.cancellations)) as CancellationRecord[],
    ]),
  );
  // An artifact's provenance is an immutable record of what its verdicts were
  // built on, so it may only be stamped with a *settled* link set: below the
  // settlement floor an epoch is decided for good and the row's slice is that
  // decision, while at or above it an anchor still resolving could add a link
  // tomorrow. Postponing is cheap — the pass is idempotent, and an epoch
  // settles within one of them of the survey's close.
  const linksByKey = new Map(
    candidateRows.map((r) => [
      r.surveyKey,
      JSON.parse(r.govLinks) as GovLink[],
    ]),
  );
  let unsettledLinks = 0;
  const candidates = candidateRows
    .map((r) => fromJsonSafe(JSON.parse(r.record)) as SurveyRecord)
    .filter((s) => {
      if (s.definition.endEpoch + 1 >= settlementFloor) {
        unsettledLinks++;
        return false;
      }
      return (
        coveredThroughUnix >=
        voteDeadlineUnix(s.definition.endEpoch, tip, spe) +
          FINALIZE_MARGIN_SECONDS
      );
    });
  if (unsettledLinks > 0) {
    console.log(
      `finalize: ${unsettledLinks} survey(s) postponed — governance links not settled`,
    );
  }
  if (candidates.length === 0) return settle();

  // Spec-invalid surveys are untalliable (findings 10, 11, 45, 12): a non-v5 or
  // structurally-invalid definition, one whose end_epoch is not past its own
  // inclusion epoch, or one whose defining transaction never proved the `owner`
  // credential produces NO artifact — it is never tallied under v5 semantics,
  // and an independent verifier reaches the same untalliable verdict from the
  // same on-chain record. Drop them before any cancellation or weight work (an
  // invalid definition is not a valid survey to begin with, so invalidity takes
  // precedence over cancellation). The `definition-validity` rule in
  // RULESET_DESCRIPTOR pins this gate.
  //
  // The gate runs twice, because only its `owner` rule reads evidence: once on
  // the bare record to shed what no proof could rescue, then again once the
  // proofs are attached. Proving first instead would re-fetch the CBOR of every
  // structurally-invalid survey on every refresh, forever — they produce no
  // artifact, so nothing ever retires them from the candidate set.
  const untalliable: string[] = [];
  const needEvidence = candidates.filter((s) => {
    if (isSurveyTalliable(s)) return true;
    untalliable.push(refKey(s.ref));
    undecided.delete(refKey(s.ref));
    return false;
  });
  // One line rather than one per survey: a floor reset re-reads the whole
  // archive, and every spec-invalid definition in it reaches this verdict again
  // in that one pass.
  if (untalliable.length > 0) {
    const shown = untalliable.slice(0, UNTALLIABLE_LOG_REFS);
    const rest = untalliable.length - shown.length;
    console.warn(
      `finalize: ${untalliable.length} definition(s) spec-invalid — untalliable, no artifact: ` +
        shown.join(", ") +
        (rest > 0 ? `, +${rest} more` : ""),
    );
  }
  if (needEvidence.length === 0) return settle();

  const talliable: SurveyRecord[] = [];
  for (const s of await withOwnerProofs(source, needEvidence)) {
    // An owner-proof we couldn't read is unknown, not disproven, and freezing an
    // artifact on it would either count a forged survey or bury a real one.
    if (!s.proof) {
      console.warn(
        `finalize: ${refKey(s.ref)} postponed — owner proof unknown (fetch/decode failed)`,
      );
      continue;
    }
    if (!isSurveyTalliable(s)) {
      console.warn(
        `finalize: ${refKey(s.ref)} owner credential unproven — untalliable, no artifact`,
      );
      undecided.delete(refKey(s.ref));
      continue;
    }
    talliable.push(s);
  }
  if (talliable.length === 0) return settle();

  // --- cancelled surveys: a cancellation artifact, no weight work ------------
  // The snapshot keeps `proof: null` for cancellations of closed surveys (the
  // scan only verifies open ones), so re-fetch the proofs here.
  const notCancelled = await withCancellations(
    config,
    store,
    source,
    cancellationsByKey,
    talliable,
    nowSec,
    artifactKeys,
  );

  // A sealed survey on a drand chain the bundled tlock can't decrypt is
  // permanently unrevealable — its votes are undecryptable forever (vote-time
  // guard aside, an old survey may predate it). Drop it entirely: no weight
  // work, no artifact, and decided as far as the floor is concerned.
  const open = notCancelled.filter((s) => {
    const mode = s.definition.submissionMode;
    if (mode.type === "sealed" && !isQuicknet(mode.chainHash)) {
      console.warn(
        `finalize: ${refKey(s.ref)} sealed on unsupported drand chain — skipped (no artifact)`,
      );
      undecided.delete(refKey(s.ref));
      return false;
    }
    return true;
  });

  // A counted row joins back to its full response payload at emit time; if the
  // stored rows no longer carry that response (it was swept or a batch dropped
  // it) the artifact would silently omit a counted responder — so postpone
  // instead. Only the surviving candidates' responses are read: membership is
  // judged per survey, and a validated row can only reference its own survey's
  // responses (both key the same content-addressed tx).
  const responseByKey = new Map<string, ResponseRecord>();
  for (const row of await store.responseRowsForSurveys(
    open.map((s) => refKey(s.ref)),
  )) {
    responseByKey.set(
      `${row.txHash}:${row.responseIndex}`,
      fromJsonSafe(JSON.parse(row.record)) as ResponseRecord,
    );
  }
  const presentResponses = new Set(responseByKey.keys());

  // --- weight snapshotting, per end epoch ------------------------------------
  const byEpoch = new Map<number, SurveyRecord[]>();
  for (const s of open) {
    const list = byEpoch.get(s.definition.endEpoch);
    if (list) list.push(s);
    else byEpoch.set(s.definition.endEpoch, [s]);
  }

  // Sealed decrypt budget is pass-wide (across every end epoch), so one cron
  // never decrypts more than the cap in total.
  let sealedDecryptBudget = MAX_SEALED_DECRYPTS_PER_PASS;

  for (const [epoch, surveys] of byEpoch) {
    // Per-epoch isolation, mirroring the per-survey guard below: the shared
    // inputs are read from Koios, and an account whose history can't be resolved
    // (or a store hiccup) must postpone only the surveys ending at this epoch —
    // not starve every other epoch of finalization for the whole pass.
    const prepared = await prepareEpoch(
      store,
      inputs,
      epoch,
      surveys,
      nowSec,
    ).catch((err) => {
      console.warn(
        `finalize: epoch ${epoch} skipped this pass — ${String(err)}`,
      );
      return null;
    });
    if (!prepared) continue;
    const { countedBySurvey, weightByRole, totalByRole } = prepared;

    // --- emit, one survey at a time, only when complete -----------------------
    // A counted/eligible row whose tx is no longer in the (complete — see the
    // `incomplete` guard above) stored rows was reorged out: the fixed scan
    // floor means it can't age back in, and validated_response rows are never
    // otherwise pruned, so leaving it would postpone this survey on *every*
    // future refresh, forever (finding 3). Treat snapshot membership as
    // authoritative: prune the stale row(s) and postpone one more refresh. That
    // one refresh is the reorg buffer — if the tx re-appears next scan it's
    // re-validated (the row is uncompleted again) and counted; if it stays gone
    // the row is now absent, so the survey emits. Returns true = pruned/postpone.
    const pruneReorgedOut = async (
      key: string,
      rows: readonly ValidatedResponseRow[],
    ): Promise<boolean> => {
      const absent = rows.filter(
        (r) => !presentResponses.has(`${r.txHash}:${r.responseIndex}`),
      );
      if (absent.length === 0) return false;
      await store.deleteValidatedResponses(
        absent.map((r) => ({
          txHash: r.txHash,
          responseIndex: r.responseIndex,
        })),
      );
      for (const r of absent) {
        console.warn(
          `finalize: ${key} pruned reorged-out response ${r.txHash}:${r.responseIndex}`,
        );
      }
      return true;
    };

    for (const s of surveys) {
      const key = refKey(s.ref);
      // Per-survey isolation: a poisoned definition (e.g. a tally that throws)
      // must not abort the whole pass and starve every later survey of
      // finalization. Any escape here skips just this survey; it retries next
      // refresh (idempotent), and a permanently-broken one simply never
      // finalizes — its own problem, not the finalizer's.
      try {
        const mode = s.definition.submissionMode;
        const { counted, eligible, pending } = countedBySurvey.get(key)!;
        // The epoch-aligned link set the mechanism-B verdicts were built on,
        // committed to the artifact's provenance so a re-verifier can diff its
        // own (finding 6). Same filter+sort as validate's `linkSetKey`.
        const linkedActionIds = (linksByKey.get(key) ?? [])
          .filter((l) => l.endEpoch === s.definition.endEpoch)
          .map((l) => l.actionId)
          .sort();

        if (mode.type === "sealed") {
          // Weights are frozen above (R1). Wait for the drand round to publish,
          // then reveal + tally the PRE-dedup set (finding 2: dedup runs after
          // reveal-time validation, in auditRevealedResponses).
          if (!roundIsAvailable(mode.round, nowSec)) {
            console.log(
              `finalize: ${key} sealed reveal postponed — round ${mode.round} not yet available`,
            );
            continue;
          }
          if (await pruneReorgedOut(key, eligible)) continue;
          if (pending) {
            console.warn(`finalize: ${key} postponed — ${pending}`);
            continue;
          }
          // Join each eligible row to its on-chain response (carrying the sealed
          // ciphertext). A miss means the snapshot dropped it — postpone.
          const inWindow: ResponseRecord[] = [];
          let missingRecord: string | null = null;
          for (const r of eligible) {
            const rec = responseByKey.get(`${r.txHash}:${r.responseIndex}`);
            if (!rec) {
              missingRecord = `${r.txHash}:${r.responseIndex}`;
              break;
            }
            inWindow.push(rec);
          }
          if (missingRecord) {
            console.warn(
              `finalize: ${key} postponed — response ${missingRecord} missing from snapshot`,
            );
            continue;
          }
          // Decrypt only what this survey hasn't already recorded, and only as
          // far as the pass-wide budget reaches. The remainder resumes next
          // refresh, so no survey is too big to finalize — it just takes as many
          // passes as its ciphertext count needs.
          const outcomes = await store.sealedReveals(key);
          const todo = inWindow.filter(
            (r) => !outcomes.has(validationKey(r.txHash, r.responseIndex)),
          );
          if (todo.length > 0 && sealedDecryptBudget === 0) {
            console.log(
              `finalize: ${key} sealed reveal postponed — decrypt budget spent this pass`,
            );
            continue;
          }
          const batch = todo.slice(0, sealedDecryptBudget);
          sealedDecryptBudget -= batch.length;
          let result;
          try {
            // Called even with nothing left to decrypt: the beacon it fetches
            // and BLS-verifies is what the artifact's provenance commits.
            result = await reveal(batch, { round: mode.round });
          } catch (err) {
            // Transient (beacon fetch, verification) — retry next refresh. Never
            // let it escape and abort the whole finalize pass.
            console.warn(
              `finalize: ${key} sealed reveal failed (${String(err)}) — retry next refresh`,
            );
            continue;
          }
          const fresh: SealedRevealRow[] = batch.map((rec, i) => ({
            txHash: rec.txHash,
            responseIndex: rec.responseIndex,
            response: encodeRevealed(result.revealed[i] ?? null),
          }));
          await store.putSealedReveals(fresh);
          if (batch.length < todo.length) {
            const done = inWindow.length - todo.length + fresh.length;
            console.log(
              `finalize: ${key} sealed reveal ${done}/${inWindow.length} — ` +
                `resuming next refresh`,
            );
            continue;
          }
          for (const r of fresh) {
            outcomes.set(validationKey(r.txHash, r.responseIndex), r.response);
          }
          // Reveal → validate → dedup. counted carry decrypted answers.
          // Answers are read back out of the cursor even when this pass produced
          // them, so an artifact's bytes never depend on which pass decrypted
          // which ciphertext.
          const audit = auditRevealedResponses(
            inWindow,
            inWindow.map((r) =>
              decodeRevealed(
                outcomes.get(validationKey(r.txHash, r.responseIndex))!,
              ),
            ),
            s.definition,
          );
          const rowByKey = new Map(
            eligible.map((r) => [`${r.txHash}:${r.responseIndex}`, r]),
          );
          const entries = audit.counted.map((rec) => ({
            row: rowByKey.get(`${rec.txHash}:${rec.responseIndex}`)!,
            response: rec.response,
          }));
          const missing = incompleteReason(
            entries.map((e) => e.row),
            weightByRole,
            totalByRole,
          );
          if (missing) {
            console.warn(`finalize: ${key} postponed — ${missing}`);
            continue;
          }
          const artifact = buildArtifact(
            config,
            s,
            entries,
            weightByRole,
            totalByRole,
            nowSec,
            {
              sealed: true,
              sealedReveal: {
                chainHash: bytesToHex(mode.chainHash),
                round: mode.round,
                beacon: result.beacon,
              },
              linkedActionIds,
            },
          );
          await store.putArtifact({
            surveyKey: key,
            endEpoch: s.definition.endEpoch,
            artifactHash: artifact.hash,
            artifact: artifact.json,
            createdAt: nowSec,
          });
          artifactKeys.finalized.add(key);
          console.log(
            `finalize: ${key} → sealed artifact ${artifact.hash} ` +
              `(counted ${audit.counted.length}, superseded ${audit.superseded.length}, ` +
              `invalid ${audit.invalid.length}, undecryptable ${audit.failed.length})`,
          );
          continue;
        }

        // --- public survey -------------------------------------------------------
        if (await pruneReorgedOut(key, counted)) continue;
        const missing =
          pending ?? incompleteReason(counted, weightByRole, totalByRole);
        if (missing) {
          console.warn(`finalize: ${key} postponed — ${missing}`);
          continue;
        }
        // Rejoin each counted row to its on-chain response (guaranteed present by
        // the reorg-prune above and the `incomplete` guard).
        const entries = counted.map((r) => ({
          row: r,
          response: responseByKey.get(`${r.txHash}:${r.responseIndex}`)!
            .response,
        }));
        const artifact = buildArtifact(
          config,
          s,
          entries,
          weightByRole,
          totalByRole,
          nowSec,
          { sealed: false, linkedActionIds },
        );
        await store.putArtifact({
          surveyKey: key,
          endEpoch: s.definition.endEpoch,
          artifactHash: artifact.hash,
          artifact: artifact.json,
          createdAt: nowSec,
        });
        artifactKeys.finalized.add(key);
        console.log(`finalize: ${key} → artifact ${artifact.hash}`);
      } catch (err) {
        console.warn(`finalize: ${key} skipped this pass — ${String(err)}`);
      }
    }
  }
  return settle();
}

/**
 * Attach each candidate's *defining* transaction evidence, so the talliability
 * gate can judge CIP-179's "the definition transaction MUST prove ownership of
 * the `owner` credential". A record whose proof couldn't be established keeps
 * `proof: null` — unknown, which the caller postpones rather than reads as a
 * failed proof.
 *
 * One transaction can define several surveys, so proofs are fetched per tx and
 * fanned back out; a native-script owner may not attach its script to that tx
 * (mechanism A permits chain resolution), hence the same by-hash resolution the
 * cancellation path uses.
 */
async function withOwnerProofs(
  source: Pick<import("cardano-tessera-koios").KoiosDataSource, "txProofs">,
  candidates: readonly SurveyRecord[],
): Promise<SurveyRecord[]> {
  const neededScripts = new Map<string, string[]>();
  for (const s of candidates) {
    const scriptHash = scriptCredentialHash(s.definition.owner);
    if (!scriptHash) continue;
    const list = neededScripts.get(s.txHash);
    if (list) list.push(scriptHash);
    else neededScripts.set(s.txHash, [scriptHash]);
  }
  const proofs = await source.txProofs(
    [...new Set(candidates.map((s) => s.txHash))],
    neededScripts,
  );
  return candidates.map((s) => ({
    ...s,
    proof: proofs.get(s.txHash) ?? null,
  }));
}

/**
 * Emit cancellation artifacts for candidates with an owner-proven, in-window
 * cancellation; return the remaining (non-cancelled) candidates to tally.
 *
 * A survey whose cancellation status can't be settled this refresh is *neither*
 * emitted nor returned — it is postponed to a later cron (finding 1). That
 * happens when the winning cancellation isn't yet determined: `txProofs` returns
 * `null` for a cancelling tx whose CBOR couldn't be fetched/decoded this refresh
 * (unknown, distinct from a fetched tx that simply doesn't prove the owner), and
 * emitting on incomplete evidence risks freezing the wrong immutable artifact —
 * a genuinely-cancelled survey tallied in full, or a winner the verifier will
 * refetch to a different (earlier) one → false MISMATCH.
 *
 * Each emitted cancellation artifact is folded into `artifactKeys` (both sets).
 */
async function withCancellations(
  config: ServerConfig,
  store: TallyStore,
  source: Pick<import("cardano-tessera-koios").KoiosDataSource, "txProofs">,
  cancellationsByKey: ReadonlyMap<string, readonly CancellationRecord[]>,
  candidates: readonly SurveyRecord[],
  nowSec: number,
  artifactKeys: ArtifactKeys,
): Promise<SurveyRecord[]> {
  const ownerByKey = new Map(
    candidates.map((s) => [refKey(s.ref), s.definition.owner]),
  );
  const relevant = candidates.flatMap(
    (s) => cancellationsByKey.get(refKey(s.ref)) ?? [],
  );
  if (relevant.length === 0) return [...candidates];

  // A native-script owner may not attach its script to the cancelling tx
  // (mechanism A permits chain resolution); tell `txProofs` which script hash to
  // resolve by hash for each cancellation tx (finding 7).
  const neededScripts = new Map<string, string[]>();
  for (const c of relevant) {
    const owner = ownerByKey.get(refKey(c.target));
    const scriptHash = owner ? scriptCredentialHash(owner) : null;
    if (!scriptHash) continue;
    const list = neededScripts.get(c.txHash);
    if (list) list.push(scriptHash);
    else neededScripts.set(c.txHash, [scriptHash]);
  }

  const proofs: Map<string, TxProof | null> = await source.txProofs(
    [...new Set(relevant.map((c) => c.txHash))],
    neededScripts,
  );

  const open: SurveyRecord[] = [];
  for (const s of candidates) {
    const key = refKey(s.ref);
    // The winner is the earliest verified cancellation in the ruleset's pinned
    // chain order (slot, then tx hash), so walk in that order: the first one
    // whose proof verifies wins. But if we reach one whose proof is *unknown*
    // (`null` — fetch/decode failed this refresh) before any verified one, the
    // winner isn't yet determined: that unknown cancellation could itself be a
    // valid earlier winner once its proof resolves. Postpone rather than guess.
    const inWindow = relevant
      .filter(
        (c) => refKey(c.target) === key && c.epochNo <= s.definition.endEpoch,
      )
      .sort(byCancellationChainOrder);

    let winning: (typeof inWindow)[number] | undefined;
    let unknown: (typeof inWindow)[number] | undefined;
    for (const c of inWindow) {
      const proof = proofs.get(c.txHash) ?? null;
      if (proof === null) {
        unknown = c;
        break;
      }
      if (mechanismAProven(s.definition.owner, proof)) {
        winning = c;
        break;
      }
    }

    if (unknown) {
      // Neither tallied nor cancelled this pass — retried next refresh, the same
      // "unknown ≠ negative" discipline `validate.ts` applies to response proofs.
      console.warn(
        `finalize: ${key} postponed — cancellation ${unknown.txHash} proof unknown (fetch/decode failed)`,
      );
      continue;
    }
    if (!winning) {
      open.push(s);
      continue;
    }
    const body: TallyBody = cancelledTallyBody(
      {
        network: config.app.network,
        survey: surveyIdOf(s),
        sealed: s.definition.submissionMode.type === "sealed",
      },
      {
        txHash: winning.txHash,
        slot: winning.slot,
        epoch: winning.epochNo,
      },
    );
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
    artifactKeys.finalized.add(key);
    artifactKeys.cancelled.add(key);
    console.log(`finalize: ${key} cancelled by ${winning.txHash}`);
  }
  return open;
}

/** The counted set for one survey, plus why (if at all) emission must wait. */
interface CountedRows {
  counted: ValidatedResponseRow[];
  /**
   * The pre-dedup eligible rows (valid, proven, in-window, covered role). Public
   * tallies use `counted`; sealed tallies use this — reveal-time validation must
   * run *before* dedup (finding 2), so a sealed survey can't dedup on-chain.
   */
  eligible: ValidatedResponseRow[];
  /** A pending-enrichment reason that forces postponement, or null. */
  pending: string | null;
}

/**
 * The counted set (TALLY-SPEC §3) for one survey: valid, proven, in-window,
 * deduped.
 *
 * A candidate row (well-formed, in-window, covered role) whose proof verdict or
 * block index is still pending forces the whole survey to postpone: a null
 * `proofOk` may yet resolve to counted, and a null `blockIndex` (the `-1`
 * dedup sentinel) can resolve a same-slot tie differently from the verifier's
 * real index. Emitting now would freeze either divergence into the immutable,
 * hash-committed artifact, so we wait for a later cron instead (finding 1).
 */
async function countedRows(
  store: TallyStore,
  surveyKey: string,
  endEpoch: number,
): Promise<CountedRows> {
  const rows = await store.validatedForSurvey(surveyKey);
  const eligible: ValidatedResponseRow[] = [];
  let pending: string | null = null;
  for (const r of rows) {
    if (!r.wellFormed || r.epochNo > endEpoch) continue;
    if (!COVERED_ROLES.includes(r.role)) {
      console.warn(
        `finalize: ${surveyKey} drops role-${r.role} response ${r.txHash} (SPO/CC weighting deferred)`,
      );
      continue;
    }
    if (r.proofOk === null) {
      // Enrichment still pending (retried each refresh) — can't finalize yet.
      pending ??= `response ${r.txHash}:${r.responseIndex} has no proof verdict yet`;
      continue;
    }
    if (!r.proofOk) continue;
    if (r.blockIndex === null) {
      // Proven but its dedup ordering isn't final yet — can't finalize yet.
      pending ??= `response ${r.txHash}:${r.responseIndex} has no block index yet`;
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
  return { counted: [...best.values()], eligible, pending };
}

/**
 * Credentials fetched-and-persisted per step, so a mid-role failure (rate
 * limit, Worker subrequest cap) still advances the resume cursor instead of
 * re-fetching the whole role from zero next cron (finding 5). Stakeholders
 * resolve in one bulk pair of reads per ~50; DReps are one sequential GET each,
 * so persist each as it lands.
 */
const WEIGHT_CHUNK_BY_ROLE: Record<number, number> = {
  [Role.Stakeholder]: 50,
  [Role.DRep]: 1,
};

/**
 * The inputs every survey ending at `epoch` shares: each survey's counted rows,
 * and — for the union of credentials those rows name — the frozen weights and
 * electorate totals. Gathered once per epoch rather than per survey, because
 * weight rows are keyed by (epoch, role, credential) and two surveys closing
 * together routinely name the same responder.
 */
async function prepareEpoch(
  store: TallyStore,
  inputs: TallyInputSource,
  epoch: number,
  surveys: readonly SurveyRecord[],
  nowSec: number,
): Promise<{
  countedBySurvey: Map<string, CountedRows>;
  weightByRole: Map<number, Map<string, WeightRow>>;
  totalByRole: Map<number, string | null>;
}> {
  // Counted rows per survey (rules 1–3 verdicts joined at tally time), plus
  // whether any counted-candidate row is still awaiting a verdict/block index.
  const countedBySurvey = new Map<string, CountedRows>();
  for (const s of surveys) {
    countedBySurvey.set(
      refKey(s.ref),
      await countedRows(store, refKey(s.ref), epoch),
    );
  }

  // Union of counted credentials per role across all surveys ending at E.
  // R1 invariant: using the *deduped* `counted` (not `eligible`) is safe even
  // for sealed surveys, which tally the pre-dedup set. Dedup only collapses
  // rows sharing a (role, credential); it never removes a credential from the
  // union, so the set of credentials to snapshot weights for is identical
  // pre- and post-dedup. Sealed weights frozen here are therefore correct for
  // the post-reveal counted set (a subset of these credentials).
  const credsByRole = new Map<number, Set<string>>();
  for (const { counted } of countedBySurvey.values()) {
    for (const r of counted) {
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
    totalByRole.set(role, await fillTotal(store, inputs, epoch, role, nowSec));
  }

  return { countedBySurvey, weightByRole, totalByRole };
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

  if (role === Role.Keyholder) {
    // Count-only role: one responder, one vote — no chain lookup.
    const fetched: WeightRow[] = missing.map((credential) => ({
      epoch,
      role,
      credential,
      weight: "1",
      registered: true,
      fetchedAt: nowSec,
    }));
    await store.insertWeightRows(fetched);
    for (const r of fetched) have.set(r.credential, r);
    return have;
  }

  // Fetch + persist in chunks: each persisted chunk is a resume point, so if a
  // later chunk throws the finished ones survive to next cron (they drop out of
  // `missing` above). No extra Koios calls — the chunk matches the source's own
  // batch granularity (one bulk read for stakeholders, one GET per DRep).
  const chunkSize = WEIGHT_CHUNK_BY_ROLE[role] ?? 50;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const slice = missing.slice(i, i + chunkSize);
    const creds = slice.map(parseCredentialKey);
    const infos =
      role === Role.DRep
        ? await inputs.drepWeights(epoch, creds)
        : await inputs.stakeholderWeights(epoch, creds);
    const fetched: WeightRow[] = slice.map((credential) => {
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
    await store.insertWeightRows(fetched);
    for (const r of fetched) have.set(r.credential, r);
  }
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

/** A counted row paired with its (public, or reveal-decrypted) response. */
interface TallyEntry {
  readonly row: ValidatedResponseRow;
  readonly response: SurveyResponse;
}

/** Artifact extras folded into the body + provenance. */
interface SealedArtifactOpts {
  readonly sealed: boolean;
  readonly sealedReveal?: TallyArtifact["provenance"]["sealedReveal"];
  /**
   * Epoch-aligned action ids this survey resolved as linked, sorted (`[]` =
   * standalone). Committed to provenance (unhashed) for the re-verifier's link
   * set diff (finding 6).
   */
  readonly linkedActionIds: readonly string[];
}

/**
 * Assemble the weighted-tally artifact for one complete survey. `entries` pair
 * each counted row with its response — the on-chain public answers, or (sealed)
 * the reveal-decrypted answers. Sealed tallies set `sealed=true`, commit each
 * responder's revealed answers, and record the reveal beacon in provenance.
 */
function buildArtifact(
  config: ServerConfig,
  s: SurveyRecord,
  entries: readonly TallyEntry[],
  weightByRole: ReadonlyMap<number, ReadonlyMap<string, WeightRow>>,
  totalByRole: ReadonlyMap<number, string | null>,
  nowSec: number,
  opts: SealedArtifactOpts,
): { json: string; hash: string } {
  const rolesPresent = [...new Set(entries.map((e) => e.row.role))].sort(
    (a, b) => a - b,
  );
  // Membership-filter each role's responders here (against the frozen weight
  // snapshot, with the emitter's own drop-logging), then hand it to the SHARED
  // assembler — the verifier calls the same `assembleTallyBody`, so role
  // ordering, per-role artifact shaping, and the base body stay identical by
  // construction (finding 29).
  const roles: RoleTally[] = rolesPresent.map((role) => {
    const responders: WeightedResponder[] = [];
    for (const { row: r, response } of entries) {
      if (r.role !== role) continue;
      const weight = weightByRole.get(role)?.get(r.credential);
      // `incompleteReason` already guaranteed this; reaching here means that
      // invariant broke. Throwing postpones the survey (the per-survey catch
      // logs and retries next pass) — dropping the responder instead would
      // freeze a short tally into an immutable artifact, discoverable only as
      // a verifier MISMATCH.
      if (!weight) {
        throw new Error(
          `no frozen weight for role ${role} ${r.credential} — ` +
            `completeness invariant broken`,
        );
      }
      if (!weight.registered) {
        // Membership at end_epoch is a hard filter (weight-0 registered
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
        responseIndex: r.responseIndex,
        response,
      });
    }
    return { role, responders, total: totalByRole.get(role) ?? null };
  });

  const tally: TallyBody = assembleTallyBody(
    s.definition,
    {
      network: config.app.network,
      survey: surveyIdOf(s),
      sealed: opts.sealed,
    },
    roles,
  );
  const artifact: TallyArtifact = {
    tally,
    provenance: {
      source: { provider: "koios", baseUrl: config.app.koiosUrl },
      fetchedAt: nowSec,
      byRole: rolesPresent.map((role) => ({
        role,
        endpoint: ROLE_ENDPOINTS[role] ?? "unknown",
      })),
      govLinks: opts.linkedActionIds,
      ...(opts.sealedReveal && { sealedReveal: opts.sealedReveal }),
    },
  };
  return { json: JSON.stringify(artifact), hash: artifactHash(tally) };
}
