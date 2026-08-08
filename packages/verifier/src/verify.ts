/**
 * Artifact re-verification (`backend/TALLY-SPEC.md` §5, `backend/ARCHITECTURE.md`
 * §8): rebuild a survey's final tally from first principles and compare content
 * hashes.
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

import {
  isSurveyTalliable,
  surveyErrors,
  validateResponse,
  type SurveyResponse,
} from "cip-179";

import {
  BINDABLE_ROLES,
  auditRevealedResponses,
  byCancellationChainOrder,
  bytesToHex,
  mechanismAProven,
  credentialKey,
  laterInChain,
  refKey,
  responseCredentialProof,
  type ResponseRecord,
  type SurveyBundle,
  type TxProof,
} from "cip-179/domain";
import {
  RULESET_DESCRIPTOR,
  artifactHash,
  assembleTallyBody,
  cancelledTallyBody,
  emptyTallyBody,
  type RoleTally,
  type TallyArtifact,
  type TallyBody,
  type TallyBodyIdentity,
  type TallyInputSource,
  type WeightedResponder,
} from "cip-179/tally";
import { isQuicknet } from "cip-179/tlock";

/** Everything the rebuild needs — all independently (re)fetched by the CLI. */
export interface VerifyInputs {
  readonly bundle: SurveyBundle;
  /** The artifact under verification, exactly as served. */
  readonly artifact: TallyArtifact;
  readonly network: string;
  /** Epoch-aligned linking governance action ids (empty = standalone). */
  readonly linkedActionIds: readonly string[];
  /**
   * Epoch-aligned actions whose anchor this verifier couldn't resolve, so their
   * link status is unknown. A response that cast a qualifying vote on one and
   * isn't otherwise proven makes the rebuild INDETERMINATE rather than silently
   * dropped (finding 6). Default `[]` — everything resolved.
   */
  readonly unresolvedActionIds?: readonly string[];
  /**
   * False when this verifier's whole gov-links fetch failed, so *every* link is
   * unknown: a bindable role's response not proven by mechanism A is then
   * indeterminate, not unproven. Default `true`.
   */
  readonly govLinksReliable?: boolean;
  /** `tx_block_index` per tx of the bundle (from Koios `/tx_info`). */
  readonly blockIndices: ReadonlyMap<string, number>;
  /** Decoded proof evidence per tx of the bundle (from Koios `/tx_cbor`). */
  readonly proofs: ReadonlyMap<string, TxProof | null>;
  /** Membership + weights at `end_epoch` (Koios-backed in the CLI). */
  readonly weights: TallyInputSource;
  /**
   * Sealed reveal: decrypt the in-window sealed responses with an independently
   * fetched, BLS-verified beacon (`revealed[i]` aligns with the input record;
   * null = decrypt/decode failed). Required to verify a sealed artifact — the
   * CLI wires `cip-179/tlock`; omitted for public artifacts.
   */
  readonly reveal?: (
    records: readonly ResponseRecord[],
    params: { readonly chainHash: string; readonly round: number },
  ) => Promise<(SurveyResponse | null)[]>;
}

