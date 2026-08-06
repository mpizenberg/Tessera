import type { Deployment } from "./deployments";

// Vite injects `__DEPLOYMENT__` by `define`; vitest deliberately does not, so
// tests can swap it per case with `vi.stubGlobal`. The default matches a
// plain dev server: Preview, no backend, no cross-links.
(globalThis as { __DEPLOYMENT__?: Deployment }).__DEPLOYMENT__ = {
  network: "preview",
  appUrls: {},
};
