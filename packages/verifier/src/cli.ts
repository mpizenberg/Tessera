/**
 * Verifier CLI:
 *
 *   pnpm --filter @tessera/verifier verify -- \
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
 * no artifact / survey not found on-chain / fetch failure.
 */

import { exit } from "node:process";

import type { SurveyRef } from "cip-179";

import {
  KOIOS_URL,
  SECONDS_PER_EPOCH,
  fromJsonSafe,
  hexToBytes,
  refKey,
  type AppConfig,
  type Network,
  type SurveyBundle,
  type TallyArtifact,
} from "@tessera/core";
import { KoiosDataSource, KoiosTallyInputs } from "@tessera/koios";

import { diffResponseSets, linkedActionIdFor, verifyArtifact } from "./verify";

/**
 * Compare the backend's served bundle against the independent chain scan, purely
 * to give the operator an explicit diagnostic. It changes nothing about the
 * rebuild (which always uses the chain set): a divergence here is exactly what
 * would surface downstream as a hash MISMATCH — this just names it. Best-effort;
 * a fetch/parse failure yields a single note and no cross-check.
 */
async function crossCheckBackendBundle(
  url: string,
  chain: SurveyBundle,
): Promise<string[]> {
  let backend: SurveyBundle;
  try {
    backend = fromJsonSafe(await getJson<unknown>(url)) as SurveyBundle;
  } catch (err) {
    return [`backend bundle unavailable for cross-check (${String(err)})`];
  }
  return diffResponseSets(chain.responses, backend.responses);
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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function main(): Promise<void> {
  const backend = argOf("backend");
  const surveyArg = argOf("survey");
  if (!backend || !surveyArg) usage();
  const m = /^([0-9a-fA-F]{64}):(\d+)$/.exec(surveyArg);
  if (!m) usage();
  const [, txHash, index] = m;
  const base = backend.replace(/\/$/, "");

  // The backend's network decides which Koios instance re-verifies it.
  const health = await getJson<{ network?: string }>(`${base}/health`);
  const network = (health.network ?? "preview") as Network;
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
  // artifact-to-verify introduces no trust (a doctored artifact just fails).
  const artifactRes = await fetch(
    `${base}/api/surveys/${txHash}/${index}/artifact`,
    { headers: { Accept: "application/json" } },
  );
  if (artifactRes.status === 404) {
    console.error("no artifact for this survey yet (open, or not finalized)");
    exit(2);
  }
  if (!artifactRes.ok)
    throw new Error(`artifact fetch → ${artifactRes.status}`);
  const artifact = (await artifactRes.json()) as TallyArtifact;

  // 2. Independently reconstruct the survey's on-chain slice from a Koios
  // label-17 scan — the definition, the response *set*, and every response's
  // *answers*. This is the crux of the trust story: the backend never supplies
  // the records the tally is built from, so it cannot omit or alter a response
  // and still reproduce the hash.
  const source = new KoiosDataSource(config);
  const ref: SurveyRef = { txId: hexToBytes(txHash!), index: Number(index) };
  const records = await source.fetchAll();
  const key = refKey(ref);
  const survey = records.surveys.find((s) => refKey(s.ref) === key);
  if (!survey) {
    console.error(
      `survey ${key} not found in an independent Koios scan since ` +
        `${new Date(config.sinceUnix * 1000).toISOString()}. If it is older ` +
        `than that floor, re-run with an earlier --since.`,
    );
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
  preNotes.push(
    ...(await crossCheckBackendBundle(
      `${base}/api/surveys/${txHash}/${index}`,
      bundle,
    )),
  );

  // 3. The remaining independent inputs, all straight from Koios.
  const txHashes = [
    ...new Set([
      ...bundle.responses.map((r) => r.txHash),
      ...bundle.cancellations.map((c) => c.txHash),
    ]),
  ];
  const [blockIndices, proofs, govLinks] = await Promise.all([
    source.txBlockIndices(txHashes),
    source.txProofs(txHashes),
    source.fetchGovernanceLinks(config.sinceUnix).catch((err) => {
      console.warn(`gov links unavailable (${String(err)}) — assuming none`);
      return [];
    }),
  ]);

  // 4. Rebuild + compare.
  const result = await verifyArtifact({
    bundle,
    artifact,
    network,
    linkedActionId: linkedActionIdFor(bundle, govLinks),
    blockIndices,
    proofs,
    weights: new KoiosTallyInputs(config),
  });

  for (const note of preNotes) console.warn(`note: ${note}`);
  for (const note of result.notes) console.warn(`note: ${note}`);
  console.log(`received hash: ${result.receivedHash}`);
  console.log(`rebuilt hash:  ${result.rebuiltHash}`);
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
