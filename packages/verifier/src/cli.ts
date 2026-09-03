/**
 * Verifier CLI:
 *
 *   pnpm --filter cardano-tessera-verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     [--koios <url>] [--token <koios token>] [--since <ISO date>]
 *
 * Fetches ONLY the artifact-under-test from the backend. The survey definition,
 * the response *set*, and every response's *answers* are re-derived by an
 * independent Koios label-17 scan — never taken from the backend — so a backend
 * that omits or alters responses can no longer reproduce a matching hash (it
 * would rebuild against the real chain data and diverge). Every other input
 * (proofs, block indices, weights, totals, governance links) also comes straight
 * from Koios. The tally is rebuilt under the pinned ruleset and its content hash
 * compared. Exit codes: 0 MATCH, 1 MISMATCH (differences printed), 2 usage /
 * not finalized / survey not found on-chain / fetch failure, 3 INDETERMINATE (a
 * required input — e.g. a governance-link anchor, or a missing tx_block_index —
 * could not be resolved, so no verdict is possible yet; retry when resolvable),
 * 4 UNTALLIABLE (the survey's on-chain definition is spec-invalid — non-v5 or
 * structurally invalid — so it has no reproducible tally and no artifact should
 * exist; findings 10/11), 5 MATCH-BUT-UNVERIFIED-TOTAL (everything reproduced,
 * but an electorate total could not be independently re-fetched and was taken
 * from the artifact itself, so that one denominator is unconfirmed; finding 31).
 */

import { exit } from "node:process";

import { isSurveyTalliable, surveyErrors } from "cip-179";

import {
  refKey,
  scriptCredentialHash,
  type SurveyBundle,
} from "cip-179/domain";
import {
  createTesseraClient,
  parseNetwork,
  SECONDS_PER_EPOCH,
  type TesseraClient,
} from "cardano-tessera-client";
import { KOIOS_URL, type AppConfig } from "cardano-tessera-core";
import { KoiosDataSource, KoiosTallyInputs } from "cardano-tessera-koios";
import { revealResponses } from "cip-179/tlock";
import { evolutionCodec } from "cip-179/evolution";

import { diffResponseSets, linkedActionIdsFor, verifyArtifact } from "./verify";

/**
 * Compare the backend's served bundle against the independent chain scan, purely
 * to give the operator an explicit diagnostic. It changes nothing about the
 * rebuild (which always uses the chain set): a divergence here is exactly what
 * would surface downstream as a hash MISMATCH — this just names it. Best-effort;
 * a fetch/parse failure yields a single note and no cross-check.
 */
async function crossCheckBackendBundle(
  client: TesseraClient,
  key: string,
  chain: SurveyBundle,
): Promise<string[]> {
  try {
    // Every page, or the diff would report the unread tail as missing
    // responders — a false MISMATCH.
    const answer = await client.wholeBundle(key);
    if (!answer.ready)
      return ["backend snapshot not ready — no bundle to cross-check"];
    return diffResponseSets(chain.responses, answer.body.responses);
  } catch (err) {
    return [`backend bundle unavailable for cross-check (${String(err)})`];
  }
}

/** Matches the backend's snapshot floor; only affects gov-link discovery. */
const SINCE_ISO_DEFAULT = "2026-06-01T00:00:00Z";

