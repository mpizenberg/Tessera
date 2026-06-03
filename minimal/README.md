# CIP-179 Surveys Demo

A self-contained browser app demonstrating [CIP-179](./cip-179.md) — on-chain
**surveys and polls** stored entirely in Cardano transaction metadata, with no
custom backend. Everything is read straight from the chain through Koios, and
all writes are plain metadata transactions signed by a CIP-30 wallet.

It supports the full survey lifecycle:

- **Create** a survey (questions, roles, weighting, optional timelock) and submit
  it on-chain.
- **Respond** to a survey, optionally as a **timelocked ballot** that stays
  encrypted until a chosen Drand round publishes (commit-reveal voting).
- **Cancel** a survey you own.
- **Browse** responses and live tallies, **reveal** timelocked ballots once
  unlocked, and **export** results to CSV.
- **Share** a single-survey "kiosk" link that anyone can open to view/respond to
  one survey in isolation.

This started as a stripped-down fork of the CF voting app; the governance-proposal
plumbing is mostly vestigial (see _Legacy_ below).

## Running it

The app builds and signs transactions, so it must be compiled with `elm-cardano`
(which bundles the UPLC WASM evaluator), not plain `elm`:

```sh
elm-cardano make src/Main.elm --debug --output static/main.js
# Then serve static/ with any HTTP server, for example:
python -m http.server 3000 --directory static
```

Open `http://localhost:3000` in a browser with a CIP-30 wallet installed
(default network is Preview/Testnet — see the `networkId` flag in `index.html`).

Run the tests with `elm-test`.

## File structure

```
minimal/
  elm.json                    -- Elm project config, references ./elm-cardano/src
  cip-179.md                  -- The CIP-179 specification this app implements
  src/
    Main.elm                  -- App entry point: ports, model, update, view, tx building
    Api.elm                   -- Koios HTTP requests (epoch, protocol params, metadata by label)
    Route.elm                 -- URL parsing for single-survey "kiosk" mode (?survey=...)
    Tlock.elm                 -- Drand tlock timelock bindings (encrypt / fetchRound / decrypt)
    ProposalMetadata.elm      -- CIP-108 proposal metadata decoder (legacy, see below)
    Survey/
      Types.elm               -- Domain types (surveys, questions, responses, roles, ballots)
      Codec.elm               -- CIP-179 wire codec: Metadatum <-> domain + ballot padding
      Labels.elm              -- Metadata label scheme (primary + secondary index labels)
      Form.elm                -- Survey-creation & response form state + validation
      View.elm                -- Survey/form rendering
      Results.elm             -- Pure aggregation: dedup-to-latest + per-option tallies
      Csv.elm                 -- CSV export of (revealed) responses
  static/
    index.html                -- HTML shell with inline CSS and JS bootstrap
    elm-cardano.js            -- CIP-30 wallet + UPLC WASM companion (from elm-cardano)
    elm-concurrent-task.js    -- Async task runner (from andrewMacmurray/elm-concurrent-task)
    storage.js                -- IndexedDB wrapper (legacy, still wired in JS)
    tlock.js                  -- Drand tlock crypto bundle (esbuild of tlock-wrapper.ts)
    pkg-uplc-wasm/            -- UPLC WASM module for Plutus script evaluation
  tests/
    SurveyTests.elm           -- Ballot-padding upper-bound checks
```

## How it works

### Initialization sequence (`static/index.html`)

The JS bootstrap runs in this order:

1. **UPLC WASM init** — `elm-cardano.js` initializes the UPLC WebAssembly module
   (`pkg-uplc-wasm/`), needed by elm-cardano for transaction building/evaluation.
2. **Elm bundle loaded** — `ElmCardano.loadMain("/main.js")` injects the compiled
   Elm app as a `<script>` tag (after WASM is ready).
3. **IndexedDB initialized** — `Storage.init()` opens a DB with a
   `proposalMetadata` store (legacy; the Elm side no longer reads/writes it).
4. **Elm app started** — `Elm.Main.init()` receives three flags:
   - `url` — the current page URL, parsed by `Route.parseFocus` for kiosk mode
     and used as the base for shareable links.
   - `db` — the IndexedDB handle (opaque JS value; currently unused by Elm).
   - `networkId` — `0` for Preview/Testnet, `1` for Mainnet.
