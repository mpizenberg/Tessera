# Contributing

Contributions are welcome. Open an issue to discuss substantial changes before
investing in a PR.

## Keeping the build green

CI runs these on every PR, in this order: `pnpm -r test`,
`pnpm test:operator-scripts`, `pnpm -r type-check`, `pnpm format:check`. Tests
come before type-check because the widget's test script builds the rolled-up
`d.ts` its typed tests need. CI then runs `pnpm -r build`, which needs a
`frontend/app/.env.deploy` to exist (copy `.env.deploy.example`), and bundles
both Cloudflare Workers with `wrangler deploy --dry-run`, without credentials
and without the network. Match the existing code style; Prettier is the source
of truth for formatting (`pnpm format`).

## Versions and changelogs

Two surfaces have consumers outside this repository. A change to either lands
with its changelog line in the same PR.

- **The HTTP contract** of the serving backend — every `/api/*` route and
  `/health`, described normatively in the Endpoints section of
  `backend/server/README.md`. Its version is `API_VERSION` in
  `packages/core/src/source.ts`, as `major.minor`, and its changelog is
  `backend/server/CHANGELOG.md`. A new field, selection or route bumps the
  minor. A field renamed, removed or re-typed, or a selection whose semantics
  change, bumps the major, and the backend then serves the new shape only — no
  transition window. Update the README's Endpoints section in the same change,
  and `interop/preprod.md` when the host contract it states moves.
- **The published packages** — `cip-179`, `cardano-tessera-respond` and
  `cardano-tessera-respond-react` — follow semver, with the pre-1.0 convention
  that a breaking change bumps the minor. `packages/cip179/CHANGELOG.md`
  records the codec, domain, tally and tlock changes; a change to a counting
  rule also changes `rulesetHash()` and gets a new row in that package's
  README table, never an edited one.

`backend/ARCHITECTURE.md` and `backend/TALLY-SPEC.md` are cited from code by
section number, so their numbering is part of the interface: add sections at
the end rather than renumbering.
