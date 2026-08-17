import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { resolveDeployment } from "./deployments";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Name the build in the served HTML, so which artifact a browser was handed
 * reads out of `curl <app> | grep tessera-build` — the app's answer to the
 * Worker's `/api/health` commit, and legible when the app itself is too broken
 * to render its Settings screen.
 */
const stampBuild = (commit: string): Plugin => ({
  name: "tessera-build-stamp",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { name: "tessera-build", content: commit },
      injectTo: "head",
    },
  ],
});

export default defineConfig(({ command, mode }) => {
  // All build-time configuration flows through this one constant, resolved
  // from the committed table in deployments.ts. Unknown build modes throw.
  const deployment = resolveDeployment(command, mode);
  return {
    plugins: [solid(), stampBuild(deployment.commit)],
    define: { __DEPLOYMENT__: JSON.stringify(deployment) },
    // No variable carries this prefix — deliberately: nothing from an env file
    // or the shell can reach import.meta.env, so an artifact is a pure
    // function of the repo and the mode.
    envPrefix: "TESSERA_SEALED_",
    resolve: {
      alias: {
        // Resolve the workspace libraries straight from their TypeScript source
        // so edits are live with no separate build step. `cip-179` needs no
        // aliases: its exports map points at src, which Vite resolves directly.
        "cardano-tessera-core": r("../../packages/core/src/index.ts"),
        "cardano-tessera-koios": r("../../packages/koios/src/index.ts"),
        "cardano-tessera-respond-core": r(
          "../../packages/respond-core/src/index.ts",
        ),
        "cardano-tessera-respond-ui": r(
          "../../packages/respond-ui/src/index.ts",
        ),
        // The embeddable widget is consumed from source too, so the dev-only
        // reference-host page (`/dev/widget/:key`) drives the very
        // same code the built artifact ships. The `/element` subpath registers
        // the `<tessera-respond>` custom element.
        "cardano-tessera-respond/element": r(
          "../../packages/respond-widget/src/element.tsx",
        ),
        "cardano-tessera-respond": r(
          "../../packages/respond-widget/src/index.ts",
        ),
        "~": r("./src"),
      },
      // The widget pulls in `solid-element`, so two Solid copies could otherwise
      // slip in (breaking context/ownership). Force a single instance.
      dedupe: ["solid-js", "solid-element"],
    },
    // Bind IPv4 loopback so `localhost` (which many browsers resolve to
    // 127.0.0.1) connects — Vite's default binds IPv6 `::1` only.
    server: { host: "127.0.0.1", port: 3000 },
  };
});
