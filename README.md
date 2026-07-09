# Tessera

A browser app to **create, browse, respond to, and tally** on-chain surveys and
polls on Cardano, implementing [CIP-179][cip179] (transaction metadata **label
17**).

Surveys live entirely in transaction metadata — no smart contracts, no custom
backend required to read them. Responses can be **public** or **sealed**
(timelock-encrypted with [drand][drand] for delayed reveal), eligibility is
scoped by on-chain **role** (DRep, SPO, CC, Stakeholder, Owner), and tallies are
computed client-side directly from chain data.

> **Status:** active development. The frontend (explore, results, wallet,
> respond, create, cancel, sealed mode, IPFS enrichment, governance linkage) is
> functional, as is the Tier-1 serving backend (Koios read path cached
> server-side; runs as a Node process or a Cloudflare Worker). The backend also
> validates responses (deadline, credential proof, dedup), snapshots
> stake/voting-power weights at each survey's end epoch, and finalizes closed
> surveys into **content-addressed, re-verifiable result artifacts** that the
> app renders as final weighted results; `packages/verifier` re-derives any
> artifact from chain data and checks the hash. See `backend/ARCHITECTURE.md`.

## Governance linkage

A survey can be advertised by a Conway **governance Info Action** (CIP-179
_Action → Survey_ linkage): the action's anchor metadata carries the survey's
ref, and Tessera surfaces the link on the explore and survey pages once the
action's voting deadline matches the survey's end epoch.

The app ships a small helper page at **`/propose-info-action`** to build, sign,
and submit that Info Action from a CIP-30 wallet: load a CIP-108 anchor
document, and the page validates its shape, extracts the linked survey, and
checks the epoch alignment before letting you submit. You can pin the exact
anchor bytes to your configured IPFS providers (or host them yourself) so the
served document matches the on-chain hash.

## Repository layout

| Path                | What it is                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `frontend/app`      | The browser app — [SolidJS][solid] + [Vite][vite] + TypeScript.                                                          |
| `packages/cip179`   | The reusable `cip-179` package: label-17 codec plus the cross-implementation domain / tally / txproof / tlock surface.   |
| `packages/core`     | Shared pure domain (`@tessera/core`): types, wire codec, audit/tally rules, weighted tally, canonical artifact + hashes. |
| `packages/koios`    | The Koios read path (`KoiosDataSource`, tally inputs, tx-proof decoding), shared by direct mode, backend, and verifier.  |
| `packages/verifier` | Standalone CLI that re-derives a survey's result artifact from chain data and checks its content hash.                   |
| `backend/server`    | Tier-1 serving backend: cached chain reads, response validation, weight snapshots, artifact finalization. Node or CF+D1. |
| `backend/deps`      | Indexer submodules (Adder / Yaci Store / Oura) for a future Tier-2; design notes in `backend/*.md`.                      |

## Quick start

Requires **Node ≥ 22.5** and **pnpm ≥ 10** ([install pnpm][pnpm]). This is a
pnpm workspace — install once at the repository root:

```sh
pnpm install
pnpm --filter @tessera/backend dev                                     # terminal 1
VITE_INDEXER_URL=http://localhost:8787 pnpm --filter tessera-app dev   # terminal 2
```

The app serves at http://127.0.0.1:3000, reading chain data through the local
backend — **no Koios token needed**, for reads or for building transactions
(they are signed and submitted by your CIP-30 wallet).

Alternatively, skip the backend and let the browser scan [Koios][koios]
directly (the power-user/offline path) by leaving `VITE_INDEXER_URL` unset.
That path requires an authenticated Koios token (tier 1 is free): the anonymous
tier does not send CORS headers, so browser requests need one. Paste it in the
app's **Settings**, or set `VITE_KOIOS_TOKEN` in `frontend/app/.env`.

### Environment

Copy `frontend/app/.env.example` to `frontend/app/.env`; every variable is
optional and documented there. The main ones:

- `VITE_NETWORK` — `preview` (default) or `mainnet`. **One deployment serves
  one network** (no runtime switch); the header links to the counterpart app
  when `VITE_OTHER_NETWORK_URL` is set.
- `VITE_INDEXER_URL` — the Tier-1 backend for that network. The app verifies
  the backend serves the same network (via its `/health`) and refuses a
  mismatch. Overridable per network in Settings.

IPFS reads race a built-in list of public gateways (no config); IPFS _pinning_
(for authoring external content / rationales) uses per-provider API tokens
entered in Settings, stored only in the browser.

## Development

The repo is a pnpm workspace (`frontend/app`, `packages/cip179`,
`packages/core`, `packages/koios`, `packages/verifier`, `backend/server`).
Packages are consumed from TypeScript source (Vite aliases / `exports` pointing
at `src`), so cross-package edits are live with no build step.

From the repository root:

| Command                                                                       | What it does                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm -r type-check`                                                          | Type-check every package.                                                    |
| `pnpm -r test`                                                                | Run every package's unit tests (Vitest).                                     |
| `pnpm --filter tessera-app dev`                                               | Start the app's Vite dev server.                                             |
| `pnpm --filter @tessera/backend dev`                                          | Run the Tier-1 backend locally (see its [README](backend/server/README.md)). |
| `pnpm --filter tessera-app build`                                             | Production build of the app.                                                 |
| `pnpm --filter @tessera/verifier verify -- --backend <url> --survey <tx>:<i>` | Re-verify a survey's final result artifact from chain data.                  |

Formatting is Prettier (`pnpm format` / `pnpm format:check` in `frontend/app`).

Both halves deploy to Cloudflare with `wrangler`, one deployment per network:
the backend as a Worker + D1 + Cron
(`pnpm --filter @tessera/backend deploy:preview` / `deploy:mainnet`, after the
one-time D1 setup in `backend/server/README.md`), the app as static Workers
assets (`pnpm --filter tessera-app deploy:preview` / `deploy:mainnet` — each
builds with its committed `.env.preview` / `.env.mainnet` and uploads `dist/`;
see `frontend/app/wrangler.toml`). The `backend/deps` submodules
are not needed for any of this; to fetch them anyway:
`git submodule update --init --recursive`.

## Contributing

Contributions are welcome. Until a `CONTRIBUTING.md` lands, the basics:

- Open an issue to discuss substantial changes before investing in a PR.
- Keep the build green: `pnpm -r type-check`, `pnpm -r test`, and
  `pnpm format:check` (in `frontend/app`) should all pass (CI runs these on
  every PR).
- Match the existing code style — Prettier is the source of truth for formatting.

## License

The **code** in this repository is licensed under the [Apache License
2.0](LICENSE).

[cip179]: https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179
[drand]: https://drand.love/
[solid]: https://www.solidjs.com/
[vite]: https://vite.dev/
[pnpm]: https://pnpm.io/installation
[koios]: https://koios.rest/
[ccby]: https://creativecommons.org/licenses/by/4.0/
