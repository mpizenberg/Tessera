// @vitest-environment node
/**
 * Importing the built artifact must be a no-op without a DOM: SSR hosts
 * (SvelteKit, Next.js) evaluate the module server-side long before a client
 * pass can register the element. Guarded registration (element.tsx) plus a
 * delegation-free Solid compile (vite.config.ts) keep the whole module graph
 * window-free at evaluation time — this test is what holds that line.
 */

import { describe, expect, it } from "vitest";

describe("built artifact under Node (no DOM)", () => {
  it("imports as a no-op and still exposes the API", async () => {
    expect(typeof window).toBe("undefined");
    // @ts-expect-error -- the built dist ships no declarations (yet)
    const mod = await import("../dist/tessera-respond.es.js");
    expect(mod.RESPOND_EVENTS.response).toBe("tessera:response");
    expect(typeof mod.adoptWidgetStyles).toBe("function");
    expect(typeof mod.RespondRoot).toBe("function");
  });
});
