/**
 * Builds the two Dolos nodes a survey's audit reads:
 *
 *   pnpm --filter cardano-tessera-dolos nodes -- \
 *     --backend https://<backend> --survey <txHash>:<index> --dir <dir>
 *
 * into `<dir>/end` and `<dir>/after`, printing each command before running
 * it, then prints the commands that serve them and verify the survey. The
 * backend gives only the network and the survey's `end_epoch`: the verifier
 * checks both nodes' positions against the `end_epoch` it reads from the
 * chain, so a wrong one is refused there. Needs `dolos` on the PATH, and
 * neither node served meanwhile, since Dolos locks a store it serves.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { exit } from "node:process";
import { parseArgs } from "node:util";

import {
  createTesseraClient,
  parseNetwork,
  type Network,
} from "cardano-tessera-client";

import {
  AFTER_OVERLAY,
  PORTS,
  afterOverlay,
  aggregatorOf,
  nextStep,
  type NodesState,
  type StoreSummary,
} from "./nodes";
import { stoppingPoints } from "./stoppingPoints";

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
      "usage: nodes --backend <url> --survey <txHash>:<index> --dir <dir>",
    );
    exit(2);
  }
  const dir = resolve(dirArg);
  const endDir = join(dir, "end");
  const afterDir = join(dir, "after");

  const { network, endEpoch } = await surveyTarget(backend, key);
  const points = stoppingPoints(network, endEpoch);
  console.log(
    `${key} ends in epoch ${endEpoch} on ${network}: the end node stops at its ` +
      `last block, the after node a block into epoch ${points.stopEpoch}.`,
  );

  let previous = "";
  for (;;) {
    const endConfig = join(endDir, "dolos.toml");
    const config = existsSync(endConfig)
      ? readFileSync(endConfig, "utf8")
      : null;
    const state: NodesState = {
      network,
      endEpoch,
      end: config === null ? null : { config, store: summary(endDir) },
      after: existsSync(afterDir) ? summary(afterDir) : null,
    };
    const step = nextStep(state);
    const stepKey = JSON.stringify(step);
    if (stepKey === previous)
      fail("the step above left the store where it was; see its output");
    previous = stepKey;

    switch (step.kind) {
      case "init":
        fail(
          "First write the end node's config; `dolos init` asks every question itself:\n\n" +
            `  mkdir -p ${quote(endDir)} && ${shown(endDir, ["dolos", ...step.args])}\n\n` +
            "Take each default it offers, except the history to keep: choose " +
            '"keep everything". Its last question, the bootstrap method, comes after ' +
            "it saves the config: press Ctrl-C there. Then run this again.",
        );
      case "refuse":
        fail(step.reason);
      case "run": {
        if (step.needsFile !== undefined) {
          const aggregator = aggregatorOf(config ?? "");
          if (!aggregator)
            fail("the end node's dolos.toml names no Mithril aggregator");
          const certified = await certifiedUpTo(aggregator);
          if (certified < step.needsFile) {
            fail(
              `Mithril certifies immutable files up to ${certified}; the next step needs ` +
                `${step.needsFile}. Run this again once it is certified.`,
            );
          }
        }
        const cwd = step.node === "end" ? endDir : afterDir;
        console.log(`\n$ ${shown(cwd, ["dolos", ...step.args])}`);
        // The next reading of the stores judges a step, not its exit status:
        // the after node's bootstrap fails by design when `stop_epoch` halts it.
        spawnSync("dolos", step.args, { cwd, stdio: "inherit" });
        break;
      }
      case "copy": {
        const partial = join(dir, "after.partial");
        rmSync(partial, { recursive: true, force: true });
        const cp =
          process.platform === "darwin"
            ? ["cp", "-c", "-R", endDir, partial]
            : ["cp", "-R", "--reflink=auto", endDir, partial];
        console.log(`\n$ ${cp.map(quote).join(" ")}`);
        if (spawnSync(cp[0]!, cp.slice(1), { stdio: "inherit" }).status !== 0) {
          fail("copying the end node failed");
        }
        const overlay = afterOverlay(points.stopEpoch);
        console.log(
          `\nwriting ${AFTER_OVERLAY}, merged over the copied dolos.toml:\n${overlay}`,
        );
        writeFileSync(join(partial, AFTER_OVERLAY), overlay);
        renameSync(partial, afterDir);
        break;
      }
      case "done":
        console.log(
          "\nBoth nodes are built. Serve each in its own terminal:\n\n" +
            `  ${shown(endDir, ["dolos", "serve"])}\n` +
            `  ${shown(afterDir, ["dolos", "-c", AFTER_OVERLAY, "serve"])}\n\n` +
            "then verify, from the repository root:\n\n" +
            "  pnpm --filter cardano-tessera-verifier verify -- \\\n" +
            `    --backend ${quote(backend)} --survey ${key} \\\n` +
            `    --dolos-end http://localhost:${PORTS.endMinibf} ` +
            `--dolos-after http://localhost:${PORTS.afterMinibf} \\\n` +
            `    --minikupo http://localhost:${PORTS.minikupo}`,
        );
        return;
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  exit(2);
});
