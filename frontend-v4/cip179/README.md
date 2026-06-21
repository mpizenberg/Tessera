# cip-179

A pure, side-effect-free TypeScript library for the
[CIP-179](../cip-179.md) *On-Chain Surveys and Polls* metadata format
(metadata label `17`, spec version 4).

It does three things, all without any I/O:

1. **Encode** ergonomic domain types into a generic Cardano *metadatum* tree.
2. **Decode** a metadatum tree back into domain types (total; throws
   `Cip179DecodeError` with a path on malformed input).
3. **Validate** the cross-field invariants the CDDL can't express (option
   bounds, abstain/required rules, points summing to budget, rating scales, …).

## Design

### Library-agnostic by construction

The library never depends on a specific Cardano library and never touches CBOR.
Its interchange type is a generic [`Metadatum`](./src/metadatum.ts), the
universal on-the-wire shape of `transaction_metadatum`:

```ts
type Metadatum =
  | bigint                              // int
  | string                             // text
  | Uint8Array                         // bytes
  | ReadonlyArray<Metadatum>           // array
  | ReadonlyMap<Metadatum, Metadatum>  // map
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

### What validation does *not* cover

`validateDefinition` / `validateResponse` are pure and check only what's
determinable from the data itself. Everything requiring ledger state is left to
an indexer with chain access: credential proofs (`required_signers` /
`voting_procedures`), role membership, epoch cutoffs, cancellation status,
latest-wins deduplication, and external-anchor fetch/hash verification.

## Usage

```ts
import {
  encodeMetadata,
  decodeMetadata,
  validateDefinition,
  Role,
  type Cip179Payload,
} from "cip-179"

const payload: Cip179Payload = {
  type: "definitions",
  definitions: [
    {
      specVersion: 4,
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
}

const problems = validateDefinition(payload.definitions[0])
if (problems.length) throw new Error(problems.join("; "))

// Generic metadatum map { 17 => payload }; serialize with any Cardano library.
const metadatum = encodeMetadata(payload)

// …later, after some library parses the CBOR back into a Metadatum:
const decoded = decodeMetadata(metadatum)
```

## CBOR (not included, by design)

The library stops at the metadatum tree. If you need canonical CBOR bytes
directly (e.g. to hash a payload for dedup), two options:

- Use your existing Cardano library's metadatum serializer (it must emit
  RFC 8949 canonical maps — most do for integer keys in insertion order).
- Add a small dependency-free canonical encoder for this five-type subset. A
  lightweight general CBOR lib such as [`cborg`](https://github.com/rvagg/cborg)
  also works. Note: evolution-sdk does **not** use an external CBOR library; it
  hand-rolls its own, so there is nothing to "share".

## Development

```sh
pnpm install
pnpm type-check
pnpm test
pnpm build
```

## Layout

| File | Purpose |
|:-----|:--------|
| `src/metadatum.ts` | Generic metadatum model + chunked text/bytes helpers |
| `src/constants.ts` | Label, spec version, tags, roles, method URNs |
| `src/types.ts` | Domain types |
| `src/encode.ts` | Domain → metadatum |
| `src/decode.ts` | Metadatum → domain |
| `src/validate.ts` | Pure semantic validation |
| `src/errors.ts` | `Cip179DecodeError` / `Cip179EncodeError` |
