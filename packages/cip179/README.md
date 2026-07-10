# cip-179

Reusable TypeScript building blocks for the
[CIP-179](../../frontend/cip-179.md) _On-Chain Surveys and Polls_ format
(metadata label `17`, spec version 4).

The package is organized as **subpath entry points**, layered by dependency
weight. The root is a pure, side-effect-free codec with zero dependencies; the
heavier layers add pure domain semantics, the reproducible tally, and the
transaction-proof and sealed-submission stacks. The Cardano-serialization work
those last two need is **injected** (a small port + an adapter), so no Cardano
library is baked in: the evolution-sdk footprint is a swappable dependency, not a
requirement. Any CIP-179 implementation — not just Tessera, on any Cardano stack
— can build on these, interpret the same chain data, and produce hash-identical
tally artifacts.

## Entry points

| Import              | What it is                                                                                                                                            | Required peer deps         |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------- |
| `cip-179`           | The label-17 codec: encode / decode / validate the metadatum format.                                                                                  | none                       |
| `cip-179/domain`    | Pure semantics over on-chain records: dedupe, cancellation, credential proof, audit, answer rendering, survey aggregation.                            | none                       |
| `cip-179/tally`     | The reference count / stake-weighted ruleset and the canonical, content-addressed tally artifact.                                                     | none                       |
| `cip-179/txproof`   | Transaction CBOR → `TxProof` (mechanism-A/B evidence), over an injected `TxProofCodec`. **Imports no Cardano library itself.**                        | none¹                      |
| `cip-179/tlock`     | The sealed-submission stack for `sealed_submission_mode`: drand round math, timelock encrypt/decrypt, seal/reveal, over an injected `MetadatumCodec`. | `@mattpiz/tlock-js`        |
| `cip-179/evolution` | An `@evolution-sdk/evolution`-backed implementation of the `TxProofCodec` and `MetadatumCodec` ports — inject it, or write your own.                  | `@evolution-sdk/evolution` |

¹ `cip-179/txproof` needs a `TxProofCodec` supplied at call time (see below); the
default one lives in `cip-179/evolution`.

`@noble/hashes` is a regular (small) dependency, so `cip-179/tally` and
`cip-179/txproof` pull it in automatically.

### The Cardano-serialization seam (dependency injection)

The reusable layers (`cip-179`, `/domain`, `/tally`, and the interpretation in
`/txproof` and `/tlock`) contain **no Cardano-serialization library**. Everything
that needs one — decoding a transaction, canonical CBOR of a metadatum tree, the
bech32/CIP-129 id encodings — is expressed as a small **port** that the caller
injects an implementation of:

- **`MetadatumCodec`** (`cip-179/tlock`) — `metadatumToCbor` / `cborToMetadatum`.
- **`TxProofCodec`** (`cip-179/txproof`) — `stakeAddress` / `drepId` / `decodeTx`
  (the last returns a library-neutral `DecodedTx`; `cip-179` keeps the CIP-179
  interpretation — mechanism A/B, the Conway voter-tag semantics, native-script
  hashing).

`cip-179/evolution` is the **only** module that imports evolution-sdk; it ships a
ready `evolutionCodec` satisfying both ports. Consumers on the evolution stack
inject it:

```ts
import { decodeTxProof } from "cip-179/txproof";
import { sealAnswers, revealWithBeacon } from "cip-179/tlock";
import { evolutionCodec } from "cip-179/evolution";

const proof = decodeTxProof(evolutionCodec, txCborHex);
const sealed = await sealAnswers(evolutionCodec, answers, round, paddingSize);
```

A downstream implementer on **any other stack** (Lucid, Mesh, CSL, …) provides
their own object satisfying `MetadatumCodec` / `TxProofCodec`, never imports
`cip-179/evolution`, and never installs evolution-sdk — while reusing all of the
CIP-179 interpretation logic unchanged.

`@evolution-sdk/evolution` and `@mattpiz/tlock-js` are declared as _optional_
peers, so codec / domain / tally consumers (and anyone bringing their own codec)
never install them. `@mattpiz/tlock-js` is **lazy-imported** inside the tlock
client, so a finalize/verify pass touches it only when a sealed survey is
actually present.

> **Workspace note.** Inside this pnpm workspace the optional peers are
> satisfied by cip-179's own `devDependencies`. A production-only install
> (`pnpm install --prod`) skips those, and peers of a symlinked workspace
> package do **not** resolve from the consumer's `node_modules` — so a
> self-hosted Node deployment that uses `cip-179/tlock` or `cip-179/evolution`
> must install with devDependencies included (or hoist the two packages).
> Registry consumers are unaffected: npm/pnpm resolve peers normally there.

