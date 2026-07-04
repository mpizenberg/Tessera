/**
 * Artifact re-verification (`backend/ARCHITECTURE.md` §7/§8): rebuild a
 * survey's final tally from first principles and compare content hashes.
 *
 * Trust model: the ONLY thing taken from the backend is the artifact under
 * test, whose hash this module recomputes. Every input the rebuild consumes —
 * the survey definition, the response *set*, each response's *answers*
 * (`bundle`), plus proofs, block indices, weights, totals — is (re)derived
 * independently from Koios by the caller (see `cli.ts`, which builds `bundle`
 * from its own label-17 scan, NOT from the backend). The backend's
 * `validated_response`/`weight_snapshot` tables are never consulted either.
 * `MATCH` therefore means: an independent implementation of the pinned ruleset,
 * fed independently-fetched chain data, produces byte-identical results — so a
 * backend that omits or alters responses cannot reproduce the hash.
 */

import { validateResponse } from "cip-179";

import {
  RULESET_DESCRIPTOR,
  artifactHash,
  bytesToHex,
  cancellationVerified,
  credentialKey,
  laterInChain,
  refKey,
  responseCredentialProven,
  rulesetHash,
  toArtifactQuestions,
  toArtifactResponders,
  weightedTallySurvey,
  type ArtifactRoleTally,
  type ResponseRecord,
  type SurveyBundle,
  type TallyArtifact,
  type TallyBody,
  type TallyInputSource,
  type TxProof,
  type WeightedResponder,
} from "@tessera/core";

/** Everything the rebuild needs — all independently (re)fetched by the CLI. */
export interface VerifyInputs {
  readonly bundle: SurveyBundle;
  /** The artifact under verification, exactly as served. */
  readonly artifact: TallyArtifact;
  readonly network: string;
  /** Epoch-aligned linking governance action id, or null (standalone). */
  readonly linkedActionId: string | null;
  /** `tx_block_index` per tx of the bundle (from Koios `/tx_info`). */
  readonly blockIndices: ReadonlyMap<string, number>;
  /** Decoded proof evidence per tx of the bundle (from Koios `/tx_cbor`). */
  readonly proofs: ReadonlyMap<string, TxProof | null>;
  /** Membership + weights at `end_epoch` (Koios-backed in the CLI). */
  readonly weights: TallyInputSource;
}

export interface VerifyResult {
  readonly match: boolean;
  /** Content hash of the artifact as received. */
  readonly receivedHash: string;
  /** Content hash of the independently rebuilt tally. */
  readonly rebuiltHash: string;
  readonly rebuilt: TallyBody;
  /** Trust caveats hit during the rebuild (e.g. an unverifiable total). */
  readonly notes: readonly string[];
  /** Human-readable differences, populated on mismatch. */
  readonly diffs: readonly string[];
}

const COVERED_ROLES: readonly number[] = [...RULESET_DESCRIPTOR.coveredRoles];
const ROLE_DREP = 0;
const ROLE_KEYHOLDER = 4;

