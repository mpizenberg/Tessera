/**
 * Verifier CLI:
 *
 *   pnpm --filter cardano-tessera-verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     [--koios <url>] [--token <koios token>] [--out <dir>]
 *
 *   pnpm --filter cardano-tessera-verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     --dolos-end <url> --dolos-after <url> [--minikupo <url>] [--out <dir>]
 *
 *   pnpm --filter cardano-tessera-verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     --amaru <dir> [--koios-scripts [--koios <url>] [--token <koios token>]] \
 *     [--out <dir>]
 *
 * Fetches ONLY the artifact-under-test from the backend. The survey definition,
 * the response *set*, and every response's *answers* are re-derived by an
 * independent label-17 scan — never taken from the backend — so a backend
 * that omits or alters responses can no longer reproduce a matching hash (it
 * would rebuild against the real chain data and diverge). Every other input
 * (proofs, block indices, weights, governance links) comes from the same
 * source: Koios by default, or two Dolos nodes' mini-Blockfrost APIs, one
 * stopped at the last block of the survey's `end_epoch` (`--dolos-end`) and
 * one at least a block into `end_epoch + 2` (`--dolos-after`), with the
 * second's minikupo API resolving native scripts by hash, or a directory of
 * `amaru-store-reader` output (`--amaru`): the snapshots of `end_epoch - 2`
 * to `end_epoch` and a block walk spanning the survey's window, with Koios
 * resolving native scripts by hash under `--koios-scripts` (Amaru keeps no
 * script index, and a record's own transaction rarely witnesses its script;
 * without the flag such a proof is unknown). The tally is
 * rebuilt under the pinned ruleset and its content hash compared; the
 * electorate totals, outside the hash, are re-fetched too when the source is
 * Koios, and a difference is printed as a note, as is a ruleset other than
 * the pinned one named in the artifact's provenance. On a MATCH or MISMATCH,
 * `--out <dir>` keeps both sides there: `rebuilt.json`, the exact bytes the
 * rebuilt hash is computed over, and `served.json`, the artifact under test.
 * Exit codes: 0 MATCH, 1 MISMATCH (differences printed), 2 usage / not
 * finalized / survey not found on-chain / fetch failure, 3 INDETERMINATE (a
 * required input — e.g. a governance-link anchor, or a missing
 * tx_block_index — could not be resolved, so no verdict is possible yet; retry
 * when resolvable), 4 UNTALLIABLE (the survey's on-chain definition is
 * spec-invalid, or its defining transaction never proved the owner, so it has
 * no reproducible tally and no artifact should exist; findings 10, 11, 45,
 * 12).
 */

import { exit } from "node:process";

import { isSurveyTalliable, surveyErrors } from "cip-179";

import type { SurveyBundle } from "cip-179/domain";
import type { ElectorateTotals, TallyInputSource } from "cip-179/tally";
import {
  createTesseraClient,
  parseNetwork,
  SECONDS_PER_EPOCH,
  type Network,
  type TesseraClient,
} from "cardano-tessera-client";
import {
  AmaruChain,
  AmaruStores,
  AmaruTallyInputs,
} from "cardano-tessera-amaru";
import { KOIOS_URL, type AppConfig } from "cardano-tessera-core";
import { DolosChain, DolosTallyInputs, Minibf } from "cardano-tessera-dolos";
import { KoiosDataSource, KoiosTallyInputs } from "cardano-tessera-koios";
import { revealResponses } from "cip-179/tlock";
import { evolutionCodec } from "cip-179/evolution";

import { saveTallies } from "./save";
import { chainEvidence, koiosChain, type SurveyChain } from "./sources";
import { diffResponseSets, verifyArtifact } from "./verify";

interface Sources {
  readonly chain: SurveyChain;
  readonly weights: TallyInputSource;
  readonly totals?: ElectorateTotals;
}

