# @tessera/respond-widget

The embeddable **`<tessera-respond>`** custom element: drop it into any web page to
let a user answer a [CIP-179](../../frontend/cip-179.md) survey. Give it a survey
definition and a responder (a role→credential map) as props; it renders the answering UI,
validates the answers, timelock-encrypts them for a sealed survey, and emits a
**ready-to-attach label-17 `Metadatum`** back to you via a `CustomEvent`. You
attach that payload to a transaction and submit it.

Framework-agnostic (it's a Web Component — use it from React, Vue, Svelte, Solid,
or plain HTML). **The widget never touches a wallet, a chain, IPFS,
`localStorage`, or your page's `<html>`.** Connecting a wallet, reading the chain,
building/signing/submitting the transaction, and network conformance are all
yours.

## Division of labor

| Concern                                                              | Owner                                             |
| :------------------------------------------------------------------- | :------------------------------------------------ |
| Wallet connection (CIP-30/95), signing, submission                   | **Host**                                          |
| Network conformance (wallet network ↔ target chain)                  | **Host** — the widget never sees a network id     |
| Fetching / enriching the `SurveyDefinition`                          | **Host**                                          |
| Supplying the chain tip (`tipEpoch`) and cancellation (`cancelled`)  | **Host** (props, refreshed as it sees fit)        |
| IPFS pinning for a rationale                                         | **Host** (passes a pre-pinned anchor)             |
| Rendering the form, validation, sealed encryption, label-17 encoding | **Widget**                                        |
| Open/closed gating from the tip; quicknet check for a sealed survey  | **Widget** (`surveyStatus` from `cip-179/domain`) |

