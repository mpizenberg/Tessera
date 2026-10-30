/**
 * Write `.vercel/output` (Vercel's Build Output API) for the network named by
 * `NETWORK`: the serving function on every path, the refresh function on
 * `/cron/refresh` with its cron. `vercel deploy --prebuilt` uploads it as is.
 *
 * The network and the commit are baked into each function's environment, so a
 * project cannot serve a network other than the one it was built for, and
 * `/api/health` names the code it runs.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseNetwork } from "cardano-tessera-client";
import { build } from "esbuild";

const OUTPUT = fileURLToPath(new URL("../.vercel/output", import.meta.url));

const FUNCTIONS = [
  { path: "serve", entry: "vercel-serve.ts", maxDuration: 30 },
  { path: "cron/refresh", entry: "vercel-refresh.ts", maxDuration: 300 },
] as const;

/** `git rev-parse HEAD`, `-dirty` with uncommitted changes: the app's stamp. */
function buildCommit(): string {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  return git("status", "--porcelain") ? `${head}-dirty` : head;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const network = parseNetwork(process.env["NETWORK"]);
const commit = buildCommit();

rmSync(OUTPUT, { recursive: true, force: true });
for (const fn of FUNCTIONS) {
  const dir = join(OUTPUT, "functions", `${fn.path}.func`);
  mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL(fn.entry, import.meta.url))],
    outfile: join(dir, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // CommonJS dependencies call `require`, which an ES module lacks.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  writeJson(join(dir, ".vc-config.json"), {
    runtime: "nodejs24.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    maxDuration: fn.maxDuration,
    regions: ["dub1"],
    environment: { NETWORK: network, GIT_COMMIT: commit },
  });
}
writeJson(join(OUTPUT, "config.json"), {
  version: 3,
  // Functions match in the filesystem phase, so `/cron/refresh` is never
  // rewritten to the serving function.
  routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/serve" }],
  crons: [{ path: "/cron/refresh", schedule: "*/3 * * * *" }],
});
console.log(`.vercel/output for ${network} at ${commit}`);