5. **Wallet ports wired** — `ElmCardano.init()` connects `toWallet` / `fromWallet`
   for CIP-30 communication.
6. **Clipboard port wired** — `copyToClipboard` is subscribed to
   `navigator.clipboard.writeText` for kiosk share links.
7. **Task ports registered** — `ConcurrentTask.register()` connects
   `sendTask` / `receiveTask` and registers the custom task handlers:
   `storage:read`, `storage:write`, `tlock:encrypt`, `tlock:fetchRound`,
   `tlock:decrypt`.

### Elm-side startup (`Main.elm init`)

`init` fires three commands in parallel:

- **Load protocol parameters** from the Koios Ogmios proxy
  (`queryLedgerState/protocolParameters`) for Plutus cost models (used when
  building transactions).
- **Query current epoch** (`queryLedgerState/epoch`). Once known, the survey
  **directory** load is kicked off.
- **Discover CIP-30 wallets** via the `toWallet` port.

### Metadata label scheme (`Survey/Labels.elm`)

Reading surveys without a backend means turning "find the relevant transactions"
into a cheap query. CIP-179 puts the survey payload under one primary label, and
this app adds two **secondary index labels** so the app can enumerate/filter
transactions via Koios `/tx_by_metalabel` _before_ downloading any metadata body:

| Label               | Value                                | On                                    | Purpose                         |
| ------------------- | ------------------------------------ | ------------------------------------- | ------------------------------- |
| `metadataLabel`     | `171717`                             | every survey/response/cancellation tx | the actual CIP-179 payload      |
| `definitionsLabel`  | `1717170`                            | survey-definition + cancellation txs  | the **survey directory** marker |
| `responseLabel ref` | `1717000000 + (fnv1a(ref) mod 2^20)` | every response tx                     | per-survey **response index**   |

`/tx_by_metalabel?_label=N` returns just `tx_hash` + `absolute_slot` (the queries
use `?select=` and `order=absolute_slot.desc` to stay small). The per-survey
`responseLabel` is a deterministic FNV-1a hash of `txHash:index` placed in a
2^20-wide band inside the uint32 (5-byte CBOR) range. Two different surveys can
collide on a `responseLabel`, but that only ever yields **false positives**: the
full response bodies are validated against the survey ref after download, so
colliding txs from another survey are filtered out.

### Data flow: surveys & responses

```
GotEpoch
  |
  +--> loadTxHashesByLabel definitionsLabel --> GotDirectoryTxHashes
                                                  |
                                  loadSurveyMetadata(hashes) --> GotDirectoryMetadata
                                                                   |
                                          (surveys + cancellations only)

user opens a survey's responses (or kiosk mode loads it eagerly):
  LoadResponses ref
    |
    +--> loadTxHashesByLabel (responseLabel ref) --> GotResponseTxHashes ref
                                                       |
                               loadSurveyMetadata(hashes) --> GotResponseMetadata ref
                                                                |
                                        (filtered to this survey's responses)
```

- The **directory** load is cheap and happens once: it enumerates definitions and
  cancellations without touching responses.
- **Responses are loaded lazily, per survey** (`responsesBySurvey : Dict String
(WebData ...)`), only when the user opens that survey's responses tab (or when
  kiosk mode focuses a survey). The "Responses" tab shows a _Load responses_
  button per survey rather than fetching everything upfront.
- `Survey.Results.dedupLatestResponses` keeps the latest ballot per
  `(role, credential)` identity, resolving "latest" by the tx's `absolute_slot`
  (tie-broken by response index).

### Data flow: wallet & transaction building

Unlike the original minimal app, this one **does** use the wallet to build and
submit transactions:

- **Discovery / connection** via `toWallet` / `fromWallet` (CIP-30, plus CIP-95
  governance extension when supported).
- **Submitting a survey / response / cancellation** builds a metadata-only
  transaction with `Cardano.TxIntent.finalize`, then `signTx` and `submitTx`
  through the wallet. UTxOs are fetched on demand (`getUtxos`) to fund fees.