function koiosConfig(network: Network): AppConfig {
  return {
    network,
    koiosUrl: argOf("koios") ?? KOIOS_URL[network],
    koiosToken: argOf("token") ?? process.env["KOIOS_TOKEN"] ?? undefined,
    // Unread: the scan starts at the survey's defining transaction.
    sinceUnix: 0,
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
}

function koiosSources(network: Network): Sources {
  const config = koiosConfig(network);
  const koios = new KoiosTallyInputs(config);
  return { chain: koiosChain(config), weights: koios, totals: koios };
}

function amaruSources(network: Network, dir: string): Sources {
  const stores = new AmaruStores(dir);
  const koios = process.argv.includes("--koios-scripts")
    ? new KoiosDataSource(koiosConfig(network))
    : null;
  return {
    chain: new AmaruChain(
      stores,
      network,
      koios ? (missing) => koios.resolveNativeScripts(missing) : undefined,
    ),
    weights: new AmaruTallyInputs(stores),
  };
}

function dolosSources(network: Network, endUrl: string): Sources {
  const afterUrl = argOf("dolos-after");
  if (!afterUrl) usage();
  const after = new Minibf(afterUrl);
  return {
    chain: new DolosChain(after, argOf("minikupo")),
    weights: new DolosTallyInputs(new Minibf(endUrl), after, network),
  };
}

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

function usage(): never {
  console.error(
    "usage: verify --backend <url> --survey <txHash>:<index> " +
      "[--koios <url>] [--token <koios token>] [--out <dir>]\n" +
      "       verify --backend <url> --survey <txHash>:<index> " +
      "--dolos-end <url> --dolos-after <url> [--minikupo <url>] [--out <dir>]\n" +
      "       verify --backend <url> --survey <txHash>:<index> " +
      "--amaru <dir> [--koios-scripts [--koios <url>] [--token <koios token>]] [--out <dir>]",
  );
  exit(2);
}

function untalliable(served: boolean): never {
  if (served) {
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

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const backend = argOf("backend");
  const surveyArg = argOf("survey");
  const out = argOf("out");
  if (!backend || !surveyArg) usage();
  const m = /^([0-9a-fA-F]{64}):(\d+)$/.exec(surveyArg);
  if (!m) usage();
  const txHash = m[1]!.toLowerCase();
  const index = m[2]!;
  const key = `${txHash}:${index}`;
  const client = createTesseraClient({ baseUrl: backend });

  // The backend's network decides which chain the rebuild reads.
  const network = parseNetwork((await client.liveness()).network);
  const dolosEnd = argOf("dolos-end");
  const amaruDir = argOf("amaru");
  const { chain, weights, totals } = dolosEnd
    ? dolosSources(network, dolosEnd)
    : amaruDir
      ? amaruSources(network, amaruDir)
      : koiosSources(network);

  // 1. The ONE backend read: the artifact under test. Its hash is recomputed
  // from independent chain data below, so trusting the backend to hand us the
  // artifact-to-verify introduces no trust (a doctored artifact just fails). A
  // 404 is NOT decided yet: it may mean "not finalized" or "untalliable" (an
  // invalid definition legitimately has no artifact) — the independent scan
  // below distinguishes them, so defer the verdict.
  const artifact = await client.artifact(key);

  // 2. Independently reconstruct the survey's on-chain slice from a label-17
  // scan — the definition, the response *set*, and every response's
  // *answers*. This is the crux of the trust story: the backend never supplies
  // the records the tally is built from, so it cannot omit or alter a response
  // and still reproduce the hash.
  const { bundle, incomplete } = await chain.bundle(key);
  const survey = bundle.survey;

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
    untalliable(artifact !== null);
  }
  if (!artifact) {
    console.error("no artifact for this survey yet (open, or not finalized)");
    exit(2);
  }

  const preNotes: string[] = [];
  if (incomplete) {
    preNotes.push(
      "independent Koios scan is INCOMPLETE (a page or metadata batch it " +
        "could not read, or its paging cap) — a " +
        "MISMATCH may be a false alarm (missing responders); a MATCH is still sound",
    );
  }
  preNotes.push(...(await crossCheckBackendBundle(client, key, bundle)));

  // 3. The remaining independent inputs, from the same source.
  const evidence = await chainEvidence(chain, bundle);

  // 4. Rebuild + compare.
  const result = await verifyArtifact({
    bundle,
    artifact,
    network,
    ...evidence,
    weights,
    ...(totals && { totals }),
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
  if (result.untalliable) untalliable(true);
  console.log(`received hash: ${result.receivedHash}`);
  console.log(`rebuilt hash:  ${result.rebuiltHash}`);
  if (result.indeterminate) {
    console.log(
      "INDETERMINATE — a required input could not be resolved (see notes " +
        "above); this is not a MISMATCH. Retry when the input is resolvable.",
    );
    exit(3);
  }
  if (out) await saveTallies(out, result.rebuilt, artifact);
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
