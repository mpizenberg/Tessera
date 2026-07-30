# @tessera/respond-core

The **pure, framework-free core** for answering [CIP-179](../../frontend/cip-179.md)
surveys: response drafting, responder eligibility, an instance-scoped i18n
factory, and the lazy sealed-submission wrapper.

No I/O, no framework, no DOM, **and no wallet knowledge** — everything a codec type
away from `cip-179`. It is shared by the Tessera app and the embeddable
[`<tessera-respond>`](../respond-widget/README.md) widget so both compute
eligibility, build responses, and localize from one source of truth. Reach for it
directly only if you're building your own answering UI or computing eligibility
host-side; if you just embed the widget, you rarely import this package.

## What's inside

| Module           | Exports                                                                                                                                                        |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eligibility.ts` | `Responder` (the role→credential map), `respondableRolesFor`, `credentialForRole`.                                                                             |
| `draft.ts`       | `Draft` / `DraftValue`, `initDraft`, `decided`, `collectAnswers`, `buildResponse`, `buildSealedResponse`, `findPriorResponse`, `prefillDrafts`, `optionCount`. |
| `i18n.ts`        | `createI18n`, the `I18n` interface, `renderProblem`, catalog types.                                                                                            |
| `seal.ts`        | `sealResponse` — the lazy tlock + evolution-CBOR wrapper.                                                                                                      |

Everything is re-exported from the package root: `import { … } from "@tessera/respond-core"`.

## The responder & eligibility

A **`Responder`** is just the credential a responder asserts for each role it can
act as — one uniform map:

```ts
type Responder = Partial<Record<Role, Credential>>;
```

respond-core takes it **verbatim**: it never verifies that the responder controls
those credentials. Authenticity is bound _host-side_ by the response's carrying
transaction (CIP-179 credential proof — a `required_signers` entry or a
governance-vote binding), so respond-core stays **wallet-agnostic** — it doesn't
know or care whether an entry came from a browser wallet or a host-trusted cold
key.

- `respondableRolesFor(def, responder)` → the survey's `eligibleRoles` intersected
  with the roles the responder has a credential for (a _claim_ surface, not
  ledger-verified — role membership at the end-epoch snapshot is the indexer's job
  per CIP-179).
- `credentialForRole(role, responder)` → the credential for a chosen role, or
  `undefined`.

> **Deriving the map is the host's job**, not respond-core's.
> Keyholder / Stakeholder / DRep come from a browser wallet's payment / stake /
> DRep credentials; SPO and CC need cold keys no browser wallet holds, so a host
> adds them as extra entries. The Tessera app builds the whole map from a connected
> CIP-30 wallet in `frontend/app/src/domain/roles.ts` (`walletResponder`) — this
> package deliberately carries none of that wallet logic.

## Drafting & building responses

`draft.ts` is the pure answering pipeline: `initDraft(question)` seeds a `Draft`,
`decided(question, draft)` is the per-question completion gate, `collectAnswers`
turns drafts into validated `AnswerItem`s, and `buildResponse` /
`buildSealedResponse` assemble the `SurveyResponse` for the `cip-179` codec.
`findPriorResponse(responses, ref, role, credential)` selects a responder's own
prior response from a set — sealed ones included, since a sealed envelope still
proves they answered — and `prefillDrafts` seeds drafts from a public one (for an
edit/replace flow). This module moved verbatim from the app and carries its unit
tests.

## i18n factory

`createI18n({ locale, messages })` returns a **side-effect-free, instance-scoped**
`I18n` — no `localStorage`, no `navigator`, no mutation of the document. This
replaces the app's global reactive singleton for embedding contexts (the app keeps
its own global unchanged).

```ts
interface I18n {
  t(key: MsgKey, params?: Params): string; // translate + interpolate {token}
  n(value: number, options?): string; // Intl.NumberFormat, memoized
  d(unixSeconds: number, options?): string; // Intl.DateTimeFormat, unix SECONDS in
}
```

- `t` looks up `deepMerge(bundled[locale] ?? bundled.en, messages)`. **`en` and
  `fr` are bundled**; any other locale comes entirely from `messages`.
- `n` / `d` always format with `locale` via `Intl`, even when strings fall back to
  English. `d` takes **unix seconds** (e.g. a sealed-reveal moment) — no
  host-injected date formatter needed.
- On construction, if `locale` resolves to no bundled catalog **and** no
  `messages`, a one-time `console.warn` fires in dev builds (numbers/dates stay
  locale-correct; only prose falls back to English).
- `renderProblem(i18n, problem)` renders a structured cip-179 `ValidationProblem`
  from the catalog — the widget uses it for `tessera:invalid`.

## Sealed submission (lazy)

`sealResponse(answers, round, paddingSize)` timelock-encrypts a sealed response's
answers to a drand quicknet round. It's the **one place that pulls in the timelock
weight** — it dynamically imports `cip-179/evolution` (CBOR of the plaintext
answers) and `cip-179/tlock` (`@mattpiz/tlock-js`), so the public answering path
never loads either and a bundler splits them into chunks fetched only when a sealed
survey is actually answered.

Those two are declared as **optional peer dependencies**. Consumers on the public
path never install them.

> **Workspace note.** Inside this pnpm workspace the optional peers are satisfied
> by this package's own `devDependencies`. A production-only install
> (`pnpm install --prod`) skips them, and peers of a symlinked workspace package do
> **not** resolve from the consumer's `node_modules` — so a self-hosted Node
> deployment that calls `sealResponse` must install with devDependencies included
> (or hoist the two packages). Registry consumers resolve peers normally.

## Development

```sh
pnpm install
pnpm --filter @tessera/respond-core type-check
pnpm --filter @tessera/respond-core test
```

The package is consumed straight from `src` in the workspace (its `exports` map
points at TypeScript source), so cross-package edits are live with no build step.
