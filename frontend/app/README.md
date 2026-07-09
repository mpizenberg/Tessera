# tessera-app

The Tessera browser app: create, browse, respond to, and tally [CIP-179][cip179]
on-chain surveys and polls on Cardano. [SolidJS][solid] + [Vite][vite] +
TypeScript, no app server — everything runs in the browser, and transactions
are signed and submitted by the user's CIP-30 wallet.

## Screens

| Route                  | Screen                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                    | **Explore** — all surveys, response counts, deadlines, governance links, "answered" flags for the connected wallet.                                         |
| `/survey/:key`         | **Survey** — definition, live raw tally while open; once finalized, the backend's **final weighted results** (per-role, stake-weighted, verifiable).        |
| `/survey/:key/respond` | **Respond** — answer the questions and submit; sealed surveys are timelock-encrypted ([drand][drand]) client-side before submission.                        |
| `/create`              | **Create** — author a survey (roles, questions, end epoch, public/sealed) and submit it.                                                                    |
| `/propose-info-action` | **Propose Info Action** — build and submit a Conway governance Info Action advertising a survey (CIP-179 _Action → Survey_ linkage), from a CIP-108 anchor. |
| `/settings`            | **Settings** — network info, backend URL override, Koios token (direct mode), IPFS pinning provider tokens, language (en/fr).                               |

## Data modes

The app reads chain data through one seam (`src/data/source.ts`), with two
implementations:

- **Indexer mode** (default in deployments): `VITE_INDEXER_URL` points at the
  Tier-1 backend (`backend/server`), which serves cached reads, protocol
  parameters, and final tally artifacts. **No Koios token needed** for
  anything. The app checks the backend's `/health` network against its own and
  refuses a mismatch.
- **Direct mode** (power-user/offline path): leave `VITE_INDEXER_URL` unset and
  the browser scans Koios itself. This needs an authenticated Koios token
  (free tier works) — the anonymous tier sends no CORS headers — pasted in
  Settings or set as `VITE_KOIOS_TOKEN`. Direct mode shows raw one-per-credential
  counts only; final weighted artifacts are a backend feature.

## Run it

From the **repository root** (this is a pnpm workspace):

```sh
pnpm install
pnpm --filter @tessera/backend dev                                     # terminal 1
VITE_INDEXER_URL=http://localhost:8787 pnpm --filter tessera-app dev   # terminal 2
```

The app serves at http://127.0.0.1:3000. Copy `.env.example` to `.env` for
configuration — every variable is optional and documented there
(`VITE_NETWORK`, `VITE_INDEXER_URL`, `VITE_OTHER_NETWORK_URL`, …).

## Source layout

| Path             | What lives there                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/data`       | The `DataSource` seam: backend-served snapshot (`indexer.ts`) vs direct Koios (`@tessera/koios`).                                                                                                                                                            |
| `src/domain`     | App-side domain: transaction building (`create.ts`, `respond.ts`, `fee.ts`), role checks, artifact render-model (`artifactView.ts`). Pure read/tally rules are imported from `@tessera/core` (which re-exports the reusable `cip-179` domain/tally surface). |
| `src/wallet`     | CIP-30 wallet discovery, connection, signing, submission.                                                                                                                                                                                                    |
| `src/tlock`      | Frontend `Date`-formatting helpers over drand rounds (`drand.ts`); the sealed-mode encryption itself lives in `cip-179/tlock`.                                                                                                                               |
| `src/enrichment` | Optional off-chain content: IPFS reads (gateway race) and pinning (per-provider tokens from Settings).                                                                                                                                                       |
| `src/ui`         | Screens + components (CSS modules, `theme.css`).                                                                                                                                                                                                             |
| `src/i18n`       | English + French catalogs, co-located per screen, zero dependencies.                                                                                                                                                                                         |
| `src/state.tsx`  | The app store: snapshot resources, wallet session, settings persistence.                                                                                                                                                                                     |

Notable UI behavior: a finalized survey renders its **content-addressed result
artifact** (per-role weighted bars, turnout, provenance note, artifact hash —
recomputed locally from the served bytes), with a toggle back to the raw
unweighted tally. Anyone can re-derive the artifact from chain data with
`pnpm --filter @tessera/verifier verify` (see `packages/verifier`).

## Develop

| Command (from repo root, or drop the filter inside `frontend/app`) | What it does                 |
| ------------------------------------------------------------------ | ---------------------------- |
| `pnpm --filter tessera-app dev`                                    | Vite dev server.             |
| `pnpm --filter tessera-app test`                                   | Unit tests (Vitest).         |
| `pnpm --filter tessera-app type-check`                             | `tsc --noEmit`.              |
| `pnpm --filter tessera-app build`                                  | Production build to `dist/`. |
| `pnpm format` / `pnpm format:check` (in `frontend/app`)            | Prettier.                    |

Workspace packages (`@tessera/core`, `@tessera/koios`, `cip-179`) are consumed
from TypeScript source, so cross-package edits are live in the dev server with
no build step.

## Deploy

Static assets on Cloudflare Workers, one deployment per network (see
`wrangler.toml`):

```sh
pnpm --filter tessera-app deploy:preview   # builds with .env.preview, uploads dist/
pnpm --filter tessera-app deploy:mainnet   # builds with .env.mainnet, --env mainnet
```

Each mode file bakes that network's configuration (backend URL, counterpart
link) into the bundle at build time.

[cip179]: https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179
[drand]: https://drand.love/
[solid]: https://www.solidjs.com/
[vite]: https://vite.dev/
