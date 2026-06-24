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
> functional; a semantic indexer backend is still in the research stage.

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

| Path                  | What it is                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `frontend/app`        | The browser app — [SolidJS][solid] + [Vite][vite] + TypeScript.                                |
| `frontend/cip179`     | A pure, dependency-free TypeScript library to encode / decode / validate the label-17 format.  |
| `backend`             | Research notes and submodules (Adder / Yaci Store / Oura) for a future indexer. Not yet wired. |

## Quick start

Requires **Node ≥ 20** and **pnpm ≥ 10** ([install pnpm][pnpm]).

```sh
cd frontend/app
cp .env.example .env     # then add a Koios token — see below
pnpm install
pnpm dev                 # http://127.0.0.1:3000
```

### Environment

An authenticated [Koios][koios] token is required: the free anonymous tier does
not send CORS headers, so browser requests need a token (tier 1 is free). Copy
`frontend/app/.env.example` to `frontend/app/.env` and fill in:

```
VITE_KOIOS_TOKEN=<your tier-1 Koios token>
VITE_NETWORK=preview      # "preview" (default) or "mainnet"
```

The Koios token can also be overridden at runtime in the app's **Settings**.
IPFS reads race a built-in list of public gateways (no config); IPFS _pinning_
(for authoring external content / rationales) uses per-provider API tokens
entered in Settings, stored only in the browser.

## Development

The app and the `cip-179` library are two independent pnpm packages. The app
resolves the library from source via a Vite alias + tsconfig path, so library
edits are live with no build step.

In `frontend/app`:

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `pnpm dev`          | Start the Vite dev server.              |
| `pnpm type-check`   | TypeScript type-check (`tsc --noEmit`). |
| `pnpm test`         | Run unit tests (Vitest).                |
| `pnpm build`        | Production build.                       |
| `pnpm format`       | Format with Prettier.                   |
| `pnpm format:check` | Check formatting without writing.       |

In `frontend/cip179`: `pnpm test`, `pnpm type-check`, and `pnpm build`.

The backend submodules are not needed for frontend work. To fetch them anyway:
`git submodule update --init --recursive`.

## Contributing

Contributions are welcome. Until a `CONTRIBUTING.md` lands, the basics:

- Open an issue to discuss substantial changes before investing in a PR.
- Keep the build green: `pnpm type-check`, `pnpm test`, and `pnpm format:check`
  should all pass (CI runs these on every PR).
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