Each transaction carries the primary `171717` payload plus the relevant secondary
index labels (a definition/cancellation also tags `1717170`; a response also tags
its survey's `responseLabel`). Distinct metadata tags are merged into one tx;
duplicate tags are rejected by elm-cardano.

### Timelocked ballots and padding

A survey can be created with **timelocked ballots**: each response's answers are
encrypted at submission with Drand `tlock` (quicknet) and only become decryptable
once a chosen Drand round publishes. This is a _delayed reveal_, not permanent
secrecy — after the round, anyone can decrypt every ballot. The crypto runs in
JS (`static/tlock.js`) and is reached from Elm through three
`elm-concurrent-task` tasks (`tlock:encrypt` / `tlock:fetchRound` /
`tlock:decrypt`, see `Tlock.elm`).

**Why padding.** The encrypted blob's length leaks information: a longer
ciphertext means a longer plaintext, which can reveal _how much_ a voter
answered (e.g. how many options they selected). To avoid this, the CBOR-encoded
answers are zero-padded up to a fixed `paddingSize` before encryption
(`Survey.Codec.plaintextHexForAnswers`). Decryption ignores the trailing zeros
because the CBOR answer array is self-delimiting. The padding size is stored once
per survey in its on-chain metadata, so every ballot for that survey shares it.

**Choosing the size automatically.** Leaving the "Padding size" field blank uses
`Survey.Codec.maxPlaintextSize`, the worst-case CBOR size of a _fully answered_
ballot for that survey's questions. Padding every ballot up to this value makes
all ciphertexts the same length, so size leaks nothing. The estimate sums a
per-question upper bound using the standard CBOR integer-width rules
(0..23 -> 1 byte, 24..255 -> 2, ..., capped at the 64-bit form, 9 bytes):

- **Single / multi / ranking**: choice indices are bounded by the option count;
  list answers by the max-selections / max-ranked limit.
- **Numeric**: the wider of the two range bounds, with negatives sized by the
  CBOR magnitude `-1 - v`, capped at 64-bit.
- **Free text (`Custom`)**: counted as the empty string `""`.

**Limitation — free text.** Because a free-text answer has no length bound, the
estimate counts it as empty. A survey with a `Custom` question therefore has no
size-hiding guarantee for that question: a real free-text answer longer than the
padding produces a longer ciphertext, revealing that the voter wrote something.
Bounding it would require imposing an explicit maximum answer length. The other
four question types are fully bounded, so for surveys without free text the
auto-sized padding makes every ciphertext identical in length.

`tests/SurveyTests.elm` validates this: it builds a maximal ballot, encodes it
through the real CBOR encoder, and checks the actual width never exceeds
`maxPlaintextSize` (run with `elm-test`).

### Revealing timelocked ballots (decoupled fetch + decrypt)

Every ballot of a survey is locked to the **same** Drand round, and a published
round's signature is immutable. So the round-fetch and the decryption are
decoupled in the JS wrapper (`tlock-wrapper.ts`):

- `tlock:fetchRound` is the **only networked step** — it fetches and verifies the
  Drand beacon for a round once, returning it as JSON.
- `tlock:decrypt` is **offline** — it decrypts a ciphertext using a beacon already
  fetched, via an offline `ChainClient` shim that serves the cached beacon while
  still verifying it against the pinned quicknet chain info.

On the Elm side, `roundBeacons : Dict Int (RemoteData ...)` caches the fetched
beacon per round. Revealing a ballot fetches its round's beacon once; every
subsequent reveal for that survey — including the **"Reveal all"** button —
decrypts locally with **zero additional network requests**.

> The bundle `static/tlock.js` is built from `../tlock-minimal-example/src/tlock-wrapper.ts`:
> `esbuild src/tlock-wrapper.ts --bundle --platform=neutral --main-fields=browser,module,main --format=esm --outfile=../minimal/static/tlock.js`

### Kiosk mode & shareable links (`Route.elm`)

A `?survey=<txHash>[:<index>]` query parameter switches the app into a
single-survey **kiosk** view: it focuses one survey, eagerly loads its responses,
and primes the response form. No parameter keeps the normal tabbed app; a
present-but-malformed value shows an error page.

In the normal "Surveys" tab, each survey card has a **Share link** button that
copies its kiosk URL (`<baseUrl>?survey=<txHash>:<index>`) to the clipboard via
the `copyToClipboard` port, showing a brief "Copied!" confirmation.

### Elm-JS interop: ports

| Port              | Direction | Purpose                                                               |
| ----------------- | --------- | --------------------------------------------------------------------- |
| `toWallet`        | Elm -> JS | CIP-30 wallet requests (discover, enable, getUtxos, signTx, submitTx) |
| `fromWallet`      | JS -> Elm | Wallet responses                                                      |
| `sendTask`        | Elm -> JS | Concurrent task requests (tlock, storage)                             |
| `receiveTask`     | JS -> Elm | Task results                                                          |
| `copyToClipboard` | Elm -> JS | Copy a kiosk share link to the clipboard                              |

Wallet ports carry `Json.Decode.Value`, encoded/decoded with
`Cardano.Cip30.encodeRequest` / `responseDecoder`. The task ports are managed by
`elm-concurrent-task` and carry the `tlock:*` and `storage:*` handlers registered
in `index.html`.

## Elm modules

- **Main.elm** — the whole app: `Flags`/`Model`/`Msg`, `init`, `update` (epoch,
  directory + per-survey response loads, wallet, tx build/sign/submit, reveal
  flow), `view`, and the port declarations.
- **Api.elm** — Koios HTTP: `loadProtocolParams`, `queryEpoch`,
  `loadTxHashesByLabel` (cheap `/tx_by_metalabel` query with `?select=`),
  `loadSurveyMetadata` (`/tx_metadata` for a hash list), plus the Koios-JSON ->
  `Metadatum` decoder.
- **Route.elm** — parses `?survey=...` into a kiosk `SurveyFocus`.
- **Tlock.elm** — `encrypt` / `fetchRound` / `decrypt` ConcurrentTask bindings and
  the quicknet round/time helpers (`roundForDeadline`, `revealTimeOf`).
- **Survey/Types.elm** — domain types: surveys, questions, roles, weighting,
  responses, ballot/timelock config and state.
- **Survey/Codec.elm** — CIP-179 `Metadatum` <-> domain codec, response envelope,
  and worst-case ballot sizing (`maxPlaintextSize`, `plaintextHexForAnswers`).
- **Survey/Labels.elm** — the metadata label scheme described above.
- **Survey/Form.elm** — survey-creation and response form state, validation, and
  form -> metadatum encoders.
- **Survey/View.elm** — rendering for surveys and forms.
- **Survey/Results.elm** — pure aggregation: dedup-to-latest-per-identity and
  per-option tallies.
- **Survey/Csv.elm** — CSV export of (revealed) responses.

## Dependencies

This app reuses the `elm-cardano` library source from `./elm-cardano/src`
(referenced in `elm.json` source-directories) for CIP-30, transaction building
(`Cardano.TxIntent`), metadata (`Cardano.Metadatum`), addresses, and byte/hash
utilities.

Key Elm package dependencies:

- `andrewMacmurray/elm-concurrent-task` — composable async tasks with port-based
  JS interop (tlock crypto, storage).
- `krisajenkins/remotedata` — `WebData` loading states.
- `robinheghan/fnv1a` — FNV-1a hashing for deterministic per-survey response labels.
- `lydell/elm-app-url` — URL query-parameter parsing for kiosk mode.
- `elm-toulouse/cbor` — CBOR encoding (ballot payloads; also used by elm-cardano).
- `elm-cardano/bech32` — Bech32 encoding for Cardano addresses and IDs.

JS-side: `@mpizenberg/tlock-js` (Drand quicknet timelock), bundled into
`static/tlock.js`.

## Legacy

The app descends from a governance-proposals viewer; some of that scaffolding
remains but is inactive:

- The **Proposals** tab is commented out; proposals are never fetched
  (`ProposalMetadata.elm` and `Api.ActiveProposal` are still compiled but unused).
- **IndexedDB** is still initialized in `index.html` and the `storage:*` task
  handlers are still registered, but the Elm side no longer reads or writes it
  (proposal-metadata caching is gone). The `db` flag is passed through unused.
