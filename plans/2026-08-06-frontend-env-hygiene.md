# Frontend env hygiene

Two frontend configuration problems surfaced while checking what
`pnpm --filter tessera-app dev:preprod` actually resolves to.

## Progress

- Increment 1 — dev-only backend URL no longer reachable from build modes: landed.
- Increment 2 — `VITE_KOIOS_TOKEN` removed: landed.
- Deviation: both increments landed in one commit. They rewrite the same README
  paragraphs, so splitting them would have meant staging partial hunks of two
  files for no reviewer benefit.

## Problem 1 — `.env.local` leaks into deployed bundles

Vite loads `.env.local` in **every** mode, builds included. The READMEs told
developers to put `VITE_INDEXER_URL=http://localhost:8787` there, and
`.env.preprod` / `.env.mainnet` leave the key commented out, so:

```
vite build --mode preprod   →  VITE_INDEXER_URL=http://localhost:8787
```

`pnpm --filter tessera-app deploy:preprod` would ship a bundle pointing at the
developer's own machine. Only `.env.preview` escaped, because it defines the key
and mode files outrank `.env.local`.

The per-key fix (an explicit blank `VITE_INDEXER_URL=` in each mode file, the
shape already used for `VITE_KOIOS_TOKEN`) shields the symptom and has to be
repeated for every future key. The cause is that the project put dev-only
configuration in a file production builds read.

**Fix:** bake the local backend URL into the two dev scripts, where shell env
outranks every `.env` file, and stop having a `.env.local` at all. Nothing a
build mode loads then carries a dev-only value.

## Problem 2 — `VITE_KOIOS_TOKEN` is dead weight

The build-time Koios token for the direct-Koios path. `backend/ARCHITECTURE.md`
§1 lists it as defect #1 — a shared credential baked into a public bundle — and
all three deploy modes set it blank precisely so it can never ship. What is left
is a feature whose only remaining function is a guard against itself; the
Settings/localStorage token (per-user, per-network, never in the bundle) already
covers direct mode.

**Fix:** delete `envKoiosToken()` and its fallback, the three blank guard lines,
and the doc mentions. The Settings path and `AppConfig.koiosToken` stay.

## Increments

1. **Dev-only backend URL out of the build path.** `dev` and `dev:preprod` set
   `VITE_INDEXER_URL` inline; delete `.env.local`; update `.env.example` and the
   two READMEs.
2. **Remove `VITE_KOIOS_TOKEN`.** `config.ts`, `state.tsx`, the three mode
   files, both READMEs, `backend/ARCHITECTURE.md`.

## Decisions

- **Local backend URL lives in the dev scripts, not in an env file.** Alternative
  taken off the table: an explicit empty `VITE_INDEXER_URL=` in `.env.preprod`
  and `.env.mainnet`. Reason: that is a per-key guard needing a new line in every
  mode file for every future dev-only key, and it is the very pattern being
  deleted in increment 2; a shell prefix outranks all `.env` files, so the dev
  scripts state the value once where it is used and no build mode can see it.
  The READMEs already prescribed exactly this prefix by hand.
- **`.env.local` deleted rather than repurposed.** Alternative: keep it for other
  local overrides. Reason: it held only this key, and leaving the file (plus the
  README advice to create it) preserves the trap for the next deploy-relevant
  key. `.env` and `.env.*.local` stay git-ignored and available for genuine
  per-developer overrides.
- **Residual risk accepted, not guarded.** A contributor with a pre-existing
  git-ignored `.env.local` still leaks it into `deploy:*`, since the file cannot
  be removed by a pull. Alternative: a `vite.config.ts` assertion rejecting
  localhost URLs in non-development builds. Reason: added config complexity for a
  hazard the repo no longer creates or documents. Reversible — the assertion can
  be added later if a second contributor joins.
- **The dev scripts defer to an inherited value:**
  `VITE_INDEXER_URL=${VITE_INDEXER_URL-http://localhost:8787} vite`. A plain
  `VITE_INDEXER_URL=… vite` was written first and proved wrong on test — a
  script-level assignment overrides the caller's prefix, so the default could
  not be moved off :8787 at all and the direct-mode escape hatch silently did
  nothing. `${VAR-default}` (not `${VAR:-default}`) keeps an explicitly empty
  value empty, which is what selects direct mode. This assumes a POSIX shell for
  `pnpm run`, as the backend's `NETWORK=… tsx` scripts already do.
- **Direct mode stays reachable from a dev server** via
  `VITE_INDEXER_URL= pnpm --filter tessera-app dev` (empty string resolves to
  `undefined`), documented in `.env.example`. Alternative: leave `dev` pointing
  at nothing so direct mode is the default. Reason: the backend-backed path is
  the documented normal one and needed no token; direct mode is the power-user
  path and now costs one prefix instead of the common path costing one.
- **`ARCHITECTURE.md` §1 defect #1 reworded, not deleted.** The defect it
  describes is real and still motivates Tier 1, but its `VITE_KOIOS_TOKEN`
  phrasing goes stale with increment 2; restated as "a Koios credential has to
  live in the browser at all".
