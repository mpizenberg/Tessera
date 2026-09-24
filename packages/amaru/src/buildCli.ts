/**
 * Builds the Amaru stores a survey's audit reads, and the files the verifier
 * takes from them:
 *
 *   pnpm --filter cardano-tessera-amaru build-stores -- \
 *     --backend https://<backend> --survey <txHash>:<index> --dir <dir> \
 *     [--amaru <amaru binary>]
 *
 * into `<dir>`, printing each command before running it, then prints the
 * command that verifies the survey against them. The backend gives only the
 * network and the survey's position: a creation slot too late leaves the
 * definition out of the walk, and the verifier checks the walk against the
 * `end_epoch` it reads from the chain. Needs `amaru` (or `--amaru`) and
 * `cargo`, which builds `packages/amaru-store-reader` with its own toolchain.
 */

import { spawnSync, type StdioOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exit } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createTesseraClient, parseNetwork } from "cardano-tessera-client";

import {
  BLOCKS,
  CREDENTIALS,
  bootstrapArgs,
  bootstrapEpoch,
  bootstrapEpochs,
  ledgerDir,
  nextStep,
  snapshotFile,
  type StoresState,
  type SurveyTarget,
} from "./build";
import { surveyWindow } from "./chain";
import { askedCredentials } from "./credentials";
import { AmaruStores, type BlocksFile, type SnapshotFile } from "./stores";

/** Where `amaru node bootstrap` finds PRAGMA's states by default. */
const PRAGMA_STATES = "https://pub-b844360df4774bb092a2bb2043b888e5.r2.dev";

const READER_CRATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../amaru-store-reader",
);
const READER = join(READER_CRATE, "target/release/amaru-store-reader");

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;
}

function fail(message: string): never {
  console.error(message);
  exit(1);
}

/** Runs `argv` in `cwd` after printing it, and fails when it does. */
function run(
  cwd: string,
  argv: readonly string[],
  redirect: { stdin?: string; stdout?: string } = {},
): void {
  const [command, ...args] = argv as [string, ...string[]];
  console.log(
    `\n$ cd ${quote(cwd)} && ${argv.map(quote).join(" ")}` +
      (redirect.stdin ? ` < ${redirect.stdin}` : "") +
      (redirect.stdout ? ` > ${redirect.stdout}` : ""),
  );
  // The output lands under a temporary name, so a failed run leaves none.
  const partial = redirect.stdout && join(cwd, `${redirect.stdout}.partial`);
  const stdio: StdioOptions = [
    redirect.stdin ? openSync(join(cwd, redirect.stdin), "r") : "inherit",
    partial ? openSync(partial, "w") : "inherit",
    "inherit",
  ];
  const result = spawnSync(command, args, { cwd, stdio });
  if (result.status !== 0) {
    fail(`\`${command}\` failed${result.error ? `: ${result.error}` : ""}`);
  }
  if (partial && redirect.stdout)
    renameSync(partial, join(cwd, redirect.stdout));
}

function readJson<T>(path: string): T | null {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as T)
    : null;
}

function state(target: SurveyTarget, dir: string): StoresState {
  const ledger = join(dir, ledgerDir(target.network));
  const entries = existsSync(ledger) ? readdirSync(ledger) : [];
  const walk = readJson<BlocksFile>(join(dir, BLOCKS));
  const snapshot = readJson<SnapshotFile>(
    join(dir, snapshotFile(target.endEpoch)),
  );
  return {
    snapshots:
      entries.length === 0
        ? null
        : entries.filter((e) => /^\d+$/.test(e)).map(Number),
    walk: walk && { from: walk.from, to: walk.to },
    credentials: existsSync(join(dir, CREDENTIALS))
      ? readFileSync(join(dir, CREDENTIALS), "utf8")
      : null,
    answered: snapshot && {
      accounts: Object.keys(snapshot.accounts),
      dreps: Object.keys(snapshot.dreps),
    },
  };
}

