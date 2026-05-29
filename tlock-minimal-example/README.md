# tlock minimal example

Encrypt-now / decrypt-after-round demo for Drand timelock encryption (`tlock`),
built on the de-risked [`@mpizenberg/tlock-js`](https://github.com/mpizenberg/tlock-js)
fork. This is Phase 0 of the [commit–reveal voting prototype](../commit-reveal-drand-voting-report.md):
prove the cryptographic primitive end-to-end against live Drand before any chain work.

It demonstrates one property: a message encrypted to a future Drand round `R`
becomes decryptable — by anyone, from only the ciphertext and the public chain
URL — once round `R` is published, and not before.

## Parameters

|                   |                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Drand network     | **quicknet**                                                                                             |
| Chain hash        | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`                                       |
| Chain URL         | `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`                  |
| Curve / scheme    | BLS12-381, signatures on G1 — `bls-unchained-g1-rfc9380`                                                 |
| Hash-to-curve DST | `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` (applied inside the fork)                                  |
| Round period      | 3 s                                                                                                      |
| Fork commit       | [`dffa9a3`](https://github.com/mpizenberg/tlock-js/commit/dffa9a3) (`@mpizenberg/tlock-js@0.9.0-fork.1`) |

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

| Variable            | Script  | Default      | Meaning                                       |
| ------------------- | ------- | ------------ | --------------------------------------------- |
| `MESSAGE` / argv[2] | encrypt | `ballot`     | plaintext to encrypt                          |
| `DELAY_MS`          | encrypt | `30000`      | how far ahead of now to target round `R`      |
| `OUT` / argv[2]     | both    | `ballot.age` | ciphertext file path                          |
| `MAX_WAIT`          | decrypt | `120`        | seconds to wait for round `R` before erroring |

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

## How Drand timelock works (background)

Notes from working through the trust model, for non-experts.

### Drand and quicknet

Drand is a network of independent servers that jointly emit a new random value
(a **beacon**) on a fixed schedule, forever. Each beacon belongs to a sequential
**round**, and the beacon _is_ a BLS signature over its round number. Drand runs
several chains with different parameters at once; **quicknet** is the one we
target: BLS12-381 with signatures on **G1**, scheme `bls-unchained-g1-rfc9380`,
a **3 s** period, and "unchained" (each beacon signs only its round number, not
the previous beacon — which is what makes encrypting to a _future_ round possible
without the intervening beacons).

The **chain hash** (`52db9ba7…`) is a fingerprint of that chain's genesis config.
It serves two roles: it identifies _which_ chain in the URL (`/{hash}/info`,
`/{hash}/public/{round}`), and it is a **trust anchor** — the client checks that
the config returned by `/info` hashes to exactly this value and that the public
key matches, so you trust the hash, not the server.

### Round numbers ↔ wall-clock time

A chain is a metronome defined by `genesis_time` (round 1's timestamp) and
`period`. The mapping is pure arithmetic:

```
roundAt(t)   = floor((t − genesis_time) / period) + 1
roundTime(R) = genesis_time + (R − 1) · period
```

`encrypt.ts` picks `R = roundAt(now + DELAY_MS)`; `decrypt.ts` uses `roundTime(R)`
to know when to start waiting. This is independent of Cardano's slot clock — the
deadline is wall-clock, and the full voting design maps between the two timelines.

### Why a beacon is the decryption key

`tlock` is **Identity-Based Encryption** (Boneh–Franklin) where the "identity"
you encrypt to is the round number `R`:

- The chain's public key is the IBE **master public key** — you can encrypt to any
  round `R` using only it, even before `R`'s key exists. No per-recipient setup.
- The IBE **private key** for identity `R` is the master secret applied to `R` —
  and BLS-signing `R` produces the _same value_. So the beacon `σ_R` is **exactly**
  the decryption key for round `R`.
- A **pairing** `e(·,·)` on BLS12-381 is the glue: encryption hides the message
  behind `e(H(R), masterPub)^r`; the holder of `σ_R` recomputes that mask via
  `e(σ_R, U)` (the `U` shipped in the ciphertext). Both sides equal the same value
  without encryptor and decryptor ever sharing a secret.

Consequence: before round `R`, `σ_R` doesn't exist, so **nobody** (not even the
encryptor) can decrypt; once Drand publishes `σ_R`, decryption is a **public
function of `(ciphertext, σ_R)`** that anyone can run — exactly what the
audit-reproducibility check above demonstrates.

### Can the operators decrypt early?

The beacon is **deterministic** (`σ_R = s · H(R)`, no per-round randomness), so
every future beacon is _predetermined_ today. What prevents early decryption is
not unknowability but that computing `σ_R` requires cooperation:

- The master secret `s` is never held in one place. It is split across nodes by a
  **Distributed Key Generation**; each node holds only a share `s_i`.
- Producing `σ_R` requires a **threshold** of nodes to combine partial signatures.
  Drand uses a strict-majority threshold, `t = ⌊n/2⌋ + 1`. One node, or any
  sub-threshold group, learns nothing about `σ_R`.

So `tlock`'s timelock is a **threshold-honesty assumption**, not an unconditional
cryptographic lock: a colluding **majority** of operators _could_ compute any
future beacon early (nothing in the math forces them to wait for the scheduled
time). The guarantee is that fewer than a majority cannot.

### Who the operators are

Drand mainnet (including quicknet) is run by the **League of Entropy**, a public,
_named_ consortium — roughly 17 organizations spread across jurisdictions and
sectors: Cloudflare, Ethereum Foundation, Protocol Labs, Kudelski Security, EPFL,
University of Chile, ChainSafe, UCL, Emerald Onion, and others (membership grows
over time — see <https://drand.love>). This is the substance behind the trust
assumption: breaking the timelock early means secretly coordinating a _majority_
of these named institutions, not compromising one anonymous key.

> **Exact `n` and `t`:** the precise node count and threshold live in quicknet's
> _group file_ (read via the `drand` CLI), **not** in the HTTP `/info` endpoint
> this demo uses (which exposes only public key, period, genesis, hashes, scheme).
> The rule — a strict majority of the group's nodes — holds regardless; note that
> the node count `n` is not necessarily the same as the count of member orgs.

## What this is not

Out of scope here (later phases of the voting prototype): any Cardano validator
or transaction logic, the Blake2b hash-commitment half of the dual-commitment
scheme, multi-round / beacon-outage fallback, ballot encoding and tally rules,
and identity / Sybil resistance.