/** Rebuild the hashed tally body from chain data + the pinned ruleset. */
export async function rebuildTally(
  inputs: VerifyInputs,
): Promise<{ tally: TallyBody; notes: string[] }> {
  const notes: string[] = [];
  const { bundle } = inputs;
  const def = bundle.survey.definition;
  const endEpoch = def.endEpoch;
  const surveyId = {
    txId: bytesToHex(bundle.survey.ref.txId),
    index: bundle.survey.ref.index,
    endEpoch,
  };
  const base = {
    rulesetHash: rulesetHash(),
    network: inputs.network,
    survey: surveyId,
    sealed: false,
  };

  // Cancellation first: the earliest owner-proven, in-window cancellation (in
  // chain order — the choice the ruleset pins) short-circuits the tally.
  const winning = [...bundle.cancellations]
    .sort((a, b) => a.slot - b.slot || (a.txHash < b.txHash ? -1 : 1))
    .find(
      (c) =>
        c.epochNo <= endEpoch &&
        cancellationVerified(def.owner, inputs.proofs.get(c.txHash) ?? null),
    );
  if (winning) {
    return {
      tally: {
        ...base,
        cancelled: {
          txHash: winning.txHash,
          slot: winning.slot,
          epoch: winning.epochNo,
        },
        perRole: [],
      },
      notes,
    };
  }

  // §6.3 rules 1–3 from scratch: window (authoritative epochNo), validity
  // (full codec validation), credential proof (mechanism A/B), then
  // latest-in-chain-order per (role, credential).
  const eligible: ResponseRecord[] = [];
  for (const r of bundle.responses) {
    if (r.epochNo > endEpoch) continue;
    if (validateResponse(def, r.response).length !== 0) continue;
    const proof = inputs.proofs.get(r.txHash) ?? null;
    if (!proof) {
      notes.push(`no proof evidence for tx ${r.txHash} — response excluded`);
      continue;
    }
    if (!responseCredentialProven(r.response, proof, inputs.linkedActionId))
      continue;
    if (!COVERED_ROLES.includes(r.response.role)) continue;
    const blockIndex = inputs.blockIndices.get(r.txHash);
    eligible.push(blockIndex === undefined ? r : { ...r, blockIndex });
  }
  const best = new Map<string, ResponseRecord>();
  for (const r of eligible) {
    const id = `${r.response.role}|${credentialKey(r.response.credential)}`;
    const prev = best.get(id);
    if (!prev || laterInChain(r, prev)) best.set(id, r);
  }
  const counted = [...best.values()];

  // Per role ascending: weights + membership at end_epoch, then the pure
  // weighted tally.
  const rolesPresent = [...new Set(counted.map((r) => r.response.role))].sort(
    (a, b) => a - b,
  );
  const receivedTotals = new Map(
    inputs.artifact.tally.perRole.map((r) => [r.role, r.total]),
  );
  const perRole: ArtifactRoleTally[] = [];
  for (const role of rolesPresent) {
    const roleRecords = counted.filter((r) => r.response.role === role);
    const creds = roleRecords.map((r) => r.response.credential);

    let responders: WeightedResponder[];
    if (role === ROLE_KEYHOLDER) {
      responders = roleRecords.map((r) => ({
        credentialKey: credentialKey(r.response.credential),
        weight: 1n,
        txHash: r.txHash,
        responseIndex: r.responseIndex,
        response: r.response,
      }));
    } else {
      const infos =
        role === ROLE_DREP
          ? await inputs.weights.drepWeights(endEpoch, creds)
          : await inputs.weights.stakeholderWeights(endEpoch, creds);
      responders = [];
      for (const r of roleRecords) {
        const key = credentialKey(r.response.credential);
        const info = infos.get(key);
        if (!info) throw new Error(`no weight info for ${key}`);
        if (!info.registered) continue; // §6.1 membership filter
        responders.push({
          credentialKey: key,
          weight: info.weight,
          txHash: r.txHash,
          responseIndex: r.responseIndex,
          response: r.response,
        });
      }
    }

    let total: string | null = null;
    if (role !== ROLE_KEYHOLDER) {
      const fetched =
        role === ROLE_DREP
          ? await inputs.weights.drepTotal(endEpoch)
          : await inputs.weights.stakeholderTotal(endEpoch);
      if (fetched !== null) {
        total = String(fetched);
      } else {
        // The upstream can't serve the total right now: fall back to the
        // artifact's own value so the rest still verifies — flagged, since
        // this one number was then NOT independently confirmed.
        total = receivedTotals.get(role) ?? null;
        notes.push(
          `role-${role} electorate total not independently re-fetchable — using the artifact's value`,
        );
      }
    }

    perRole.push({
      role,
      total,
      responders: toArtifactResponders(responders),
      questions: toArtifactQuestions(weightedTallySurvey(def, responders)),
    });
  }

  return { tally: { ...base, perRole }, notes };
}

