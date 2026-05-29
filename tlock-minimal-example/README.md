# tlock minimal example

Encrypt-now / decrypt-after-round demo for Drand timelock encryption (`tlock`),
built on the de-risked [`@mpizenberg/tlock-js`](https://github.com/mpizenberg/tlock-js)
fork. This is Phase 0 of the [commit–reveal voting prototype](../commit-reveal-drand-voting-report.md):
prove the cryptographic primitive end-to-end against live Drand before any chain work.

It demonstrates one property: a message encrypted to a future Drand round `R`
becomes decryptable — by anyone, from only the ciphertext and the public chain
URL — once round `R` is published, and not before.

## Parameters

| | |
| --- | --- |
| Drand network | **quicknet** |
| Chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Chain URL | `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Curve / scheme | BLS12-381, signatures on G1 — `bls-unchained-g1-rfc9380` |
| Hash-to-curve DST | `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` (applied inside the fork) |
| Round period | 3 s |
| Fork commit | [`dffa9a3`](https://github.com/mpizenberg/tlock-js/commit/dffa9a3) (`@mpizenberg/tlock-js@0.9.0-fork.1`) |

The chain hash and public key are verified by the client on every `/info` fetch,
so a tampered endpoint is rejected. The target round `R` and chain hash are
embedded in the ciphertext's `age` `tlock` stanza — decryption needs no other
input from the encryptor.

## Setup

```sh
npm install
```

Requires Node ≥ 18 (uses the global `fetch`). The fork is pulled directly from
GitHub at the pinned commit and run as TypeScript via `tsx`; nothing is published
to npm.

## Usage

Encrypt a message to a round ~30 s in the future (writes `ballot.age`):

```sh
npm run encrypt -- "ballot: yes"
# or: MESSAGE="ballot: yes" DELAY_MS=30000 OUT=ballot.age npm run encrypt
```

Decrypt once the round publishes (waits for the beacon, then recovers plaintext):

```sh
npm run decrypt -- ballot.age
# bound the wait: MAX_WAIT=120 npm run decrypt -- ballot.age
```

| Variable | Script | Default | Meaning |
| --- | --- | --- | --- |
| `MESSAGE` / argv[2] | encrypt | `ballot` | plaintext to encrypt |
| `DELAY_MS` | encrypt | `30000` | how far ahead of now to target round `R` |
| `OUT` / argv[2] | both | `ballot.age` | ciphertext file path |
| `MAX_WAIT` | decrypt | `120` | seconds to wait for round `R` before erroring |

## Audit-reproducibility check

The decrypt script takes **only** the ciphertext file and the (hard-coded) chain
URL — it reads the target round from the ciphertext itself and shares no state
with the encryptor. To demonstrate, recover the plaintext from a fresh directory
holding nothing but the `.age` file:

```sh
mkdir /tmp/audit && cp ballot.age /tmp/audit/
npm run decrypt -- /tmp/audit/ballot.age
```

This is the property the voting design relies on: the reveal is a deterministic,
independently reproducible function of `(ciphertext, σ_R)`.

## What this is not

Out of scope here (later phases of the voting prototype): any Cardano validator
or transaction logic, the Blake2b hash-commitment half of the dual-commitment
scheme, multi-round / beacon-outage fallback, ballot encoding and tally rules,
and identity / Sybil resistance.
