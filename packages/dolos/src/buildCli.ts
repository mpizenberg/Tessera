/**
 * Builds the Dolos node a survey's audit reads:
 *
 *   pnpm --filter cardano-tessera-dolos build-node -- \
 *     --backend https://<backend> --survey <txHash>:<index> --dir <dir>
 *
 * into `<dir>`, printing each command before running it, then prints the
 * command that verifies the survey against it. The backend gives only the
 * network and the survey's `end_epoch`: the verifier checks the node's
 * position against the `end_epoch` it reads from the chain, so a wrong one is
 * refused there. Needs `dolos` on the PATH, and the node not served
 * meanwhile, since Dolos locks a store it serves.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exit } from "node:process";
import { parseArgs } from "node:util";

import {
  createTesseraClient,
  parseNetwork,
  type Network,
} from "cardano-tessera-client";

import {
  OVERLAY,
  aggregatorOf,
  nextStep,
  type NodeState,
  type StoreSummary,
} from "./build";
import { stoppingPoint } from "./stoppingPoints";

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

function summary(dir: string): StoreSummary {
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
  return JSON.parse(run.stdout) as StoreSummary;
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

async function surveyTarget(
  backend: string,
  key: string,
): Promise<{ network: Network; endEpoch: number }> {
  const client = createTesseraClient({ baseUrl: backend });
  const network = parseNetwork((await client.liveness()).network);
  const answer = await client.surveysByRefs([key]);
  if (!answer.ready)
    fail("the backend's snapshot is not ready; run this again shortly");
  const survey = answer.body.surveys[0];
  if (!survey) fail(`the backend knows no survey ${key}`);
  return { network, endEpoch: survey.definition.endEpoch };
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
    },
  });
  const { backend, survey: key, dir: dirArg } = values;
  if (!backend || !key || !dirArg) {
    console.error(
      "usage: build-node --backend <url> --survey <txHash>:<index> --dir <dir>",
    );
    exit(2);
  }
  // pnpm runs the script from its package; `INIT_CWD` is where it was invoked.
  const dir = resolve(process.env["INIT_CWD"] ?? "", dirArg);

  const { network, endEpoch } = await surveyTarget(backend, key);
  console.log(
    `${key} ends in epoch ${endEpoch} on ${network}: the node stops at the ` +
      `first block of epoch ${stoppingPoint(network, endEpoch).stopEpoch}.`,
  );

  let previous = "";
  for (;;) {
    const configPath = join(dir, "dolos.toml");
    const overlayPath = join(dir, OVERLAY);
    const config = existsSync(configPath)
      ? readFileSync(configPath, "utf8")
      : null;
    const state: NodeState = {
      network,
      endEpoch,
      config,
      overlay: existsSync(overlayPath)
        ? readFileSync(overlayPath, "utf8")
        : null,
      store: config === null ? null : summary(dir),
    };
    const step = nextStep(state);
    const stepKey = JSON.stringify(step);
    if (stepKey === previous)
      fail("the step above left the store where it was; see its output");
    previous = stepKey;

    switch (step.kind) {
      case "init":
        fail(
          "First write the node's config; `dolos init` asks every question itself:\n\n" +
            `  mkdir -p ${quote(dir)} && ${shown(dir, ["dolos", ...step.args])}\n\n` +
            "Take each default it offers, except the history to keep: choose " +
            '"keep everything". Its last question, the bootstrap method, comes after ' +
            "it saves the config: press Ctrl-C there. Then run this again.",
        );
      case "refuse":
        fail(step.reason);
      case "overlay":
        console.log(
          `\nwriting ${OVERLAY}, merged over dolos.toml:\n${step.content}`,
        );
        writeFileSync(overlayPath, step.content);
        break;
      case "run": {
        const aggregator = aggregatorOf(config ?? "");
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
        break;
      }
      case "done":
        console.log(
          "\nThe node is built. Verify, from the repository root:\n\n" +
            "  pnpm --filter cardano-tessera-verifier verify -- \\\n" +
            `    --backend ${quote(backend)} --survey ${key} --dolos ${quote(dir)}\n\n` +
            "The verifier serves the node itself while it reads the chain, then " +
            "stops it to read the ledger, so do not serve it meanwhile.",
        );
        return;
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  exit(2);
});