/** Human-readable differences between the received and rebuilt tallies. */
function diffTallies(received: TallyBody, rebuilt: TallyBody): string[] {
  const diffs: string[] = [];
  if (received.rulesetHash !== rebuilt.rulesetHash) {
    diffs.push(
      `ruleset: received ${received.rulesetHash}, local ${rebuilt.rulesetHash} — different counting rules`,
    );
  }
  if (Boolean(received.cancelled) !== Boolean(rebuilt.cancelled)) {
    diffs.push(
      `cancellation: received says ${received.cancelled ? "cancelled" : "not cancelled"}, rebuilt says the opposite`,
    );
  }
  const roles = new Set([
    ...received.perRole.map((r) => r.role),
    ...rebuilt.perRole.map((r) => r.role),
  ]);
  for (const role of [...roles].sort((a, b) => a - b)) {
    const a = received.perRole.find((r) => r.role === role);
    const b = rebuilt.perRole.find((r) => r.role === role);
    if (!a || !b) {
      diffs.push(`role ${role}: present only in ${a ? "received" : "rebuilt"}`);
      continue;
    }
    if (a.total !== b.total) {
      diffs.push(`role ${role} total: received ${a.total}, rebuilt ${b.total}`);
    }
    const aResp = new Map(a.responders.map((r) => [r.credential, r]));
    const bResp = new Map(b.responders.map((r) => [r.credential, r]));
    for (const [cred, r] of aResp) {
      const local = bResp.get(cred);
      if (!local) diffs.push(`role ${role}: ${cred} counted only in received`);
      else if (local.weight !== r.weight || local.txHash !== r.txHash) {
        diffs.push(
          `role ${role}: ${cred} differs (weight ${r.weight}→${local.weight}, tx ${r.txHash}→${local.txHash})`,
        );
      }
    }
    for (const cred of bResp.keys()) {
      if (!aResp.has(cred))
        diffs.push(`role ${role}: ${cred} counted only in rebuilt`);
    }
    if (JSON.stringify(a.questions) !== JSON.stringify(b.questions)) {
      diffs.push(`role ${role}: question aggregates differ`);
    }
  }
  return diffs;
}

export async function verifyArtifact(
  inputs: VerifyInputs,
): Promise<VerifyResult> {
  const receivedHash = artifactHash(inputs.artifact.tally);
  const { tally: rebuilt, notes } = await rebuildTally(inputs);
  const rebuiltHash = artifactHash(rebuilt);
  const match = rebuiltHash === receivedHash;
  return {
    match,
    receivedHash,
    rebuiltHash,
    rebuilt,
    notes,
    diffs: match ? [] : diffTallies(inputs.artifact.tally, rebuilt),
  };
}

/**
 * Diagnostic diff of two response sets by (txHash, responseIndex) identity: the
 * independent chain scan vs. whatever bundle the backend served. A backend that
 * omits on-chain responses (or fabricates ones the chain doesn't have) is named
 * explicitly here; the same divergence would otherwise only surface as an opaque
 * hash MISMATCH, since the rebuild always uses the chain set. Pure and
 * order-independent, so it's unit-testable without a network.
 */
export function diffResponseSets(
  chain: readonly { txHash: string; responseIndex: number }[],
  backend: readonly { txHash: string; responseIndex: number }[],
): string[] {
  const keyOf = (r: { txHash: string; responseIndex: number }) =>
    `${r.txHash}:${r.responseIndex}`;
  const chainKeys = new Set(chain.map(keyOf));
  const backendKeys = new Set(backend.map(keyOf));
  const notes: string[] = [];
  const omitted = [...chainKeys].filter((k) => !backendKeys.has(k));
  const extra = [...backendKeys].filter((k) => !chainKeys.has(k));
  if (omitted.length > 0) {
    notes.push(
      `backend bundle OMITS ${omitted.length} on-chain response(s): ${omitted.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    notes.push(
      `backend bundle lists ${extra.length} response(s) not seen in the chain scan (scan gap or fabrication): ${extra.join(", ")}`,
    );
  }
  return notes;
}

/**
 * Convenience for callers holding a survey key: the epoch-aligned linking
 * action id among `govLinks`, or null.
 */
export function linkedActionIdFor(
  bundle: SurveyBundle,
  govLinks: readonly {
    surveyKey: string;
    actionId: string;
    endEpoch: number;
  }[],
): string | null {
  const key = refKey(bundle.survey.ref);
  const link = govLinks.find(
    (l) =>
      l.surveyKey === key && l.endEpoch === bundle.survey.definition.endEpoch,
  );
  return link?.actionId ?? null;
}
