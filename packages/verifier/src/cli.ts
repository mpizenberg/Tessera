/**
 * Verifier CLI:
 *
 *   pnpm --filter cardano-tessera-verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     [--koios <url>] [--token <koios token>] [--out <dir>]
 *
 *   pnpm --filter cardano-tessera-verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     --dolos <dir> [--out <dir>]
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
 * source: Koios by default, or the store of a Dolos node stopped at the first
 * block of `end_epoch + 1` (`--dolos`), which the verifier serves itself to
 * read the chain through its mini-Blockfrost and minikupo APIs, then stops to
 * read the ledger at the end of `end_epoch` from it, or a directory of
 * `amaru-store-reader` output (`--amaru`): snapshot `end_epoch`, the ledger
 * at that epoch's end, and a block walk spanning the survey's window, with Koios
 * resolving native scripts by hash under `--koios-scripts` (Amaru keeps no
 * script index, and a record's own transaction rarely witnesses its script;
 * without the flag such a record is unproven). The tally is
 * rebuilt under the pinned ruleset and its content hash compared; the
 * electorate totals, outside the hash, are re-fetched too when the source is
 * Koios, and a difference is printed as a note, as is a ruleset other than
 * the pinned one named in the artifact's provenance. On a MATCH or MISMATCH,
 * `--out <dir>` keeps both artifacts there: `rebuilt.json`, this verifier's
 * (its tally, the totals it read, its own provenance), and `served.json`, the
 * artifact under test.
 * Exit codes: 0 MATCH, 1 MISMATCH (differences printed), 2 usage / not
 * finalized / survey not found on-chain / fetch failure, 3 INDETERMINATE (a
 * required input — e.g. a governance-link anchor, or a missing
 * tx_block_index — could not be resolved, so no verdict is possible yet; retry
 * when resolvable), 4 UNTALLIABLE (the survey's on-chain definition is
 * spec-invalid, or its defining transaction never proved the owner, so it has
 * no reproducible tally and no artifact should exist; findings 10, 11, 45,
 * 12).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exit } from "node:process";
import { parseArgs } from "node:util";

import type { SurveyBundle } from "cip-179/domain";
import {
  rulesetHash,
  type ElectorateTotals,
  type TallyArtifact,
  type TallyInputSource,
} from "cip-179/tally";
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
import { DolosChain, DolosNode, DolosTallyInputs } from "cardano-tessera-dolos";
import { KoiosDataSource, KoiosTallyInputs } from "cardano-tessera-koios";
import { fetchBeacon, revealWithBeacon } from "cip-179/tlock";
import { evolutionCodec } from "cip-179/evolution";

import { saveArtifacts } from "./save";
import {
  chainEvidence,
  koiosChain,
  ownerEvidence,
  type SurveyChain,
} from "./sources";
import { diffResponseSets, untalliableReason, verifyArtifact } from "./verify";

const flags = readFlags();

interface Sources {
  readonly chain: SurveyChain;
  readonly weights: TallyInputSource;
  readonly totals?: ElectorateTotals;
  readonly source: TallyArtifact["provenance"]["source"];
}

function koiosConfig(network: Network): AppConfig {
  return {
    network,
    koiosUrl: flags.koios ?? KOIOS_URL[network],
    koiosToken: flags.token ?? process.env["KOIOS_TOKEN"] ?? undefined,
    // Unread: the scan starts at the survey's defining transaction.
    sinceUnix: 0,
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  };
}

function koiosSources(network: Network): Sources {
  const config = koiosConfig(network);
  const koios = new KoiosTallyInputs(config);
  return {
    chain: koiosChain(config),
    weights: koios,
    totals: koios,
    source: { provider: "koios", baseUrl: config.koiosUrl },
  };
}

function amaruSources(network: Network, dir: string): Sources {
  const stores = new AmaruStores(dir);
  const koios = flags["koios-scripts"]
    ? new KoiosDataSource(koiosConfig(network))
    : null;
  return {
    chain: new AmaruChain(
      stores,
      network,
      koios ? (hashes) => koios.nativeScripts(hashes) : undefined,
    ),
    weights: new AmaruTallyInputs(stores),
    source: { provider: "amaru", baseUrl: pathToFileURL(dir).href },
  };
}

/**
 * The chain is read while the node is served, the ledger once the weights
 * stop it; the rebuild asks for every chain input before any weight.
 */
