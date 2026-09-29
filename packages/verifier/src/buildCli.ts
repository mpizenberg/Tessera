/**
 * Builds the local source a survey's audit reads:
 *
 *   pnpm --filter cardano-tessera-verifier build-source -- \
 *     --backend https://<backend> --survey <txHash>:<index> --dolos <dir>
 *
 *   pnpm --filter cardano-tessera-verifier build-source -- \
 *     --backend https://<backend> --survey <txHash>:<index> --amaru <dir> \
 *     [--amaru-bin <amaru binary>]
 *
 * into `<dir>`, printing each command before running it and skipping on a
 * rerun the steps already done, then prints the command that verifies the
 * survey against it. The backend gives only the network and the survey's
 * position, which adds no trust: the verifier checks the source against the
 * `end_epoch` it reads from the chain, and an Amaru walk started too late
 * misses the definition.
 *
 * `--dolos` builds a Dolos node stopped at the first block of `end_epoch + 1`.
 * It needs `dolos` on the PATH, and the node not served meanwhile, since
 * Dolos locks a store it serves.
 *
 * `--amaru` builds Amaru stores and reads them with `amaru-store-reader`. It
 * needs `amaru` (or `--amaru-bin`) and `cargo`, which builds the reader with
 * its own toolchain.
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
  AmaruStores,
  askedCredentials,
  surveyWindow,
  type BlocksFile,
  type SnapshotFile,
} from "cardano-tessera-amaru";
import * as amaru from "cardano-tessera-amaru/build";
import { stoppingPoint } from "cardano-tessera-dolos";
import * as dolos from "cardano-tessera-dolos/build";

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;
}

function shown(dir: string, argv: readonly string[]): string {
  return `cd ${quote(dir)} && ${argv.map(quote).join(" ")}`;
}

function fail(message: string): never {
  console.error(message);
  exit(1);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Takes `next()`'s steps until `take` reports the last one. A step planned
 * twice in a row means the one before left the directory where it was, which
 * `stuck` names.
 */
async function untilDone<S>(
  next: () => S,
  take: (step: S) => Promise<"done" | "again">,
  stuck: (step: S) => string,
): Promise<void> {
  let previous = "";
  for (;;) {
    const step = next();
    const key = JSON.stringify(step);
    if (key === previous) fail(stuck(step));
    previous = key;
    if ((await take(step)) === "done") return;
  }
}

function verifyCommand(
  backend: string,
  key: string,
  flag: string,
  dir: string,
) {
  return (
    "  pnpm --filter cardano-tessera-verifier verify -- \\\n" +
    `    --backend ${quote(backend)} --survey ${key} ${flag} ${quote(dir)}`
  );
}

