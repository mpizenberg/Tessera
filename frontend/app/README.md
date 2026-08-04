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

The app reads chain data through one seam (the `DataSource` interface from
`cardano-tessera-core`), with two implementations in `src/data/`:

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

A deployed build can also enter direct mode at runtime from Settings when its
backend is down — emergency participation, gated on a resolvable Koios token.
Activation stamps a 24 h expiry that applies at the next app load, so nobody
lives in the degraded mode by accident and nothing interrupts a response being
composed; leaving keeps the stored token, so re-entering is one click. While it
is in force every screen carries a banner: responses are unverified, because the
serving tier's credential-proof verdicts are what the browser normally reads and
direct mode has none.

## Publishing

Everything the user publishes goes through one queue. An action — a survey
definition, a response, a cancellation, a governance proposal — is queued in the
**cart**, which is partitioned into transactions: CIP-179 allows one event kind
per label-17 payload, so same-kind actions batch to save fees and different
kinds never share a transaction.

An action about a survey whose defining transaction is still in flight _chains_
onto it — the new transaction spends an output that exists only if the
definition was included, so no block can carry a response without the survey it
answers. Submitted transactions are kept with their signed bytes and projected
as chain state: a UTxO set, so consecutive submits cannot select the same input
twice, and an optimistic overlay, so a published survey is browsable before the
indexer has it.

Whoever pays the fee is not whoever proves ownership, so a transaction may need
witnesses from wallets that cannot be connected at the same time. The chain is
built once and gathers signatures across as many wallets as it takes, each round
publishing every transaction it completed. Wallets granting CIP-103 sign the
whole chain in one prompt.

## Run it

From the **repository root** (this is a pnpm workspace):

```sh
pnpm install
pnpm --filter cardano-tessera-backend dev                                     # terminal 1
VITE_INDEXER_URL=http://localhost:8787 pnpm --filter tessera-app dev   # terminal 2
```

The app serves at http://127.0.0.1:3000. Copy `.env.example` to `.env` for
configuration — every variable is optional and documented there
(`VITE_NETWORK`, `VITE_INDEXER_URL`, `VITE_MAINNET_URL`, …).

## Source layout

| Path             | What lives there                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/data`       | The `DataSource` seam: backend-served snapshot (`indexer.ts`) vs direct Koios (`cardano-tessera-koios`).                                                                                                                                  |
| `src/domain`     | App-side domain: transaction building (`create.ts`, `respond.ts`, `fee.ts`), role checks, artifact render-model (`artifactView.ts`). Pure read/tally rules are imported directly from `cip-179/domain` and `cip-179/tally`.               |
| `src/wallet`     | CIP-30 discovery and connection, plus the whole write path: the action cart (`cart.ts`), the pure partitioner (`plan.ts`), building/signing/submission (`submit.ts`, the only evolution-sdk site), and the pending-tx set (`pending.ts`). |
| `src/tlock`      | Frontend `Date`-formatting helpers over drand rounds (`drand.ts`); the sealed-mode encryption itself lives in `cip-179/tlock`.                                                                                                            |
| `src/enrichment` | Optional off-chain content: IPFS reads (gateway race) and pinning (per-provider tokens from Settings).                                                                                                                                    |
| `src/ui`         | Screens + components (CSS modules, `theme.css`).                                                                                                                                                                                          |
| `src/i18n`       | English + French catalogs, co-located per screen, zero dependencies.                                                                                                                                                                      |
| `src/state.tsx`  | The app store: snapshot resources, wallet session, the cart and the in-memory signing session, settings persistence.                                                                                                                      |

Notable UI behavior: a finalized survey renders its **content-addressed result
artifact** (per-role weighted bars, turnout, provenance note, artifact hash —
recomputed locally from the served bytes), with a toggle back to the raw
unweighted tally. Anyone can re-derive the artifact from chain data with
`pnpm --filter cardano-tessera-verifier verify` (see `packages/verifier`).

## Develop

| Command (from repo root, or drop the filter inside `frontend/app`) | What it does                 |
| ------------------------------------------------------------------ | ---------------------------- |
| `pnpm --filter tessera-app dev`                                    | Vite dev server.             |
| `pnpm --filter tessera-app test`                                   | Unit tests (Vitest).         |
| `pnpm --filter tessera-app type-check`                             | `tsc --noEmit`.              |
| `pnpm --filter tessera-app build`                                  | Production build to `dist/`. |
| `pnpm format` / `pnpm format:check` (in `frontend/app`)            | Prettier.                    |

Workspace packages (`cardano-tessera-core`, `cardano-tessera-koios`, `cip-179`) are consumed
from TypeScript source, so cross-package edits are live in the dev server with
no build step.

## Deploy

Static assets on Cloudflare Workers, one deployment per network (see
`wrangler.toml`):

```sh
pnpm --filter tessera-app deploy:preview   # builds with .env.preview, uploads dist/
pnpm --filter tessera-app deploy:preprod   # builds with .env.preprod, --env preprod
pnpm --filter tessera-app deploy:mainnet   # builds with .env.mainnet, --env mainnet
```

Each mode file bakes that network's configuration and links to other configured
network deployments into the bundle at build time. CIP-30 identifies both
preprod and Preview as network id `0`; the app cannot distinguish those
wallet-selected testnets through the standard wallet API, so users must select
the exact one. Backend identity, Koios, storage, explorer links, and Evolution
chain parameters remain distinct.

[cip179]: https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179
[drand]: https://drand.love/
[solid]: https://www.solidjs.com/
[vite]: https://vite.dev/
