/**
 * Artifact re-verification (`backend/TALLY-SPEC.md` §5, `backend/ARCHITECTURE.md`
 * §8): rebuild a survey's final tally from first principles and compare content
 * hashes.
 *
 * Trust model: the ONLY thing taken from the backend is the artifact under
 * test, whose hash this module recomputes. Every input the rebuild consumes —
 * the survey definition, the response *set*, each response's *answers*
 * (`bundle`), plus proofs, block indices, weights — is (re)derived
 * independently by the caller, from Koios or a Dolos node (see `cli.ts`, which
 * builds `bundle` from its own label-17 scan, NOT from the backend). The backend's
 * `validated_response`/`weight_snapshot` tables are never consulted either.
 * `MATCH` therefore means: an independent implementation of the pinned ruleset,
 * fed independently-fetched chain data, produces byte-identical results — so a
 * backend that omits or alters responses cannot reproduce the hash. The
 * electorate totals in the artifact's `info` are outside the hash: they are
 * compared when the caller supplies its own, and a difference is only a note.
 * So is the ruleset its `provenance` names: an artifact counted under other
 * rules matches wherever those rules give this survey the same result, and a
 * different ruleset is a note either way.
 */

import {
  isSurveyTalliable,
  surveyErrors,
  validateResponse,
  type Credential,
  type SurveyResponse,
} from "cip-179";

import {
  BINDABLE_ROLES,
  auditRevealedResponses,
  byCancellationChainOrder,
  bytesToHex,
  mechanismAProven,
  credentialKey,
  inSurveyWindow,
  isSealedUnsupported,
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
  rulesetHash,
  type ElectorateTotals,
  type RoleTally,
  type TallyArtifact,
  type TallyBody,
  type TallyBodyIdentity,
  type TallyInputSource,
  type WeightedResponder,
} from "cip-179/tally";
import {
  withResolvedScript,
  type ResolvedNativeScripts,
} from "cardano-tessera-koios";

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
  /** `tx_block_index` per tx of the bundle: its position in its block. */
  readonly blockIndices: ReadonlyMap<string, number>;
  /** Decoded proof evidence per tx of the bundle, from its CBOR. */
  readonly proofs: ReadonlyMap<string, TxProof | null>;
  /**
   * The native scripts of the records' credentials their transactions do not
   * witness, resolved by hash. Default: none found.
   */
  readonly scripts?: ResolvedNativeScripts;
  /** Membership + weights at `end_epoch`. */
  readonly weights: TallyInputSource;
  /**
   * This verifier's own electorate totals, to compare with the artifact's
   * unhashed `info`. A differing or unavailable total becomes a note and
   * never changes the verdict. Omitted: the totals are not compared.
   */
  readonly totals?: ElectorateTotals;
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
   * True when the rebuild couldn't reach a definite counted set — a proof it
   * needs could not be read, or a governance link needed to decide a
   * mechanism-B proof couldn't be resolved (finding 6).
   * `match` is then not meaningful (it is `false`, but this is NOT a MISMATCH);
   * the reasons are in `notes`. Re-run when the inputs are resolvable.
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
  /** Content hash of the artifact as received. */
  readonly receivedHash: string;
  /** Content hash of the independently rebuilt tally. */
  readonly rebuiltHash: string;
  readonly rebuilt: TallyBody;
  /**
   * The electorate totals this verifier read, in the artifact's `info` shape.
   * A role it could not read is left out, as is every role without
   * {@link VerifyInputs.totals} or without a MATCH or MISMATCH verdict.
   */
  readonly info: TallyArtifact["info"];
  /**
   * Caveats hit during the rebuild, and electorate totals that differ from the artifact's or could not be
   * re-fetched.
   */
  readonly notes: readonly string[];
  /** Human-readable differences, populated on mismatch. */
  readonly diffs: readonly string[];
}

const NO_TOTALS: TallyArtifact["info"] = { perRole: [] };
const COVERED_ROLES: readonly number[] = [...RULESET_DESCRIPTOR.coveredRoles];
const ROLE_DREP = 0;
const ROLE_KEYHOLDER = 4;

/**
 * Why a survey is untalliable, or null (the `definition-validity` ruleset
 * rule): a survey that is non-v5, structurally invalid, ending in the epoch
 * that published it, or defined by a transaction that never proved its
 * `owner` has no reproducible tally, and a conformant emitter writes no
 * artifact. Decided from the independently fetched record and defining-tx
 * evidence, so a backend can't dress an invalid survey up as talliable
 * (findings 10, 11, 45, 12). An owner proof that could not be read decides
 * nothing: only the record's own rules apply.
 */
export function untalliableReason(
  inputs: Pick<VerifyInputs, "bundle" | "proofs" | "scripts">,
): string | null {
  const record = inputs.bundle.survey;
  const def = record.definition;
  const survey = {
    ...record,
    proof: withResolvedScript(
      inputs.proofs.get(record.txHash),
      def.owner,
      def.endEpoch,
      inputs.scripts ?? new Map(),
    ),
  };
  if (isSurveyTalliable(survey)) return null;
  const codes = surveyErrors(survey)
    .map((p) => p.code)
    .join(", ");
  return `the survey is spec-invalid (${codes}), so it has no reproducible tally and no artifact should exist`;
}