async function surveyTarget(
  backend: string,
  key: string,
): Promise<amaru.SurveyTarget> {
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

// --- Dolos -------------------------------------------------------------------

function storeSummary(dir: string): dolos.StoreSummary {
  const run = spawnSync("dolos", ["data", "summary"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    fail(
      `\`dolos data summary\` failed in ${dir}: ${(run.stderr || String(run.error)).trim()}\n` +
        "If `dolos serve` is running there, stop it: it locks the store.",
    );
  }
  return JSON.parse(run.stdout) as dolos.StoreSummary;
}

/** The highest immutable file the aggregator's snapshots certify. */
async function certifiedUpTo(aggregator: string): Promise<number> {
  const res = await fetch(`${aggregator}/artifact/cardano-database`);
  if (!res.ok) throw new Error(`${aggregator}: HTTP ${res.status}`);
  const snapshots = (await res.json()) as {
    beacon: { immutable_file_number: number };
  }[];
  return Math.max(...snapshots.map((s) => s.beacon.immutable_file_number));
}

async function buildDolos(
  target: amaru.SurveyTarget,
  dir: string,
  backend: string,
): Promise<void> {
  const { network, endEpoch } = target;
  console.log(
    `${target.key} ends in epoch ${endEpoch} on ${network}: the node stops at the ` +
      `first block of epoch ${stoppingPoint(network, endEpoch).stopEpoch}.`,
  );
  const configPath = join(dir, "dolos.toml");
  const overlayPath = join(dir, dolos.OVERLAY);

  await untilDone(
    () => {
      const config = readIfExists(configPath);
      return dolos.nextStep({
        network,
        endEpoch,
        config,
        overlay: readIfExists(overlayPath),
        store: config === null ? null : storeSummary(dir),
      });
    },
    async (step) => {
      switch (step.kind) {
        case "init":
          console.log(
            "\nFirst write the node's config; `dolos init` asks every question itself:\n\n" +
              `  mkdir -p ${quote(dir)} && ${shown(dir, ["dolos", ...step.args])}\n\n` +
              "Take each default it offers, except the history to keep: choose " +
              '"keep everything". Its last question, the bootstrap method, comes after ' +
              "it saves the config: press Ctrl-C there. Then run this again.",
          );
          return "done";
        case "refuse":
          fail(step.reason);
        case "overlay":
          console.log(
            `\nwriting ${dolos.OVERLAY}, merged over dolos.toml:\n${step.content}`,
          );
          writeFileSync(overlayPath, step.content);
          return "again";
        case "run": {
          const aggregator = dolos.aggregatorOf(readIfExists(configPath) ?? "");
          if (!aggregator)
            fail("the node's dolos.toml names no Mithril aggregator");
          const certified = await certifiedUpTo(aggregator);
          if (certified < step.needsFile) {
            fail(
              `Mithril certifies immutable files up to ${certified}; the next step needs ` +
                `${step.needsFile}. Run this again once it is certified.`,
            );
          }
          console.log(`\n$ ${shown(dir, ["dolos", ...step.args])}`);
          // The next reading of the store judges a step, not its exit status:
          // the bootstrap fails by design when `stop_epoch` halts it.
          spawnSync("dolos", step.args, { cwd: dir, stdio: "inherit" });
          return "again";
        }
        case "done":
          console.log(
            "\nThe node is built. Verify, from the repository root:\n\n" +
              `${verifyCommand(backend, target.key, "--dolos", dir)}\n\n` +
              "The verifier serves the node itself while it reads the chain, then " +
              "stops it to read the ledger, so do not serve it meanwhile.",
          );
          return "done";
      }
    },
    () => "the step above left the store where it was; see its output",
  );
}

// --- Amaru -------------------------------------------------------------------

/** Where `amaru node bootstrap` finds PRAGMA's states by default. */
const PRAGMA_STATES = "https://pub-b844360df4774bb092a2bb2043b888e5.r2.dev";

const READER_CRATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../amaru-store-reader",
);
const READER = join(READER_CRATE, "target/release/amaru-store-reader");

/** Runs `argv` in `cwd` after printing it, and fails when it does. */
function run(
  cwd: string,
  argv: readonly string[],
  redirect: { stdin?: string; stdout?: string } = {},
): void {
  const [command, ...args] = argv as [string, ...string[]];
  console.log(
    `\n$ ${shown(cwd, argv)}` +
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
  const text = readIfExists(path);
  return text === null ? null : (JSON.parse(text) as T);
}

function storesState(
  target: amaru.SurveyTarget,
  dir: string,
): amaru.StoresState {
  const ledger = join(dir, amaru.ledgerDir(target.network));
  const entries = existsSync(ledger) ? readdirSync(ledger) : [];
  const walk = readJson<BlocksFile>(join(dir, amaru.BLOCKS));
  const snapshot = readJson<SnapshotFile>(
    join(dir, amaru.snapshotFile(target.endEpoch)),
  );
  return {
    snapshots:
      entries.length === 0
        ? null
        : entries.filter((e) => /^\d+$/.test(e)).map(Number),
    walk: walk && { from: walk.from, to: walk.to },
    credentials: readIfExists(join(dir, amaru.CREDENTIALS)),
    answered: snapshot && {
      accounts: Object.keys(snapshot.accounts),
      dreps: Object.keys(snapshot.dreps),
    },
  };
}

async function bootstrapStarts(target: amaru.SurveyTarget): Promise<number[]> {
  const url = `${PRAGMA_STATES}/${target.network}/index.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return amaru.bootstrapEpochs(target.network, (await res.json()) as string[]);
}

async function buildAmaru(
  target: amaru.SurveyTarget,
  dir: string,
  backend: string,
  binary: string,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  console.log(
    `${target.key} was created in epoch ${target.epoch} and ends in epoch ` +
      `${target.endEpoch} on ${target.network}.`,
  );

  let readerBuilt = false;
  await untilDone(
    () =>
      amaru.nextStep(target, storesState(target, dir), () =>
        askedCredentials(surveyWindow(new AmaruStores(dir), target.key)),
      ),
    async (step) => {
      switch (step.kind) {
        case "refuse":
          fail(step.reason);
        case "bootstrap": {
          const epoch = amaru.bootstrapEpoch(
            await bootstrapStarts(target),
            target,
          );
          if (typeof epoch !== "number") fail(epoch.refuse);
          run(dir, [binary, ...amaru.bootstrapArgs(target.network, epoch)]);
          return "again";
        }
        case "sync":
          run(dir, [binary, ...step.args]);
          return "again";
        case "read":
          if (!readerBuilt) {
            run(READER_CRATE, ["cargo", "build", "--release", "--quiet"]);
            readerBuilt = true;
          }
          run(dir, [READER, ...step.args], step);
          return "again";
        case "credentials":
          console.log(
            `\nwriting ${amaru.CREDENTIALS}: the ${step.asked.accounts.length} stake credentials ` +
              `and ${step.asked.dreps.length} DReps the survey's responses name`,
          );
          writeFileSync(
            join(dir, amaru.CREDENTIALS),
            JSON.stringify(step.asked),
          );
          return "again";
        case "done":
          console.log(
            "\nThe stores are read. Verify, from the repository root:\n\n" +
              `${verifyCommand(backend, target.key, "--amaru", dir)}\n\n` +
              "If it warns of native scripts no transaction witnesses, add " +
              "--koios-scripts to resolve them through Koios.",
          );
          return "done";
      }
    },
    (step) =>
      step.kind === "sync"
        ? `the sync did not reach snapshot ${target.endEpoch}: Mithril may not certify ` +
          `that far yet, or the chain grew slowly; run this again later`
        : "the step above left the directory as it was; see its output",
  );
}