## The codec (`cip-179`)

The root export does three things, all without any I/O:

1. **Encode** ergonomic domain types into a generic Cardano _metadatum_ tree.
2. **Decode** a metadatum tree back into domain types (total; throws
   `Cip179DecodeError` with a path on malformed input).
3. **Validate** the cross-field invariants the CDDL can't express (option
   bounds, abstain/required rules, points summing to budget, rating scales, …).

### Library-agnostic by construction

The codec never depends on a specific Cardano library and never touches CBOR.
Its interchange type is a generic [`Metadatum`](./src/metadatum.ts), the
universal on-the-wire shape of `transaction_metadatum`:

```ts
type Metadatum =
  | bigint // int
  | string // text
  | Uint8Array // bytes
  | ReadonlyArray<Metadatum> // array
  | ReadonlyMap<Metadatum, Metadatum>; // map
```

`encodePayload` / `encodeMetadata` produce this tree; hand it to whatever
library you use (evolution-sdk, Lucid, Mesh, CSL, …) to serialize to CBOR.
`decodePayload` / `decodeMetadata` consume the same tree, whatever library
parsed the CBOR. Maps are emitted with integer keys in ascending order so an
order-preserving encoder yields the RFC 8949 §4.2 canonical CBOR the CIP
requires.

### Numeric convention

- `bigint` for ledger-style integers of unbounded magnitude: numeric-range
  bounds/values and rating-grid bounds/values.
- `number` for small structural integers: tags, indices, counts, epochs, roles,
  drand round, padding size.

### Chunked text / bytes

Long titles, descriptions, prompts and tlock ciphertext are exposed as plain
`string` / `Uint8Array`. Chunking into ≤64-byte pieces (CIP-20 style) happens
only at encode time; decoding rejoins. Text is split on code-point boundaries so
chunks are always valid UTF-8.

### What codec validation does _not_ cover

`validateDefinition` / `validateResponse` are pure and check only what's
determinable from the data itself. Everything requiring ledger state is left to
the `cip-179/domain` layer (fed by an indexer with chain access): credential
proofs (`required_signers` / `voting_procedures`), role membership, epoch
cutoffs, cancellation status, latest-wins deduplication, and external-anchor
fetch/hash verification.

### Usage

```ts
import {
  encodeMetadata,
  decodeMetadata,
  validateDefinition,
  Role,
  type Cip179Payload,
} from "cip-179";

const payload: Cip179Payload = {
  type: "definitions",
  definitions: [
    {
      specVersion: 5,
      owner: { type: "key", keyHash: ownerKeyHash /* Uint8Array(28) */ },
      title: "Dijkstra hard-fork CIP shortlist",
      description: "Select candidate CIPs for the Dijkstra hard fork.",
      eligibleRoles: [Role.DRep],
      endEpoch: 504,
      submissionMode: { type: "public" },
      questions: [
        {
          type: "multiSelect",
          prompt: "Which CIPs should be shortlisted?",
          options: { type: "options", labels: ["CIP-0108", "CIP-0119"] },
          minSelections: 1,
          maxSelections: 2,
        },
      ],
    },
  ],
};

const problems = validateDefinition(payload.definitions[0]);
if (problems.length) throw new Error(problems.join("; "));

// Generic metadatum map { 17 => payload }; serialize with any Cardano library.
const metadatum = encodeMetadata(payload);

// …later, after some library parses the CBOR back into a Metadatum:
const decoded = decodeMetadata(metadatum);
```

### CBOR (not included in the codec, by design)

The codec stops at the metadatum tree. If you need canonical CBOR bytes directly
(e.g. to hash a payload for dedup), two options:

- Use your existing Cardano library's metadatum serializer (it must emit
  RFC 8949 canonical maps — most do for integer keys in insertion order).