async function surveyTarget(
  backend: string,
  key: string,
): Promise<SurveyTarget> {
  const client = createTesseraClient({ baseUrl: backend });
  const network = parseNetwork((await client.liveness()).network);
  const answer = await client.surveysByRefs([key]);
  if (!answer.ready)
    fail("the backend's snapshot is not ready; run this again shortly");
  const survey = answer.body.surveys[0];
  if (!survey) fail(`the backend knows no survey ${key}`);
  return {
    network,
    key,
    txHash: survey.txHash,
    slot: survey.slot,
    epoch: survey.epochNo,
    endEpoch: survey.definition.endEpoch,
  };
}

async function bootstrapStarts(target: SurveyTarget): Promise<number[]> {
  const url = `${PRAGMA_STATES}/${target.network}/index.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return bootstrapEpochs(target.network, (await res.json()) as string[]);
}

async function main(): Promise<void> {
  // `pnpm <script> -- <flags>` hands the script its `--` as well.
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      backend: { type: "string" },
      survey: { type: "string" },
      dir: { type: "string" },
      amaru: { type: "string" },
    },
  });
  const { backend, survey: key, dir: dirArg } = values;
  if (!backend || !key || !dirArg) {
    console.error(
      "usage: build-stores --backend <url> --survey <txHash>:<index> --dir <dir> [--amaru <amaru binary>]",
    );
    exit(2);
  }
  // pnpm runs the script from its package; `INIT_CWD` is where it was invoked.
  const here = process.env["INIT_CWD"] ?? "";
  const dir = resolve(here, dirArg);
  const amaru = values.amaru?.includes("/")
    ? resolve(here, values.amaru)
    : (values.amaru ?? "amaru");

  const target = await surveyTarget(backend, key);
  mkdirSync(dir, { recursive: true });
  console.log(
    `${key} was created in epoch ${target.epoch} and ends in epoch ` +
      `${target.endEpoch} on ${target.network}.`,
  );

  let previous = "";
  let readerBuilt = false;
  for (;;) {
    const step = nextStep(target, state(target, dir), () =>
      askedCredentials(surveyWindow(new AmaruStores(dir), key)),
    );
    const stepKey = JSON.stringify(step);
    if (stepKey === previous) {
      fail(
        step.kind === "sync"
          ? `the sync did not reach snapshot ${target.endEpoch}: Mithril may not certify ` +
              `that far yet, or the chain grew slowly; run this again later`
          : "the step above left the directory as it was; see its output",
      );
    }
    previous = stepKey;

    switch (step.kind) {
      case "refuse":
        fail(step.reason);
      case "bootstrap": {
        const epoch = bootstrapEpoch(await bootstrapStarts(target), target);
        if (typeof epoch !== "number") fail(epoch.refuse);
        run(dir, [amaru, ...bootstrapArgs(target.network, epoch)]);
        break;
      }
      case "sync":
        run(dir, [amaru, ...step.args]);
        break;
      case "read":
        if (!readerBuilt) {
          run(READER_CRATE, ["cargo", "build", "--release", "--quiet"]);
          readerBuilt = true;
        }
        run(dir, [READER, ...step.args], step);
        break;
      case "credentials":
        console.log(
          `\nwriting ${CREDENTIALS}: the ${step.asked.accounts.length} stake credentials ` +
            `and ${step.asked.dreps.length} DReps the survey's responses name`,
        );
        writeFileSync(join(dir, CREDENTIALS), JSON.stringify(step.asked));
        break;
      case "done":
        console.log(
          "\nThe stores are read. Verify, from the repository root:\n\n" +
            "  pnpm --filter cardano-tessera-verifier verify -- \\\n" +
            `    --backend ${quote(backend)} --survey ${key} --amaru ${quote(dir)}\n\n` +
            "If it warns of native scripts no transaction witnesses, add " +
            "--koios-scripts to resolve them through Koios.",
        );
        return;
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  exit(2);
});
