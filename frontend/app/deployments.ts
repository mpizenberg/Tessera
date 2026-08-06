import type { Network } from "cardano-tessera-core";

/**
 * One deployed Tessera app. Everything here is public configuration baked
 * into the bundle — which is why it is committed, typed code rather than env
 * files: a deployed artifact must be a pure function of the repo and the
 * target name, so no git-ignored file or shell variable can change what
 * ships. Vite injects the resolved row as the `__DEPLOYMENT__` global (see
 * vite.config.ts).
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
}

// Stated once and shared by every row: each build links to the *other*
// networks' apps. Add a URL when that network's app first deploys, then
// redeploy the rest so their headers pick it up.
const APP_URLS: Partial<Record<Network, string>> = {
  preview: "https://tessera-preview.matthieu-pizenberg.workers.dev",
};

/**
 * The deploy targets. Each key is simultaneously the Vite build mode and the
 * wrangler environment name (`vite build --mode X && wrangler deploy --env X`).
 */
export const DEPLOYMENTS: Record<string, Deployment> = {
  preview: {
    network: "preview",
    indexerUrl:
      "https://tessera-backend-preview.matthieu-pizenberg.workers.dev",
    appUrls: APP_URLS,
  },
  // The preprod and mainnet backends are not deployed yet (see
  // backend/server/OPERATIONS.md). Until `indexerUrl` is set, those builds
  // use direct Koios, which needs a token entered in Settings.
  preprod: { network: "preprod", appUrls: APP_URLS },
  mainnet: { network: "mainnet", appUrls: APP_URLS },
};

/**
 * The deployment a Vite invocation bakes in.
 *
 * A dev server (`command === "serve"`) takes the target's network but swaps
 * the backend for a local one: `TESSERA_BACKEND_URL` if present (empty ⇒
 * direct Koios), else `http://localhost:8787`. That branch is the only place
 * ambient environment is read, and a build can never take it.
 */
export function resolveDeployment(
  command: "build" | "serve",
  mode: string,
): Deployment {
  if (command === "serve") {
    const network =
      mode === "development" ? "preview" : requireTarget(mode).network;
    const url = process.env.TESSERA_BACKEND_URL ?? "http://localhost:8787";
    return url
      ? { network, indexerUrl: url, appUrls: {} }
      : { network, appUrls: {} };
  }
  return requireTarget(mode);
}

function requireTarget(mode: string): Deployment {
  const deployment = DEPLOYMENTS[mode];
  if (!deployment) {
    throw new Error(`No deployment target named "${mode}" in deployments.ts`);
  }
  return deployment;
}