export interface VerifyResult {
  readonly match: boolean;
  /**
   * True when the rebuild couldn't reach a definite counted set — a governance
   * link needed to decide a mechanism-B proof couldn't be resolved (finding 6).
   * `match` is then not meaningful (it is `false`, but this is NOT a MISMATCH);
   * the reason is in `notes`. Re-run when the inputs are resolvable.
   */
  readonly indeterminate: boolean;
  /**
   * True when the survey's on-chain definition is spec-invalid (non-v5 or
   * structurally invalid), so it is untalliable and has no reproducible tally
   * (findings 10/11). `match` is then not meaningful (`false`, but NOT a
   * MISMATCH): a conformant emitter produces no artifact, so a served artifact is
   * itself a backend non-conformance. The reason is in `notes`.
   */
  readonly untalliable: boolean;
  /**
   * True when at least one role's electorate `total` could not be independently
   * re-fetched and the rebuild fell back to the artifact's own hash-committed
   * value (finding 31). A `match` that is true alongside this is a *weaker*
   * verdict — every other field reproduced, but this one denominator was assumed,
   * not confirmed — so the CLI reports it distinctly (exit 5), never a clean
   * MATCH. A backend could otherwise inflate the turnout denominator and pass
   * scripted verification whenever the upstream total endpoint is down.
   */
  readonly unverifiedTotals: boolean;
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
export async function rebuildTally(inputs: VerifyInputs): Promise<{
  tally: TallyBody;
  notes: string[];
  indeterminate: string | null;
  untalliable: string | null;
  unverifiedTotals: boolean;
}> {
  const notes: string[] = [];
  const { bundle } = inputs;
  const def = bundle.survey.definition;
  const endEpoch = def.endEpoch;
  const surveyId = {
    txId: bytesToHex(bundle.survey.ref.txId),
    index: bundle.survey.ref.index,
    endEpoch,
  };
  const sealed = def.submissionMode.type === "sealed";
  const id: TallyBodyIdentity = {
    network: inputs.network,
    survey: surveyId,
    sealed,
  };

  // Talliability first (the `definition-validity` ruleset rule): a spec-invalid
  // survey — non-v5, structurally invalid, ending in the epoch that published
  // it, or defined by a transaction that never proved its `owner` — is
  // untalliable, so it has no reproducible tally and a conformant emitter writes
  // no artifact. Decided from the independently fetched record and defining-tx
  // evidence, so a backend can't dress an invalid survey up as talliable
  // (findings 10, 11, 45, 12).
  const survey = {
    ...bundle.survey,
    proof: inputs.proofs.get(bundle.survey.txHash) ?? null,
  };
  if (!isSurveyTalliable(survey)) {
    const codes = surveyErrors(survey)
      .map((p) => p.code)
      .join(", ");
    return {
      tally: emptyTallyBody(id),
      notes,
      indeterminate: null,
      untalliable: `definition is spec-invalid (${codes}) — untalliable, no artifact should exist`,
      unverifiedTotals: false,
    };
  }
  // Everything else was decidable from the record alone; the owner rule was not,
  // and an unread proof is unknown rather than unproven (finding 6's discipline).
  if (!survey.proof) {
    return {
      tally: emptyTallyBody(id),
      notes,
      indeterminate: `the defining transaction ${survey.txHash} could not be fetched or decoded, so its owner-proof is unknown`,
      untalliable: null,
      unverifiedTotals: false,
    };
  }

  // Cancellation first: the earliest owner-proven, in-window cancellation (in
  // chain order — the choice the ruleset pins) short-circuits the tally.
  const winning = [...bundle.cancellations]
    .sort(byCancellationChainOrder)
    .find(
      (c) =>
        c.epochNo <= endEpoch &&
        mechanismAProven(def.owner, inputs.proofs.get(c.txHash) ?? null),
    );
  if (winning) {
    return {
      tally: cancelledTallyBody(id, {
        txHash: winning.txHash,
        slot: winning.slot,
        epoch: winning.epochNo,
      }),
      notes,
      indeterminate: null,
      untalliable: null,
      unverifiedTotals: false,
    };
  }

  // TALLY-SPEC §3 rules 1–3 from scratch: window (authoritative epochNo),
  // validity (full codec validation), credential proof (mechanism A/B), then
  // latest-in-chain-order per (role, credential).
  const unresolvedActionIds = inputs.unresolvedActionIds ?? [];
  const govLinksReliable = inputs.govLinksReliable ?? true;
  const eligible: ResponseRecord[] = [];
  let indeterminate: string | null = null;
  for (const r of bundle.responses) {
    if (r.epochNo > endEpoch) continue;
    if (validateResponse(def, r.response).length !== 0) continue;
    // Uncovered roles never count, so their proof verdict can't affect the
    // hash — filter them before the proof step (and before flagging indeterminacy
    // on an unresolvable link they'd be dropped for regardless).
    if (!COVERED_ROLES.includes(r.response.role)) continue;
    const proof = inputs.proofs.get(r.txHash) ?? null;
    if (!proof) {
      notes.push(`no proof evidence for tx ${r.txHash} — response excluded`);
      continue;
    }
    const verdict = responseCredentialProof(
      r.response,
      proof,
      inputs.linkedActionIds,
      unresolvedActionIds,
    );
    // A verdict that hinges on an unresolvable governance link is unknown, not a
    // negative — surface it, don't silently drop the response (finding 6). Two
    // sources: it voted on an epoch-aligned action whose anchor we couldn't
    // resolve (`unknown`), or our whole gov-links fetch failed so every link is
    // unknown (`unproven` + `!govLinksReliable`, bindable role only).
    if (
      verdict === "unknown" ||
      (verdict === "unproven" &&
        !govLinksReliable &&
        BINDABLE_ROLES.has(r.response.role))
    ) {
      indeterminate ??=
        `credential proof for ${r.txHash}:${r.responseIndex} depends on a ` +
        `governance-link anchor this verifier could not resolve — the counted ` +
        `set cannot be reproduced; retry when the link is resolvable`;
      continue;
    }
    if (verdict !== "proven") continue;
    const blockIndex = inputs.blockIndices.get(r.txHash);
    if (blockIndex === undefined) {
      // A proven, in-window response whose tx has no `tx_block_index` (Koios
      // `/tx_info` didn't resolve it): the dedup order (slot, tx_block_index,
      // response_index) can't be reproduced — the `-1` sentinel `laterInChain`
      // falls back to could resolve a same-slot tie differently. The emitter
      // POSTPONES finalization in exactly this case (`countedRows`), so match
      // that discipline: make the rebuild INDETERMINATE (retry when resolvable)
      // rather than silently risk a false MISMATCH (finding 16).
      indeterminate ??=
        `response ${r.txHash}:${r.responseIndex} has no tx_block_index ` +
        `(Koios /tx_info did not resolve it) — the counted order cannot be ` +
        `reproduced; retry when it is resolvable`;
      continue;
    }
    eligible.push({ ...r, blockIndex });
  }
  // A single unresolved-link uncertainty makes the whole rebuild indeterminate:
  // we can't produce THE counted set, so a hash comparison would be misleading.
  if (indeterminate) {
    return {
      tally: emptyTallyBody(id),
      notes,
      indeterminate,
      untalliable: null,
      unverifiedTotals: false,
    };
  }
  let counted: ResponseRecord[];
  if (sealed) {
    const mode = def.submissionMode;
    if (mode.type !== "sealed") throw new Error("unreachable");
    if (!isQuicknet(mode.chainHash)) {
      // The emitter can't reveal a non-quicknet sealed survey either, so it
      // emits no artifact. Rebuild an empty tally: a served artifact for one is
      // spurious, and the loud MISMATCH that follows is the correct verdict.
      notes.push(
        "sealed survey on an unsupported (non-quicknet) drand chain — no reveal, empty tally",
      );
      return {
        tally: emptyTallyBody(id),
        notes,
        indeterminate: null,
        untalliable: null,
        unverifiedTotals: false,
      };
    }
    if (!inputs.reveal) {
      throw new Error(
        "sealed artifact requires a reveal function (independently fetch the drand beacon)",
      );
    }
    // Reveal → validate → dedup: decrypt the pre-dedup in-window set with an
    // independently fetched beacon, then dedup only the valid decoded set (the
    // sealed-reveal + sealed-dedup rules; finding 2). Counted records carry
    // their decrypted public answers, so the weight/tally code below is shared.
    const revealed = await inputs.reveal(eligible, {
      chainHash: bytesToHex(mode.chainHash),
      round: mode.round,
    });
    const audit = auditRevealedResponses(eligible, revealed, def);
    counted = audit.counted;
    if (audit.failed.length > 0) {
      notes.push(`${audit.failed.length} sealed response(s) failed to reveal`);
    }
    if (audit.invalid.length > 0) {
      notes.push(
        `${audit.invalid.length} revealed response(s) invalid against the definition`,
      );
    }
    if (audit.superseded.length > 0) {
      notes.push(
        `${audit.superseded.length} revealed response(s) superseded (latest-wins)`,
      );
    }
  } else {
    const best = new Map<string, ResponseRecord>();
    for (const r of eligible) {
      const id = `${r.response.role}|${credentialKey(r.response.credential)}`;
      const prev = best.get(id);
      if (!prev || laterInChain(r, prev)) best.set(id, r);
    }
    counted = [...best.values()];
  }

  // Per role ascending: weights + membership at end_epoch, then hand the
  // membership-filtered responders + total to the SHARED assembler (the emitter
  // uses the same `assembleTallyBody`, so role ordering, per-role artifact
  // shaping, and the base body can't drift — finding 29). Weight/total sourcing
  // and the membership filter are inherently data-source-specific, so they stay
  // here.
  const rolesPresent = [...new Set(counted.map((r) => r.response.role))].sort(
    (a, b) => a - b,
  );
  const receivedTotals = new Map(
    inputs.artifact.tally.perRole.map((r) => [r.role, r.total]),
  );
  let unverifiedTotals = false;
  const roles: RoleTally[] = [];
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
        if (!info.registered) continue; // membership filter (TALLY-SPEC §1)
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
        // artifact's own value so the rest still verifies — but flag it, since
        // this one hash-committed number was then NOT independently confirmed
        // (finding 31). The CLI downgrades a MATCH that leans on this.
        total = receivedTotals.get(role) ?? null;
        unverifiedTotals = true;
        notes.push(
          `role-${role} electorate total not independently re-fetchable — using the artifact's value`,
        );
      }
    }

    roles.push({ role, responders, total });
  }

  return {
    tally: assembleTallyBody(def, id, roles),
    notes,
    indeterminate: null,
    untalliable: null,
    unverifiedTotals,
  };
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
      } else if (JSON.stringify(local.answers) !== JSON.stringify(r.answers)) {
        // Sealed responders commit their revealed answers; a tampered ciphertext
        // or a substituted reveal shows up here even when weight/tx match.
        diffs.push(`role ${role}: ${cred} committed answers differ`);
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
  const {
    tally: rebuilt,
    notes,
    indeterminate,
    untalliable,
    unverifiedTotals,
  } = await rebuildTally(inputs);
  const rebuiltHash = artifactHash(rebuilt);

  // An untalliable survey has no reproducible tally: a served artifact is itself
  // a backend non-conformance (a conformant emitter writes none), so this is
  // neither MATCH nor MISMATCH regardless of what the artifact hashes to.
  if (untalliable !== null) {
    return {
      match: false,
      indeterminate: false,
      untalliable: true,
      unverifiedTotals: false,
      receivedHash,
      rebuiltHash,
      rebuilt,
      notes: [...notes, untalliable],
      diffs: [],
    };
  }

  // Diff this verifier's independently-resolved link set against the one the
  // emitter committed (unhashed provenance), so a divergence in governance-link
  // resolution is named explicitly rather than surfacing only as an opaque hash
  // MISMATCH (finding 6). Absent `govLinks` = a pre-commit or cancellation
  // artifact; nothing to compare.
  const committed = inputs.artifact.provenance.govLinks;
  if (committed !== undefined) {
    const c = [...committed].sort();
    const resolved = [...inputs.linkedActionIds].sort();
    if (c.length !== resolved.length || c.some((id, i) => id !== resolved[i])) {
      notes.push(
        `governance link set diverged — artifact committed [${c.join(", ")}], ` +
          `this verifier resolved [${resolved.join(", ")}]; any difference below ` +
          `may stem from differing link resolution, not a dishonest tally`,
      );
    }
  }

  if (indeterminate !== null) {
    return {
      match: false,
      indeterminate: true,
      untalliable: false,
      unverifiedTotals: false,
      receivedHash,
      rebuiltHash,
      rebuilt,
      notes: [...notes, indeterminate],
      diffs: [],
    };
  }

  const match = rebuiltHash === receivedHash;
  return {
    match,
    indeterminate: false,
    untalliable: false,
    unverifiedTotals,
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
 * action ids among `govLinks` (any action kind, possibly several — CIP-179
 * v5). Empty for a standalone survey.
 */
export function linkedActionIdsFor(
  bundle: SurveyBundle,
  govLinks: readonly {
    surveyKey: string;
    actionId: string;
    endEpoch: number;
  }[],
): string[] {
  return govLinks
    .filter(
      (l) =>
        l.surveyKey === refKey(bundle.survey.ref) &&
        l.endEpoch === bundle.survey.definition.endEpoch,
    )
    .map((l) => l.actionId);
}