/**
 * Rebuild the hashed tally body from chain data + the pinned ruleset. Needs no
 * artifact, so two sources' rebuilds can be compared with each other.
 * `indeterminate` lists every input the rebuild could not read or resolve;
 * empty when the counted set is decided.
 */
export async function rebuildTally(
  inputs: Omit<VerifyInputs, "artifact" | "totals">,
): Promise<{
  tally: TallyBody;
  notes: string[];
  indeterminate: string[];
  untalliable: string | null;
}> {
  const notes: string[] = [];
  const indeterminate: string[] = [];
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

  const scripts = inputs.scripts ?? new Map();
  const proofOf = (txHash: string, credential: Credential) =>
    withResolvedScript(
      inputs.proofs.get(txHash),
      credential,
      endEpoch,
      scripts,
    );
  const untalliable = untalliableReason(inputs);
  if (untalliable !== null)
    return { tally: emptyTallyBody(id), notes, indeterminate, untalliable };
  // Everything else was decidable from the record alone; the owner rule was not,
  // and an unread proof is unknown rather than unproven (finding 6's discipline).
  if (!proofOf(bundle.survey.txHash, def.owner)) {
    indeterminate.push(
      `the defining transaction ${bundle.survey.txHash} could not be fetched or decoded, or its owner script not looked up, so its owner-proof is unknown`,
    );
  }

  // Cancellation first: the earliest owner-proven, in-window cancellation (in
  // chain order — the choice the ruleset pins) short-circuits the tally. One
  // with an unknown proof before it could be the winner, so the emitter
  // postpones there, and the rebuild cannot decide either.
  const winning = [...bundle.cancellations]
    .sort(byCancellationChainOrder)
    .find((c) => {
      if (!inSurveyWindow(bundle.survey, c)) return false;
      const proof = proofOf(c.txHash, def.owner);
      return proof === null || mechanismAProven(def.owner, proof);
    });
  if (winning && !proofOf(winning.txHash, def.owner)) {
    indeterminate.push(
      `cancellation ${winning.txHash} could not be fetched or decoded, or its owner script not looked up, so whether it cancels is unknown`,
    );
  } else if (winning) {
    // Cancelled whatever the responses hold: only the reasons above count.
    if (indeterminate.length > 0)
      return {
        tally: emptyTallyBody(id),
        notes,
        indeterminate,
        untalliable: null,
      };
    return {
      tally: cancelledTallyBody(id, {
        txHash: winning.txHash,
        slot: winning.slot,
        epoch: winning.epochNo,
      }),
      notes,
      indeterminate,
      untalliable: null,
    };
  }

  // TALLY-SPEC §3 rules 1–3 from scratch: window (from the defining block
  // through end_epoch by the authoritative epochNo), validity (full codec
  // validation), credential proof (mechanism A/B), then latest-in-chain-order
  // per (role, credential).
  const unresolvedActionIds = inputs.unresolvedActionIds ?? [];
  const govLinksReliable = inputs.govLinksReliable ?? true;
  const eligible: ResponseRecord[] = [];
  for (const r of bundle.responses) {
    if (!inSurveyWindow(bundle.survey, r)) continue;
    if (validateResponse(def, r.response).length !== 0) continue;
    // Uncovered roles never count, so their proof verdict can't affect the
    // hash — filter them before the proof step (and before flagging indeterminacy
    // on an unresolvable link they'd be dropped for regardless).
    if (!COVERED_ROLES.includes(r.response.role)) continue;
    const proof = proofOf(r.txHash, r.response.credential);
    if (!proof) {
      indeterminate.push(
        `response ${r.txHash}:${r.responseIndex} has no proof evidence (the ` +
          `transaction could not be fetched or decoded, or a script lookup ` +
          `failed) — retry when it is readable`,
      );
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
      indeterminate.push(
        `credential proof for ${r.txHash}:${r.responseIndex} depends on a ` +
          `governance-link anchor this verifier could not resolve — the counted ` +
          `set cannot be reproduced; retry when the link is resolvable`,
      );
      continue;
    }
    if (verdict !== "proven") continue;
    const blockIndex = inputs.blockIndices.get(r.txHash);
    if (blockIndex === undefined) {
      // A proven, in-window response whose tx has no `tx_block_index` (the
      // source didn't resolve it): the dedup order (slot, tx_block_index,
      // response_index) can't be reproduced — the `-1` sentinel `laterInChain`
      // falls back to could resolve a same-slot tie differently. The emitter
      // POSTPONES finalization in exactly this case (`countedRows`), so match
      // that discipline: make the rebuild INDETERMINATE (retry when resolvable)
      // rather than silently risk a false MISMATCH (finding 16).
      indeterminate.push(
        `response ${r.txHash}:${r.responseIndex} has no tx_block_index ` +
          `(the source did not resolve it) — the counted order cannot be ` +
          `reproduced; retry when it is resolvable`,
      );
      continue;
    }
    eligible.push({ ...r, blockIndex });
  }
  // A single unknown makes the whole rebuild indeterminate: we can't produce
  // THE counted set, so a hash comparison would be misleading.
  if (indeterminate.length > 0) {
    return {
      tally: emptyTallyBody(id),
      notes,
      indeterminate,
      untalliable: null,
    };
  }
  let counted: ResponseRecord[];
  if (sealed) {
    const mode = def.submissionMode;
    if (mode.type !== "sealed") throw new Error("unreachable");
    if (isSealedUnsupported(def)) {
      // The emitter can't reveal a non-quicknet sealed survey either, so it
      // emits no artifact. Rebuild an empty tally: a served artifact for one is
      // spurious, and the loud MISMATCH that follows is the correct verdict.
      notes.push(
        "sealed survey on an unsupported (non-quicknet) drand chain — no reveal, empty tally",
      );
      return {
        tally: emptyTallyBody(id),
        notes,
        indeterminate,
        untalliable: null,
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
  // membership-filtered responders to the SHARED assembler (the emitter uses
  // the same `assembleTallyBody`, so role ordering, per-role artifact shaping,
  // and the base body can't drift). Weight sourcing and the membership filter
  // are inherently data-source-specific, so they stay here.
  const rolesPresent = [...new Set(counted.map((r) => r.response.role))].sort(
    (a, b) => a - b,
  );
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

    roles.push({ role, responders });
  }

  return {
    tally: assembleTallyBody(def, id, roles),
    notes,
    indeterminate,
    untalliable: null,
  };
}

/**
 * Compare the artifact's electorate totals with this verifier's own, for each
 * weighted role the rebuild counted. The totals only scale turnout, and ledger
 * implementations read them slightly differently, so a difference is a note.
 */
async function readTotals(
  totals: ElectorateTotals,
  artifact: TallyArtifact,
  rebuilt: TallyBody,
): Promise<{ info: TallyArtifact["info"]; notes: string[] }> {
  const stated = new Map(artifact.info.perRole.map((r) => [r.role, r.total]));
  const epoch = rebuilt.survey.endEpoch;
  const perRole: { role: number; total: string }[] = [];
  const notes: string[] = [];
  for (const { role } of rebuilt.perRole) {
    if (role === ROLE_KEYHOLDER) continue;
    const read =
      role === ROLE_DREP
        ? await totals.drepTotal(epoch)
        : await totals.stakeholderTotal(epoch);
    const claim = stated.get(role) ?? "none";
    if (read === null) {
      notes.push(
        `role ${role} total: the artifact states ${claim}, which this verifier could not re-fetch`,
      );
      continue;
    }
    perRole.push({ role, total: String(read) });
    if (claim !== String(read)) {
      notes.push(
        `role ${role} total: the artifact states ${claim}, this verifier reads ${read} (outside the hash)`,
      );
    }
  }
  return { info: { perRole }, notes };
}

/** Human-readable differences between the received and rebuilt tallies. */
function diffTallies(received: TallyBody, rebuilt: TallyBody): string[] {
  const diffs: string[] = [];
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
  const {
    tally: rebuilt,
    notes,
    indeterminate,
    untalliable,
  } = await rebuildTally(inputs);
  const rebuiltHash = artifactHash(rebuilt);

  const stated = inputs.artifact.provenance.rulesetHash;
  if (stated !== rulesetHash()) {
    notes.push(
      `ruleset: the artifact was counted under ${stated}, this verifier counts under ${rulesetHash()} ` +
        `(outside the hash; the cip-179 README's table names the release for each)`,
    );
  }

  // An untalliable survey has no reproducible tally: a served artifact is itself
  // a backend non-conformance (a conformant emitter writes none), so this is
  // neither MATCH nor MISMATCH regardless of what the artifact hashes to.
  if (untalliable !== null) {
    return {
      match: false,
      indeterminate: false,
      untalliable: true,
      receivedHash,
      rebuiltHash,
      rebuilt,
      info: NO_TOTALS,
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

  if (indeterminate.length > 0) {
    return {
      match: false,
      indeterminate: true,
      untalliable: false,
      receivedHash,
      rebuiltHash,
      rebuilt,
      info: NO_TOTALS,
      notes: [...notes, ...indeterminate],
      diffs: [],
    };
  }

  let info = NO_TOTALS;
  if (inputs.totals) {
    const read = await readTotals(inputs.totals, inputs.artifact, rebuilt);
    info = read.info;
    notes.push(...read.notes);
  }
  const match = rebuiltHash === receivedHash;
  return {
    match,
    indeterminate: false,
    untalliable: false,
    receivedHash,
    rebuiltHash,
    rebuilt,
    info,
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
