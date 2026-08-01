/**
 * Publish-time preconditions for a workspace package, run from its directory
 * as the last step of `prepublishOnly` (after the build, so `dist` exists).
 *
 * Every publishable package here keeps two export maps: `exports` aims at
 * TypeScript source for in-workspace consumers, `publishConfig.exports` swaps
 * in the built output. pnpm performs that swap; npm and yarn ignore it and
 * would upload a package whose entry points aim at `src/`, which `files` never
 * ships — an install that resolves to nothing.
 */

import { existsSync, readFileSync } from "node:fs";

const fail = (message) => {
  console.error(`\n  ✘ ${message}\n`);
  process.exit(1);
};

const agent = process.env["npm_config_user_agent"] ?? "unknown client";
if (!agent.startsWith("pnpm/")) {
  fail(
    `Publish with pnpm (\`pnpm publish\`), not ${agent.split("/")[0]}: only pnpm\n` +
      `    applies publishConfig.exports, and without it the published entry\n` +
      `    points aim at src/, which is not in the tarball.`,
  );
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const map = pkg.publishConfig?.exports ?? pkg.exports ?? {};
const targets = Object.values(map).flatMap((entry) =>
  typeof entry === "string" ? [entry] : Object.values(entry),
);
const missing = [...new Set(targets)].filter((t) => !existsSync(t));
if (missing.length > 0) {
  fail(
    `Published exports point at files that do not exist: ${missing.join(", ")}`,
  );
}
