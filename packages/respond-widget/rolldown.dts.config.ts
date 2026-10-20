import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

// The published declarations, rolled up from source with respond-core,
// respond-ui and cip-179 inlined. Oxc declares each file on its own, so every
// export along the way carries an explicit type; the build names any that
// doesn't.
export default defineConfig({
  input: { "tessera-respond.es": "src/element.tsx" },
  plugins: [dts({ generator: "oxc", emitDtsOnly: true })],
  // respond-ui's modules import solid-js: kept for their side effects, they
  // would bring its `declare global` blocks into every host's types.
  treeshake: { moduleSideEffects: false },
  output: { dir: "dist" },
});