The widget hands you a validated (and, if sealed, already-encrypted) payload. You
are responsible only for attaching it at metadata label 17, **proving** each
declared credential through the carrying transaction (see
[Proving credentials](#proving-credentials)), signing, and submitting.

## Two ways to consume it

The package ships both the TypeScript **source** and a self-contained built **ES
bundle**, mirroring `cip-179`'s dual exports:

| Import                             | What it is                                                                                  | For                                                         |
| :--------------------------------- | :------------------------------------------------------------------------------------------ | :---------------------------------------------------------- |
| `@tessera/respond-widget`          | The public prop/event **types** + the pieces to compose it yourself.                        | Type-only imports in a bundler host.                        |
| `@tessera/respond-widget/element`  | Side-effect import that **registers** `<tessera-respond>`, re-exports the API.              | Bundler hosts — `import "@tessera/respond-widget/element"`. |
| `@tessera/respond-widget/artifact` | The built `dist/tessera-respond.es.js` — Solid + `respond-core` + `cip-179` all bundled in. | Plain `<script type="module">` hosts, no bundler.           |

- **Bundler host** (React/Vue/Svelte/Solid/…): `import "@tessera/respond-widget/element"`
  once to register the element, then use `<tessera-respond>` in your markup. Under
  a bundler this consumes the source, so Solid can be deduped to a single instance
  (see [Single Solid instance](#single-solid-instance)).
- **Script-tag host** (no build step): load the built bundle with
  `<script type="module">`. It's fully self-contained — no peer to install, no
  external import. The heavy sealed-encryption code splits into lazy chunks
  fetched only when someone answers a sealed survey.

**Build format is ES only, by design.** `vite build` runs Rollup, which cannot
code-split UMD/IIFE output — a UMD target would force the lazy tlock/evolution
chunks to inline and defeat the whole point. Script-tag hosts therefore use
`<script type="module">`; there is no UMD build.

## Quick start (plain HTML, no bundler)

```html
<script type="module">
  // Registers <tessera-respond>. Use the package's /artifact bundle, or a
  // relative path to dist/ as here.
  import "./node_modules/@tessera/respond-widget/dist/tessera-respond.es.js";

  const el = document.querySelector("tessera-respond");

  // Object-valued props are set as DOM PROPERTIES, not attributes.
  el.definition = surveyDefinition; // the SurveyDefinition you fetched
  el.surveyRef = { txId, index }; // where it lives on-chain
  // Each role the user can answer as → its credential. Keys are the cip-179
  // Role numbers: Keyholder 4, Stakeholder 3, DRep 0, SPO 1, CC 2.
  el.responder = { 4: paymentCred, 3: stakeCred, 0: drepCred };
  el.tipEpoch = currentEpoch; // from your chain-tip source

  // The widget emits; you attach + sign + submit.
  el.addEventListener("tessera:response", async (e) => {
    const { payload, proveCredentials } = e.detail;
    // 1. attach `payload` at metadata label 17
    // 2. prove each proveCredentials[i].credential in the tx — via
    //    required_signers (mechanism A) or a governance vote (mechanism B)
    // 3. sign with the wallet, submit
  });
</script>

<tessera-respond></tessera-respond>
```

Until every **required** prop (`definition`, `surveyRef`, `responder`,
`tipEpoch`) is present, the element renders nothing — so writing
`<tessera-respond>` in static HTML and assigning props later (as above) is the
intended pattern; it upgrades and connects before your script runs.

For a full **bundler + wallet + real submission** example, see the reference host
in the app: [`frontend/app/src/ui/screens/DevWidgetHost.tsx`](../../frontend/app/src/ui/screens/DevWidgetHost.tsx).
It embeds `<tessera-respond>` exactly as a third-party integrator would and closes
the loop the widget leaves open — proving `proveCredentials` via `required_signers`
(mechanism A) and signing + submitting through a CIP-30 wallet.

## Props

Object-valued props (everything but `locale`, `layout`, `cancelled`, `tipEpoch`)
**must be set as DOM properties** (`el.definition = …`), never as HTML attributes.
`solid-element` exposes each as a reactive prop with a hyphenated attribute alias,
so the string/number/boolean ones (`locale`, `layout`, `tip-epoch`, `cancelled`)
_may_ also be written as plain attributes.

| Prop              | Type                            | Req. | Default            | Notes                                                                                                              |
| :---------------- | :------------------------------ | :--: | :----------------- | :----------------------------------------------------------------------------------------------------------------- |
| `definition`      | `SurveyDefinition`              |  ✓   | —                  | On-chain, or host-enriched with off-chain labels. The widget never fetches — you supply the display definition.    |
| `surveyRef`       | `SurveyRef` (`{ txId, index }`) |  ✓   | —                  | Where the definition lives on-chain. Rides back out on every result and into the built response.                   |
| `responder`       | `Responder`                     |  ✓   | —                  | Who's answering — see [The responder](#the-responder--eligibility).                                                |
| `tipEpoch`        | `number`                        |  ✓   | —                  | Current chain-tip epoch. The widget derives open/ended and blocks a closed survey. A snapshot — re-set to refresh. |
| `cancelled`       | `boolean`                       |      | `false`            | A valid on-chain cancellation exists (you checked); renders the cancelled state, no form.                          |
| `priorResponses`  | `readonly SurveyResponse[]`     |      | —                  | Prefill for an edit/replace flow — see [Prior responses](#prior-responses-editreplace).                            |
| `rationaleAnchor` | `ContentAnchor`                 |      | —                  | A host-pre-pinned rationale (CIP-179 key 5). The widget never pins to IPFS.                                        |
| `locale`          | `string` (BCP-47)               |      | `"en"`             | Drives both strings and number/date formatting — see [Internationalization](#internationalization).                |
| `messages`        | `DeepPartial<RespondMessages>`  |      | —                  | Deep-merged string overrides, or a whole unshipped language.                                                       |
| `theme`           | `Record<string, string>`        |      | —                  | Design-token overrides, reflected as `--tessera-<key>` on the host — see [Theming](#theming--fonts).               |
| `layout`          | `"one-per-screen" \| "list"`    |      | `"one-per-screen"` | Stepper (one question at a time) or all questions at once.                                                         |
| `role`            | `Role`                          |      | —                  | Initial role when the responder is eligible in several. The user can still switch.                                 |

## Events

All three are dispatched on the element with `bubbles: true, composed: true`, so a
listener anywhere up the light-DOM tree catches them across the shadow boundary.

| Event              | `detail`               | When                                                                                        |
| :----------------- | :--------------------- | :------------------------------------------------------------------------------------------ |
| `tessera:response` | `RespondResult`        | The user finalizes a valid answer set. **The widget does not submit** — you do.             |
| `tessera:change`   | `RespondChangeDetail`  | Any answer edit — `{ decided, total, valid }`, for a host-driven submit button.             |
| `tessera:invalid`  | `RespondInvalidDetail` | Validation failed on submit — `{ problems, messages }` (structured codes + localized text). |

### `RespondResult` — the payload to submit

```ts
interface RespondResult {
  surveyRef: SurveyRef;
  role: Role;
  credential: Credential;
  payload: Metadatum; // attach at metadata label 17
  proveCredentials: CredentialProof[]; // prove each in the carrying tx
  sealed: boolean;
}

interface CredentialProof {
  credential: Credential;
  keyKind: "payment" | "stake" | "drep" | "pool" | "cc"; // which key proves it
}
```

`payload` is a generic `Metadatum` tree (**not** CBOR bytes) — hand it to your
Cardano library's metadatum serializer at label 17. Each `proveCredentials` entry
names a credential the transaction must **prove** control of, and `keyKind` tells
you which key does so (e.g. the stake key when answering as Stakeholder).

### Proving credentials

CIP-179 authenticates a response's credential through its carrying transaction by
**either** of two mechanisms — the widget only _declares_ the credentials; **how**
you prove them is yours:

- **Mechanism A** — put the credential in the transaction's `required_signers`
  (or satisfy its native script in the witness set). Works for every role. This is
  the simple, always-available path, and what the reference host does via
  `frontend/app/src/wallet/submit.ts` (`submitMetadataTx` adds each credential with
  `tx.addSigner`).
- **Mechanism B** (governance-linked surveys only) — the **same transaction**
  casts a qualifying **governance vote** with that very credential on one of the
  survey's linked actions, the Conway voter tag matching the claimed role (CC,
  DRep, SPO). No `required_signers` entry is then needed for it — the vote binding
  is the proof. Only DRep / SPO / CC can bind this way; Stakeholder and Keyholder
  have no voter tag and must use mechanism A.

So a DRep answering a governance-linked survey in the very transaction that votes
on its linked action is already proven by that vote (mechanism B); in any other
case, add the credential to `required_signers` (mechanism A). `keyKind` is the same
hint either way — it tells you which key signs, whether that signature lands in
`required_signers` or in the vote's witness.

## The responder & eligibility

`responder` maps each role the user can answer as to the credential that role
carries — one uniform map (no wallet shape, no provenance flags):

```ts
type Responder = Partial<Record<Role, Credential>>;
```

- **Keyholder / Stakeholder / DRep** come from a connected wallet — its
  payment / stake / DRep credentials. Deriving them is yours; the widget never
  touches a wallet. The Tessera app does it in
  [`frontend/app/src/domain/roles.ts`](../../frontend/app/src/domain/roles.ts)
  (`walletResponder`), which you can copy.
- **SPO and CC** need cold keys a browser wallet can't hold, so they're never
  wallet-derivable — add them as extra entries when your host vouches for one. A
  responder can be entirely host-supplied (an SPO credential and nothing else).
- The widget takes the map **verbatim** and never validates it — it lists each
  chosen credential in `proveCredentials` for you to prove through the carrying
  transaction (see [Proving credentials](#proving-credentials)).
- **The widget picks the role internally.** A responder eligible in several roles
  gets a role picker; the emitted `role` + `credential` reflect the one chosen.
  The role → signing-key mapping is fixed: Keyholder→`payment`,
  Stakeholder→`stake`, DRep→`drep`, SPO→`pool`, CC→`cc`.

`@tessera/respond-core` exports `respondableRolesFor(def, responder)` and
`credentialForRole(role, responder)` if you want to compute eligibility host-side
too (e.g. to decide whether to mount the widget at all).

## Prior responses (edit/replace)

To prefill an existing answer for an edit/replace flow, pass the responder's prior
**public** responses in `priorResponses` — **one per role** they've answered as.

The role is chosen _inside_ the widget, so the host can't know up front which
prior response applies: pass them all, and the widget selects the one matching the
current role + credential, re-prefilling as the user switches roles. A responder
who answered as both DRep and Stakeholder passes both; the array is
order-independent.

```ts
// One deduped "mine" set, resolved to a prior response per respondable role.
el.priorResponses = respondableRolesFor(def, responder).flatMap((r) => {
  const cred = credentialForRole(r, responder);
  const prior = cred
    ? findExistingResponse(mine, surveyRef, r, cred)
    : undefined;
  return prior ? [prior] : [];
});
```

Public prior responses only — a **sealed** prior response is ciphertext and cannot
prefill (it's ignored). The reference host `DevWidgetHost.tsx` does exactly this
against a survey bundle.

## What the host must do

The widget deliberately leaves these to you:

1. **Attach + submit.** On `tessera:response`, put `payload` at metadata label 17,
   prove each `proveCredentials[].credential` in the transaction — via
   `required_signers` or a governance-vote binding (see
   [Proving credentials](#proving-credentials)) — sign with the indicated key
   kinds, and submit.
2. **Network conformance.** The responder carries no network id, so the widget
   can't tell whether the wallet is on the wrong chain. Check
   `walletNetworkId === targetNetwork` before you submit.
3. **Tip freshness.** `tipEpoch` is a snapshot; a survey can close between your
   last refresh and the user's submit. Re-set the prop to refresh. The chain (and
   the tally's eligibility rules) is the final arbiter regardless — the emitted
   payload is still only a payload.
4. **Only mount for an open survey.** The widget blocks a closed/cancelled survey
   from its own gate, but you decide whether to show it at all — pass an accurate
   `tipEpoch` and `cancelled`.
5. **Enrich the definition.** Any off-chain label enrichment (IPFS presentation
   docs, etc.) happens upstream; the widget renders the `definition` you give it.
6. **Pin a rationale** (if used). Pass a pre-pinned `ContentAnchor` in
   `rationaleAnchor`; the widget attaches it but never pins.

## Sealed surveys

For a survey with `submissionMode.type === "sealed"`, the widget owns encryption
end-to-end: it timelock-encrypts the answers to the survey's drand round
(`cip-179/tlock`) before emitting, so the sealed `payload` you receive is already
the final ciphertext wrapped in the label-17 envelope — you can't get it wrong.
`sealed: true` on the result marks it.

- The heavy sealing code (tlock + the evolution CBOR codec) is **lazy-loaded** only
  when a sealed survey is answered. The public path never loads it. In a built
  bundle these are separate chunks fetched on demand.
- **Quicknet only.** cip-179 supports only the drand quicknet chain today, and
  `sealAnswers` encrypts to quicknet unconditionally. A sealed definition pinned to
  any other drand chain would produce a permanently undecryptable response, so the
  widget **blocks submission** (rather than mis-encrypting) and shows a notice.

## Internationalization

Hybrid strategy driven by two props:

- **`locale`** (BCP-47, default `"en"`) selects a bundled catalog. **`en` and `fr`
  ship.** It also drives all number and date formatting via `Intl`, keyed on the
  locale — including the sealed-reveal date.
- **`messages`** deep-merges string overrides over the bundled catalog, or supplies
  an entirely unshipped language.

Numbers always follow `locale`, even when strings fall back to English. If `locale`
resolves to **no bundled catalog and no `messages`**, the widget emits a one-time
`console.warn` in dev builds (e.g. _"locale 'de' has no bundled catalog and no
`messages`; UI text will render in English."_) — the number/date formatting is
still locale-correct, only the prose falls back.

```ts
el.locale = "fr"; // bundled
el.locale = "de";
el.messages = { submit: { send: "Absenden" } /* … */ }; // supply/override strings
```

## Theming & fonts

Every color, radius, and font is a `--tessera-*` CSS custom property defined on
`:host` inside the shadow root (defaults ported from the app's design tokens).
Custom properties inherit _through_ the shadow boundary, so you override them two
equivalent ways:

```css
/* Host CSS — target the element. */
tessera-respond {
  --tessera-accent: #6b46ff;
  --tessera-role-drep: #6b46ff;
}
```

```ts
// The `theme` prop — each entry reflected as `--tessera-<key>` inline on :host.
el.theme = { accent: "#6b46ff", "role-drep": "#6b46ff" };
```

Role chips have their own tokens (`--tessera-role-drep`, `--tessera-role-spo`,
`--tessera-role-cc`, `--tessera-role-stakeholder`, `--tessera-role-keyholder`, each
with a `-bg` pair). See [`src/theme.css`](./src/theme.css) for the full token list.

- **Dark mode.** You can re-skin every color through the tokens, but native form
  controls (range track, number spinners) also need `color-scheme: dark`, which a
  custom property cannot express. Set it in host CSS on the element (or a wrapper):
  `tessera-respond { color-scheme: dark; }`. The `:host` root is transparent, so it
  takes your page's background.
- **Fonts.** The widget **names** fonts via `--tessera-sans` / `--tessera-mono` /
  `--tessera-serif` but **never loads them** — loading webfonts is the host page's
  job (a shadow root can't reach your `@font-face` rules for _loading_, only for
  _using_ already-loaded families). Point these tokens at families your page has
  loaded, or leave the system-font fallbacks.

## Layout

- **`"one-per-screen"`** (default) — a stepper: one question at a time with
  prev/next and progress dots.
- **`"list"`** — every question rendered at once.

Both reuse the same body components, the same `decided()` gating, and the same
answer collection; layout is pure presentation over shared state.

## Single Solid instance

The widget is built on SolidJS. A bundler host that also uses Solid (or embeds
another Solid custom element) must ensure a **single** Solid runtime instance —
two copies break reactivity. Under pnpm this usually happens automatically
(shared symlink); with a bundler, add `solid-js` and `solid-element` to your
`resolve.dedupe`. The Tessera app does exactly this in
[`frontend/app/vite.config.ts`](../../frontend/app/vite.config.ts). A script-tag
host loading the self-contained artifact has no such concern — Solid is bundled in.

## Development

```sh
pnpm install
pnpm --filter @tessera/respond-widget dev    # Vite dev harness (dev/index.html)
pnpm --filter @tessera/respond-widget build   # emits dist/tessera-respond.es.js + chunks
pnpm --filter @tessera/respond-widget test    # builds, then runs the artifact + token tests
pnpm --filter @tessera/respond-widget type-check
```

Two demo/test surfaces cover different failure modes:

| Path                    | What it drives                                                                                                        |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| `dev/`                  | Vite dev harness — `RespondRoot` in a shadow root, real workspace source, all samples/locales/themes.                 |
| `demo/index.html`       | Plain-HTML host for the **built** bundle, fully offline. Shows the sealed chunks lazy-loading in the network tab.     |
| `test/artifact.test.ts` | The automated twin of `demo/` — mounts the built artifact in happy-dom, offline, asserts the whole prop → event loop. |
| `test/tokens.test.ts`   | Gate: every `--tessera-*` referenced in the CSS is defined in `theme.css`, and vice-versa.                            |

In the workspace the package is consumed straight from `src` (its `exports` map
points at TypeScript source, like every sibling), so cross-package edits are live
with no build step.

## Layout

| Path              | Purpose                                                                   |
| :---------------- | :------------------------------------------------------------------------ |
| `src/element.tsx` | `customElement("tessera-respond", …)` registration + prop reflection.     |
| `src/Respond.tsx` | The trimmed answering component (props in → `tessera:*` events out).      |
| `src/bodies/`     | Per-question body components (single-choice, ranking, numeric, …).        |
| `src/roles.ts`    | Role label/color/keyKind presentation over the injected catalog + tokens. |
| `src/theme.css`   | The `--tessera-*` design-token defaults on `:host`.                       |
| `src/styles/`     | Component CSS, shadow-scoped plain CSS delivered via `?inline`.           |
| `src/types.ts`    | The public prop/event TypeScript contract.                                |

See [`@tessera/respond-core`](../respond-core/README.md) for the pure logic the
widget (and the app) share.