async function dolosSources(network: Network, dir: string): Promise<Sources> {
  const node = new DolosNode(dir);
  const { minibf, minikupo } = await node.serve();
  return {
    chain: new DolosChain(minibf, minikupo),
    weights: new DolosTallyInputs(node, network),
    source: { provider: "dolos", baseUrl: pathToFileURL(dir).href },
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
      "--dolos <dir> [--out <dir>]\n" +
      "       verify --backend <url> --survey <txHash>:<index> " +
      "--amaru <dir> [--koios-scripts [--koios <url>] [--token <koios token>]] [--out <dir>]",
  );
  exit(2);
}

function untalliable(served: boolean): never {
  if (served) {
    console.warn(
      "note: the backend served an artifact for this survey, but no " +
        "artifact should exist",
    );
  }
  console.log(
    "UNTALLIABLE — the survey is spec-invalid (see the note above), so it " +
      "has no reproducible tally (this is neither MATCH nor MISMATCH)",
  );
  exit(4);
}

function readFlags() {
  // `pnpm <script> -- <flags>` hands the script its `--` as well.
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  try {
    return parseArgs({
      args,
      options: {
        backend: { type: "string" },
        survey: { type: "string" },
        koios: { type: "string" },
        token: { type: "string" },
        out: { type: "string" },
        dolos: { type: "string" },
        amaru: { type: "string" },
        "koios-scripts": { type: "boolean" },
      },
    }).values;
  } catch (err) {
    console.error((err as Error).message);
    return usage();
  }
}

/** pnpm runs the script from its package; `INIT_CWD` is where it was invoked. */
function pathOf(p: string | undefined): string | undefined {
  return p === undefined
    ? undefined
    : resolve(process.env["INIT_CWD"] ?? "", p);
}

async function main(): Promise<void> {
  const { backend, survey: surveyArg } = flags;
  const out = pathOf(flags.out);
  if (!backend || !surveyArg) usage();
  const m = /^([0-9a-fA-F]{64}):(\d+)$/.exec(surveyArg);
  if (!m) usage();
  const txHash = m[1]!.toLowerCase();
  const index = m[2]!;
  const key = `${txHash}:${index}`;
  const client = createTesseraClient({ baseUrl: backend });

  // The backend's network decides which chain the rebuild reads.
  const network = parseNetwork((await client.liveness()).network);
  const dolosDir = pathOf(flags.dolos);
  const amaruDir = pathOf(flags.amaru);
  const { chain, weights, totals, source } = dolosDir
    ? await dolosSources(network, dolosDir)
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

  // Talliability is decided from the *independent* record and defining
  // transaction, never from the artifact, so a backend cannot make an invalid
  // survey look talliable. With an artifact the rebuild decides it; without
  // one, only the defining transaction is read, to tell an untalliable survey
  // (which has no artifact by design) from one not finalized yet.
  if (!artifact) {
    const reason = untalliableReason({
      bundle,
      ...(await ownerEvidence(chain, bundle)),
    });
    if (reason !== null) {
      console.warn(`note: ${reason}`);
      untalliable(false);
    }
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
  let sealedReveal: TallyArtifact["provenance"]["sealedReveal"];
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
    reveal: async (records, { chainHash, round }) => {
      const beacon = await fetchBeacon(round);
      const { randomness, signature } = beacon;
      sealedReveal = {
        chainHash,
        round,
        beacon: { round, randomness, signature },
      };
      return revealWithBeacon(
        evolutionCodec,
        records.map((r) => r.response),
        beacon,
      );
    },
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
  if (out) {
    const rebuilt: TallyArtifact = {
      tally: result.rebuilt,
      info: result.info,
      provenance: {
        rulesetHash: rulesetHash(),
        source,
        fetchedAt: Math.floor(Date.now() / 1000),
        byRole: [],
        // A cancellation has no links evaluated, as in the emitter's.
        ...(!result.rebuilt.cancelled && {
          govLinks: [...evidence.linkedActionIds].sort(),
        }),
        ...(sealedReveal && { sealedReveal }),
      },
    };
    await saveArtifacts(out, rebuilt, artifact);
    console.log(`saved rebuilt.json and served.json in ${out}`);
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
