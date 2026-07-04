/**
 * Test-only shim for `node:sqlite`. Vite 5's builtin-module list predates it:
 * the resolver strips the `node:` prefix and then fails to load bare "sqlite",
 * so `vitest.config.ts` aliases the specifier here instead, where the builtin
 * is fetched at runtime — a plain string `process.getBuiltinModule` call that
 * no bundler resolution touches. Never imported by production code.
 */

import type * as sqlite from "node:sqlite";

export const { DatabaseSync } = process.getBuiltinModule(
  "node:sqlite",
) as typeof sqlite;
