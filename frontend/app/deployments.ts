import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
// Relative import, not `cardano-tessera-core`: this file runs inside Vite's
// bundled config, where the workspace alias (vite.config.ts) doesn't exist
// and Node cannot load the package's TS source through its bare specifier.
import { NETWORKS, type Network } from "../../packages/core/src/config";

/**
 * One deployed Tessera app. Everything here is public configuration baked
 * into the bundle, but the values are deployment-specific (whose Cloudflare
 * account, which URLs), so they come from build-time environment variables —
 * `TESSERA_BACKEND_URL_<NETWORK>` and `TESSERA_APP_URL_<NETWORK>` — loaded
 * from the git-ignored `.env.deploy` (template: `.env.deploy.example`), with
 * variables already set in the environment taking precedence. Vite injects
 * the resolved value as the `__DEPLOYMENT__` global (see vite.config.ts);
 * nothing else reaches the bundle, and dev servers never read `.env.deploy`.
 */
export interface Deployment {
  /**
   * The network this deployment serves. One deployment, one network — there
   * is no runtime switch; the networks cross-link through {@link appUrls}.
   */
  readonly network: Network;
  /**
   * The Tier-1 serving backend for that network. When set, the app reads its
   * snapshot and protocol parameters from this backend, so no Koios token is
   * needed at all (transactions are still signed by the user's wallet). It
   * must serve the same network — the app checks the backend's `/health` and
   * refuses a mismatch. Absent ⇒ the browser scans Koios directly, which
   * needs a token pasted in the app's Settings (the anonymous tier is
   * CORS-blocked).
   */
  readonly indexerUrl?: string;
  /** Deployed app URLs to cross-link from the header; self is filtered out. */
  readonly appUrls: Partial<Record<Network, string>>;
  /**
   * The repo state this artifact was built from — `git rev-parse HEAD`, the
   * derivation the Worker's deploy stamps into `GIT_COMMIT`, so an app build
   * and a backend deploy compare as strings. `-dirty` when the tree carried
   * uncommitted changes, `unknown` when git cannot answer.
   */
  readonly commit: string;
}

/**
 * The deployment a Vite invocation bakes in. The mode is the network — one
 * name per deployment, shared with the wrangler environment
 * (`vite build --mode X && wrangler deploy --env X`).
 *
 * A dev server (`command === "serve"`) takes the mode's network but swaps
 * the backend for a local one: `TESSERA_BACKEND_URL` if present (empty ⇒
 * direct Koios), else `http://localhost:8787`.
 *
 * A build requires its own network's two variables to be *declared* — empty
 * is a valid, explicit "none" — so a forgotten `.env.deploy` fails the build
 * instead of silently shipping a direct-Koios app.
 */
export function resolveDeployment(
  command: "build" | "serve",
  mode: string,
): Deployment {
  return { ...target(command, mode), commit: buildCommit() };
}

/**
 * What the build serves — network, backend, cross-links — before the stamp
 * that says which repo state produced it.
 */
function target(
  command: "build" | "serve",
  mode: string,
): Omit<Deployment, "commit"> {
  if (command === "serve") {
    const network = mode === "development" ? "preview" : requireNetwork(mode);
    const url = process.env.TESSERA_BACKEND_URL ?? "http://localhost:8787";
    return url
      ? { network, indexerUrl: url, appUrls: {} }
      : { network, appUrls: {} };
  }
  return buildDeployment(requireNetwork(mode));
}

/**
 * Derived from git rather than declared, unlike everything else baked in: a
 * stamp the environment could choose could name any commit, and its whole use
 * is telling which build is live.
 */
function buildCommit(): string {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  try {
    const head = git("rev-parse", "HEAD");
    return git("status", "--porcelain") ? `${head}-dirty` : head;
  } catch {
    return "unknown";
  }
}

const backendUrlKey = (network: Network): string =>
  `TESSERA_BACKEND_URL_${network.toUpperCase()}`;
const appUrlKey = (network: Network): string =>
  `TESSERA_APP_URL_${network.toUpperCase()}`;

function buildDeployment(network: Network): Omit<Deployment, "commit"> {
  const env = deployEnv();
  const backendUrl = requireVar(env, backendUrlKey(network));
  requireVar(env, appUrlKey(network));
  const appUrls: Partial<Record<Network, string>> = {};
  for (const other of NETWORKS) {
    const url = env[appUrlKey(other)];
    if (url) appUrls[other] = url;
  }
  const links = Object.entries(appUrls)
    .map(([net, url]) => `${net}=${url}`)
    .join(", ");
  console.log(
    `[tessera] building ${network}: ` +
      `backend ${backendUrl || "none (direct Koios)"}; ` +
      `app links: ${links || "none"}`,
  );
  return backendUrl
    ? { network, indexerUrl: backendUrl, appUrls }
    : { network, appUrls };
}

function deployEnv(): Record<string, string> {
  const fromFile = existsSync(".env.deploy")
    ? parseEnv(readFileSync(".env.deploy", "utf8"))
    : {};
  const env: Record<string, string> = {};
  for (const source of [fromFile, process.env]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("TESSERA_") && value !== undefined) env[key] = value;
    }
  }
  return env;
}

function requireVar(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (value === undefined) {
    throw new Error(
      `Missing ${key} — declare it (empty is valid) in ` +
        `frontend/app/.env.deploy (copy .env.deploy.example) ` +
        `or the environment.`,
    );
  }
  return value;
}

function requireNetwork(mode: string): Network {
  const network = NETWORKS.find((candidate) => candidate === mode);
  if (!network) {
    throw new Error(
      `Unknown deploy target "${mode}" — expected one of: ${NETWORKS.join(", ")}`,
    );
  }
  return network;
}
