import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// The same suite against React 18. Aliasing to a react-dom *package name*
// installed next to react 19 cannot work: react-dom is CJS, so Node loads it
// natively and its internal `require("react")` follows pnpm's peer link to
// whatever react its install context provides. The react18/ dep-anchor
// package provides a context where that peer link points at react 18, and
// these aliases resolve to absolute paths inside it. The suite's
// EXPECTED_REACT_MAJOR assertion proves the swap took effect.
const react18 = createRequire(
  new URL("./react18/package.json", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: react18.resolve("react") },
      {
        find: /^react-dom\/client$/,
        replacement: react18.resolve("react-dom/client"),
      },
      {
        find: /^react-dom\/server$/,
        replacement: react18.resolve("react-dom/server"),
      },
      { find: /^react-dom$/, replacement: react18.resolve("react-dom") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    env: { EXPECTED_REACT_MAJOR: "18" },
  },
});