- Add a small dependency-free canonical encoder for this five-type subset. A
  lightweight general CBOR lib such as [`cborg`](https://github.com/rvagg/cborg)
  also works. Note: evolution-sdk does **not** use an external CBOR library; it
  hand-rolls its own, so there is nothing to "share".

## The domain layer (`cip-179/domain`)

Pure functions over the raw, decoded on-chain **record shapes** (`SurveyRecord`,
`ResponseRecord`, `CancellationRecord`, `TxProof`, `ChainTip`, `SurveyBundle`,
…). It implements the parts of CIP-179 that need chain data but not fetching:
latest-wins dedupe, owner-proven cancellation, mechanism-A/B credential proof,
response audit, answer rendering, and survey aggregation / lifecycle status.

How the records are _fetched_ is deliberately out of scope — that seam is
application-specific. The record shapes are the input contract, so a Koios scan,
a semantic indexer, or any other source can feed the same domain logic.

## The tally & artifact (`cip-179/tally`)

The count and stake-weighted tally rules, the JSON-safe wire codec
(`toJsonSafe` / `fromJsonSafe`: bytes→hex, bigint→decimal string, Map→tagged
pairs), the canonical-JSON (RFC 8785 / JCS subset) encoding, and the
content-addressed tally artifact.

The artifact is **content-addressed**: `RULESET_DESCRIPTOR` names the exact
rules applied (covered roles, per-role weight measures, dedup/window/proof
rules, sealed-reveal handling), and `rulesetHash()` is the blake2b-256 of its
canonical JSON. Two implementations that apply the same rules to the same chain
data produce byte-identical artifacts and the same hash.

### Interim spec status & compatibility

The artifact format is **not yet part of the CIP** — it is currently driven by
Tessera, pending specification and integration into CIP-179. Until then this
package is the normative description, and an emitted artifact is re-verified by
installing the `cip-179` version whose `rulesetHash` matches the artifact's
recorded hash:

| `cip-179` version | CIP-179 spec version | ruleset version | `rulesetHash()`                                                    |
| :---------------- | :------------------- | :-------------- | :----------------------------------------------------------------- |
| 0.1.0             | 4                    | 3               | `c5b2b4284db26af358ed084373cc0786b15e4f58bc27c4f82e769d16ba878eee` |
| 0.2.0             | 5                    | 4               | `9b5210228bbfdd525308698f9427368b1cf228b8f7e8ae931833d29f023e562e` |

When the rules change, the ruleset version and hash change; add a new row rather
than editing an existing one, so old artifacts stay re-verifiable against the
matching release.

## The txproof stack (`cip-179/txproof`)

`decodeTxProof(codec, txCborHex)` turns an already-fetched transaction's CBOR
into a `TxProof`: the mechanism-A evidence (required signers + witnessed native
scripts) and mechanism-B evidence (governance vote bindings) that a credential
proof is checked against. It imports no Cardano library — the transaction is
decoded to a neutral `DecodedTx` by the injected `TxProofCodec`, and this module
owns only the CIP-179 interpretation. The same port carries the bech32
`stakeAddress` / `drepId` id encoders. Inject `cip-179/evolution` or your own
codec (see the seam above).

## The tlock stack (`cip-179/tlock`)

The sealed-submission (`sealed_submission_mode`) stack: drand quicknet
round/time math, the timelock encrypt/decrypt client, response padding, the CBOR
envelope, and seal/reveal orchestration. Only drand **quicknet** is supported.
`sealAnswers` / `revealWithBeacon` / `revealResponses` take a `MetadatumCodec`
(the metadatum ↔ CBOR seam is injected, not imported). Requires
`@mattpiz/tlock-js` for the timelock crypto; inject `cip-179/evolution` or your
own codec for the CBOR.

## Development

```sh
pnpm install
pnpm type-check
pnpm test
pnpm build   # cleans + emits dist/ (.js + .d.ts + maps) for every subpath
```

In the workspace the package is consumed straight from `src` (the `exports`
map points at TypeScript source, like every sibling package), so cross-package
edits are live with no build step. `dist/` is only produced for publishing:
`publishConfig.exports` swaps the map to the compiled output at `pnpm publish`
time, and `prepublishOnly` rebuilds it from clean.

## Layout

| Path             | Subpath             | Purpose                                                               |
| :--------------- | :------------------ | :-------------------------------------------------------------------- |
| `src/*.ts`       | `cip-179`           | Codec: metadatum model, constants, types, encode/decode/validate.     |
| `src/domain/`    | `cip-179/domain`    | On-chain record shapes + pure domain semantics.                       |
| `src/tally/`     | `cip-179/tally`     | Reference ruleset, wire/canonical codecs, content-addressed artifact. |
| `src/txproof/`   | `cip-179/txproof`   | `TxProof` interpretation + the `TxProofCodec` port.                   |
| `src/tlock/`     | `cip-179/tlock`     | Sealed-submission (drand tlock) stack + the `MetadatumCodec` port.    |
| `src/evolution/` | `cip-179/evolution` | evolution-sdk adapter: `evolutionCodec` implementing both ports.      |
