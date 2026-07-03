/**
 * Verifier CLI:
 *
 *   pnpm --filter @tessera/verifier verify -- \
 *     --backend https://<backend> --survey <txHash>:<index> \
 *     [--koios <url>] [--token <koios token>] [--since <ISO date>]
 *
 * Fetches the survey bundle + artifact from the backend, refetches every
 * verification input from Koios (proofs, block indices, weights, totals,
 * governance links), rebuilds the tally under the pinned ruleset, and compares
 * content hashes. Exit codes: 0 MATCH, 1 MISMATCH (differences printed),
 * 2 usage / no artifact / fetch failure.
 */

import { exit } from "node:process";

import {
  KOIOS_URL,
  SECONDS_PER_EPOCH,
  fromJsonSafe,
  type AppConfig,
  type Network,
  type SurveyBundle,
  type TallyArtifact,
} from "@tessera/core";
import { KoiosDataSource, KoiosTallyInputs } from "@tessera/koios";

import { linkedActionIdFor, verifyArtifact } from "./verify";

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

  // 1. The two backend reads: the survey's raw slice + the artifact.
  const bundle = fromJsonSafe(
    await getJson<unknown>(`${base}/api/surveys/${txHash}/${index}`),
  ) as SurveyBundle;
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

  // 2. Independent inputs, all straight from Koios.
  const source = new KoiosDataSource(config);
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

  // 3. Rebuild + compare.
  const result = await verifyArtifact({
    bundle,
    artifact,
    network,
    linkedActionId: linkedActionIdFor(bundle, govLinks),
    blockIndices,
    proofs,
    weights: new KoiosTallyInputs(config),
  });

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