// -----------------------------------------------------------------------------

function usage(): never {
  console.error(
    "usage: build-source --backend <url> --survey <txHash>:<index> --dolos <dir>\n" +
      "       build-source --backend <url> --survey <txHash>:<index> --amaru <dir> " +
      "[--amaru-bin <amaru binary>]",
  );
  exit(2);
}

async function main(): Promise<void> {
  // `pnpm <script> -- <flags>` hands the script its `--` as well.
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        backend: { type: "string" },
        survey: { type: "string" },
        dolos: { type: "string" },
        amaru: { type: "string" },
        "amaru-bin": { type: "string" },
      },
    }).values;
  } catch (err) {
    console.error((err as Error).message);
    usage();
  }
  const { backend, survey: key } = values;
  if (!backend || !key || !values.dolos === !values.amaru) usage();
  // pnpm runs the script from its package; `INIT_CWD` is where it was invoked.
  const here = process.env["INIT_CWD"] ?? "";
  const target = await surveyTarget(backend, key);

  if (values.dolos) {
    await buildDolos(target, resolve(here, values.dolos), backend);
  } else {
    const bin = values["amaru-bin"];
    const binary = bin?.includes("/") ? resolve(here, bin) : (bin ?? "amaru");
    await buildAmaru(target, resolve(here, values.amaru!), backend, binary);
  }
}

main().catch((err) => {
  console.error(String(err));
  exit(2);
});
