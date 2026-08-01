# cardano-tessera-respond-react

React bindings for [`cardano-tessera-respond`](https://github.com/mpizenberg/Tessera/tree/main/packages/respond-widget#readme),
the embeddable `<tessera-respond>` CIP-179 survey widget.

The custom element needs two things React's JSX can't give it directly: its
object-valued props must be set as DOM **properties** (React ≤18 writes
unknown JSX props as HTML attributes), and its `tessera:*` `CustomEvent`s need
real `addEventListener` calls on any React version. `<TesseraRespond>` does
both through a ref — identically on React 18 and 19.

```sh
npm install cardano-tessera-respond-react cardano-tessera-respond
```

```tsx
import { TesseraRespond } from "cardano-tessera-respond-react";

function Survey({ definition, surveyRef, responder, tipEpoch }) {
  return (
    <TesseraRespond
      definition={definition}
      surveyRef={surveyRef}
      responder={responder}
      tipEpoch={tipEpoch}
      onResponse={({ payload, proveCredentials }) => {
        // 1. attach `payload` at metadata label 17
        // 2. prove each credential (required_signers / governance vote)
        // 3. sign with the wallet, submit
      }}
    />
  );
}
```

Importing the package registers the element (a no-op without a DOM, so plain
imports are safe under Next.js and other SSR setups; the element upgrades and
renders client-side).

## Props

Every widget prop, with the same names, types, and semantics — see the
[widget README](https://github.com/mpizenberg/Tessera/tree/main/packages/respond-widget#props)
for the full contract. The four required ones are `definition`, `surveyRef`,
`responder`, and `tipEpoch`. On top of those:

| Prop                         | Replaces the event |
| ---------------------------- | ------------------ |
| `onResponse={(detail) => …}` | `tessera:response` |
| `onChange={(detail) => …}`   | `tessera:change`   |
| `onInvalid={(detail) => …}`  | `tessera:invalid`  |

Callback details are fully typed (`RespondResult`, `RespondChangeDetail`,
`RespondInvalidDetail` re-export from here). `className`, `id`, and `style`
pass through to the host element — style the widget itself via its
[`--tessera-*` design tokens](https://github.com/mpizenberg/Tessera/tree/main/packages/respond-widget#theming--fonts).
`ref` exposes the underlying `TesseraRespondElement`.

Note the widget announces progress as soon as it renders, so `onChange` fires
once on mount with the initial `{ decided, total, valid }`.

## Working example

A minimal Vite app lives at
[`examples/react-host`](https://github.com/mpizenberg/Tessera/tree/main/examples/react-host)
in the repository; it is built in CI against the current widget.

## License

Apache-2.0
