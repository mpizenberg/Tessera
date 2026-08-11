import { defineConfig } from "vitest/config";

// Solid's exports map resolves to its SSR build under the default `node`
// condition — one where effects never run and stores are inert plain objects,
// so a reactive test would pass while exercising nothing. Ask for the client
// build instead. No DOM is needed: nothing here renders, it only reacts.
export default defineConfig({
  resolve: { conditions: ["browser", "development"] },
  ssr: { resolve: { conditions: ["browser", "development"] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
