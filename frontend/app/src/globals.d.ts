/**
 * Injected by Vite `define` (see vite.config.ts) — in builds and dev servers
 * it is a compile-time constant. Vitest deliberately defines nothing:
 * vitest.setup.ts sets a real global default, so tests can swap it per case
 * with `vi.stubGlobal`.
 */
declare const __DEPLOYMENT__: import("../deployments").Deployment;