function usage(): never {
  console.error(
    "usage: verify --backend <url> --survey <txHash>:<index> " +
      "[--koios <url>] [--token <koios token>] [--since <ISO date>]",
  );
  exit(2);
}

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const backend = argOf("backend");
  const surveyArg = argOf("survey");
  if (!backend || !surveyArg) usage();
  const m = /^([0-9a-fA-F]{64}):(\d+)$/.exec(surveyArg);
  if (!m) usage();
  const txHash = m[1]!.toLowerCase();
  const index = m[2]!;
  const key = `${txHash}:${index}`;
  const client = createTesseraClient({ baseUrl: backend });

  // The backend's network decides which Koios instance re-verifies it.
  const network = parseNetwork((await client.liveness()).network);
  const config: AppConfig = {
    network,
    koiosUrl: argOf("koios") ?? KOIOS_URL[network],
    koiosToken: argOf("token") ?? process.env["KOIOS_TOKEN"] ?? undefined,
    sinceUnix: Math.floor(
      Date.parse(argOf("since") ?? SINCE_ISO_DEFAULT) / 1000,
    ),
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };

  // 1. The ONE backend read: the artifact under test. Its hash is recomputed
  // from independent chain data below, so trusting the backend to hand us the
  // artifact-to-verify introduces no trust (a doctored artifact just fails). A
  // 404 is NOT decided yet: it may mean "not finalized" or "untalliable" (an
  // invalid definition legitimately has no artifact) — the independent scan
  // below distinguishes them, so defer the verdict.
  const artifact = await client.artifact(key);

  // 2. Independently reconstruct the survey's on-chain slice from a Koios
  // label-17 scan — the definition, the response *set*, and every response's
  // *answers*. This is the crux of the trust story: the backend never supplies
  // the records the tally is built from, so it cannot omit or alter a response
  // and still reproduce the hash.
  const source = new KoiosDataSource(config);
  const records = await source.fetchAll();
  const survey = records.surveys.find((s) => refKey(s.ref) === key);
  if (!survey) {
    console.error(
      `survey ${key} not found in an independent Koios scan since ` +
        `${new Date(config.sinceUnix * 1000).toISOString()}. If it is older ` +
        `than that floor, re-run with an earlier --since.`,
    );
    exit(2);
  }

  // Talliability is decided from the *independent* on-chain definition, not from
  // the artifact — so a backend cannot make an invalid survey look talliable. An
  // untalliable survey (non-v5 or spec-invalid definition, findings 10/11) must
  // have no artifact; if one was served anyway the backend is non-conformant,
  // which we surface rather than trying to verify a tally that shouldn't exist.
  // Only the rules the record decides on its own are checked here, before any
  // fetching; the owner-proof rule needs the defining tx and is applied by
  // `rebuildTally`, which reaches the same UNTALLIABLE verdict.
  if (!isSurveyTalliable(survey)) {
    for (const p of surveyErrors(survey))
      console.warn(`note: definition problem: ${p.code}`);
    if (artifact) {
      console.warn(
        "note: the backend served an artifact for this survey, but its " +
          "definition is spec-invalid — no artifact should exist",
      );
    }
    console.log(
      "UNTALLIABLE — the survey's on-chain definition is spec-invalid, so it " +
        "has no reproducible tally (this is neither MATCH nor MISMATCH)",
    );
    exit(4);
  }
  if (!artifact) {
    console.error("no artifact for this survey yet (open, or not finalized)");
    exit(2);
  }

  const bundle: SurveyBundle = {
    survey,
    responses: records.responses.filter(
      (r) => refKey(r.response.surveyRef) === key,
    ),
    cancellations: records.cancellations.filter(
      (c) => refKey(c.target) === key,
    ),
    tip: await source.chainTip(),
  };

  const preNotes: string[] = [];
  if (records.incomplete) {
    preNotes.push(
      "independent Koios scan hit its paging cap and is INCOMPLETE — a " +
        "MISMATCH may be a false alarm (missing responders); a MATCH is still sound",
    );
  }
  preNotes.push(...(await crossCheckBackendBundle(client, key, bundle)));

  // 3. The remaining independent inputs, all straight from Koios.
  const txHashes = [
    ...new Set([
      // The defining tx: CIP-179 requires it to prove the survey's owner, so its
      // evidence gates talliability exactly like a cancellation's does.
      bundle.survey.txHash,
      ...bundle.responses.map((r) => r.txHash),
      ...bundle.cancellations.map((c) => c.txHash),
    ]),
  ];
  // Native-script credentials whose script may not be attached to the carrying
  // tx: resolve them by hash so mechanism A is evaluated the same way the emitter
  // does (finding 7). Cancellations all target this survey → its owner.
  const neededScripts = new Map<string, string[]>();
  const addNeeded = (txHash: string, scriptHash: string | null) => {
    if (!scriptHash) return;
    const list = neededScripts.get(txHash);
    if (list) list.push(scriptHash);
    else neededScripts.set(txHash, [scriptHash]);
  };
  const ownerScriptHash = scriptCredentialHash(bundle.survey.definition.owner);
  addNeeded(bundle.survey.txHash, ownerScriptHash);
  for (const c of bundle.cancellations) addNeeded(c.txHash, ownerScriptHash);
  for (const r of bundle.responses)
    addNeeded(r.txHash, scriptCredentialHash(r.response.credential));

  // Only actions expiring with this survey can link it, or — unresolved — cloud
  // its mechanism-B verdicts, so the scan reads that one epoch and no more. Each
  // action's anchor is dereferenced here and checked against its on-chain hash:
  // the whole point of this tool is that no input is taken on trust, and an
  // indexer's own resolution of an anchor can never be re-verified after the
  // fact. No time budget — a verification may take as long as the anchors do.
  const endEpoch = bundle.survey.definition.endEpoch;
  let govLinksReliable = true;
  const [blockIndices, proofs, govScan] = await Promise.all([
    source.txBlockIndices(txHashes),
    source.txProofs(txHashes, neededScripts),
    source.fetchGovernanceLinks([endEpoch]).catch((err) => {
      // A fetch failure is UNKNOWN, not "no links" — flag it so a mechanism-B
      // proof it might decide comes back INDETERMINATE, never a silent exclude.
      console.warn(
        `gov links unavailable (${String(err)}) — treating as unresolved`,
      );
      govLinksReliable = false;
      return { links: [], unresolved: [] };
    }),
  ]);
  const unresolvedActionIds = govScan.unresolved.map((u) => u.actionId);

  // 4. Rebuild + compare.
  const result = await verifyArtifact({
    bundle,
    artifact,
    network,
    linkedActionIds: linkedActionIdsFor(bundle, govScan.links),
    unresolvedActionIds,
    govLinksReliable,
    blockIndices,
    proofs,
    weights: new KoiosTallyInputs(config),
    // Sealed reveal, wired independently of the backend: fetch (and BLS-verify)
    // the drand beacon ourselves, then decrypt offline. Unused for public
    // artifacts.
    reveal: (records, { round }) =>
      revealResponses(
        evolutionCodec,
        records.map((r) => r.response),
        round,
      ),
  });

  for (const note of preNotes) console.warn(`note: ${note}`);
  for (const note of result.notes) console.warn(`note: ${note}`);
  console.log(`received hash: ${result.receivedHash}`);
  console.log(`rebuilt hash:  ${result.rebuiltHash}`);
  if (result.indeterminate) {
    console.log(
      "INDETERMINATE — a required input could not be resolved (see notes " +
        "above); this is not a MISMATCH. Retry when the input is resolvable.",
    );
    exit(3);
  }
  if (result.match && result.unverifiedTotals) {
    // Everything reproduced, but at least one hash-committed electorate total
    // was taken from the artifact itself (the upstream couldn't serve it), so
    // that denominator was assumed, not confirmed — a weaker verdict than a
    // clean MATCH, and a distinct exit code so a scripted verify fails closed
    // (finding 31). Retry when the total endpoint is back.
    console.log(
      "MATCH (unverified total) — the artifact reproduces from independent " +
        "chain data, but one or more electorate totals could not be re-fetched " +
        "and were taken from the artifact itself (see notes); that denominator " +
        "is unconfirmed. Retry when the upstream total endpoint is available.",
    );
    exit(5);
  }
  if (result.match) {
    console.log("MATCH — the artifact reproduces from chain data");
    exit(0);
  }
  console.log("MISMATCH — differences:");
  for (const d of result.diffs) console.log(`  - ${d}`);
  exit(1);
}

main().catch((err) => {
  console.error(String(err));
  exit(2);
});
