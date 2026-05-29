# Minimal tlock example — status & plan

*Where we are with the de-risked `tlock-js` fork, and what's left to build a minimal Drand timelock example that proves out the cryptographic primitive used in [`commit-reveal-drand-voting-report.md`](./commit-reveal-drand-voting-report.md) §3 (`tlock` as the forced-reveal mechanism). No Cardano in this milestone — just encrypt-now, decrypt-after-round.*

---

## 1. Why a separate fork

The voting design needs `tlock` (Boneh–Franklin IBE over BLS12-381, indexed by Drand round) as its forced-reveal primitive. Drand publishes a reference TypeScript implementation, [`tlock-js`](https://github.com/drand/tlock-js), which is the natural starting point.

Pulling `tlock-js` straight from npm drags in a runtime dependency surface that's bigger than the cryptographic work warrants — most notably `drand-client@1.2.5`, which itself depends on `@babel/traverse` at runtime, plus `isomorphic-fetch` (→ `node-fetch`, `whatwg-fetch`) in the test toolchain. For a prototype whose whole value proposition is "trust the cryptography, not the operator", every transitive runtime dep is an unaudited surface we'd ship under the same trust label as the BLS code.

So we forked at `mpizenberg/tlock-js` and cut the fat.

## 2. What's done in the fork

Repo: <https://github.com/mpizenberg/tlock-js>
Branch: `master`
Pinned commit: `dffa9a3` — *"vendor minimal drand-client, drop isomorphic-fetch"*
Published as: `@mpizenberg/tlock-js@0.9.0-fork.1` (consumed via git URL; not on npm)

**Changes vs upstream `tlock-js@0.9.0`:**

- New `src/drand/drand-client.ts` (~365 lines) — self-contained port of the slice of `drand-client@1.2.x` that `tlock-js` actually uses: `ChainInfo` types, `HttpChain` / `HttpCachingChain` / `HttpChainClient`, `roundAt` / `roundTime`, `fetchBeacon`, and full beacon verification including BLS signature verification on G1 *and* G2 (covering `pedersen-bls-chained`, `pedersen-bls-unchained`, `bls-unchained-on-g1`, `bls-unchained-g1-rfc9380`). Uses native `fetch`, `@noble/curves`, `@noble/hashes`, `buffer`.
- All `drand-client` imports rewired to the local module (`src/index.ts`, `src/drand/defaults.ts`, `src/drand/timelock-encrypter.ts`, `src/drand/timelock-decrypter.ts`, plus tests).
- `isomorphic-fetch` import removed from `integration.test.ts` (Node ≥ 18 ships `fetch` globally).
- `package.json`: dropped `drand-client` and `isomorphic-fetch`; pinned every remaining version exactly (no `^`); bumped `engines.node` to `>= 18.0.0`; renamed package to `@mpizenberg/tlock-js` and bumped version to `0.9.0-fork.1`.

**Runtime dependency surface after the fork:**

| Runtime dep            | Before (`tlock-js@0.9.0`)            | After (`@mpizenberg/tlock-js@0.9.0-fork.1`) |
| ---                    | ---                                  | ---                                          |
| `@noble/curves`        | yes                                  | yes                                          |
| `@noble/hashes`        | yes                                  | yes                                          |
| `@stablelib/chacha20poly1305` | yes                           | yes                                          |
| `buffer`               | yes                                  | yes                                          |
| `drand-client`         | yes (→ `@babel/traverse` at runtime) | **gone**                                     |

`@babel/traverse` and `node-fetch` still appear in `npm ls`, but only as deep transitives of `ts-jest` / `jest-fetch-mock` — `dev: true` in the lockfile, never bundled into shipped code.

**Verification:**

- `npm run compile` clean.
- `npm run lint` clean.
- `npm test`: 62 / 65 pass. The 3 failing tests are *upstream-endpoint* failures, not regressions:
  - testnet `pl-us.testnet.drand.sh/.../info` → 403 (drand testnet endpoint deprecated)
  - fastnet chain hash `dbd506d6…` on `api.drand.sh` → 404 (fastnet retired by drand)

  They would fail identically with the original `drand-client` package; nothing in our port causes them. The **quicknet** end-to-end test passes, which exercises the full critical path of our replacement: `HttpCachingChain` → `HttpChainClient` → `fetchBeacon` → `verifyBeacon` → `verifySigOnG1` with the RFC-9380 DST, plus IBE encrypt/decrypt around it. That's the path the voting design depends on.

## 3. What's left — a minimal tlock example

This corresponds to **Phase 0** of the prototype roadmap in the voting report (§9): a self-contained off-chain script that demonstrates time-locked encryption against live Drand, with no Cardano involved. Its job is to prove the primitive end-to-end and pin down the parameters (curve, DST, round timing) before any chain integration starts.

### 3.1 Goal of the demo

A small Node script (or pair of scripts) that:

1. **Encrypt:** takes a fixed message ("ballot"), picks a near-future Drand round `R` (e.g. ~30 s ahead on `quicknet`), encrypts the message under `R` via `@mpizenberg/tlock-js`'s `timelockEncrypt`, and prints/persists the ciphertext.
2. **Wait & decrypt:** polls the Drand HTTP endpoint until round `R` is published, then decrypts the ciphertext via `timelockDecrypt` and asserts the recovered plaintext equals the original.

Optionally a **third-party verification** mode: a second script run by an "auditor" that takes only the ciphertext + the Drand chain URL and recovers the plaintext, demonstrating that decryption is a public function of `(ciphertext, σ_R)` with no input from the encryptor.

### 3.2 Concrete next steps

1. **Create a new repo** (or a sibling directory under `cardano-commit-reveal-votes/`) — e.g. `tlock-minimal-example/`. Sibling-directory is fine for a prototype; promote to its own repo only if it grows.
2. **Wire the fork as a git dependency** in `package.json`:

   ```json
   "dependencies": {
     "@mpizenberg/tlock-js": "github:mpizenberg/tlock-js#dffa9a3"
   }
   ```

   Pin to the commit SHA (or a tag if we tag `v0.9.0-fork.1`) rather than a branch — branch refs are mutable and undermine the supply-chain hardening.
3. **Pick the network.** Use Drand's `quicknet` (BLS12-381, signatures on G1, scheme `bls-unchained-g1-rfc9380`, 3 s period). That's the network the voting report targets (§7.1) and the one whose code path is exercised by the passing integration test in the fork. The chain URL and chain info are already exported from the fork as `MAINNET_CHAIN_URL` / `MAINNET_CHAIN_INFO` (and the convenience client `mainnetClient()` in `src/index.ts`).
4. **Encrypt script** (~20 lines):
   - Build a `mainnetClient()` (which is `HttpChainClient` over `HttpCachingChain` for quicknet).
   - Fetch chain info, compute `R = roundAt(Date.now() + Δ, info)` for some `Δ` (e.g. 30 000 ms).
   - `ciphertext = await timelockEncrypt(R, Buffer.from(message), client)`.
   - Print `R` and the armored ciphertext to stdout (or write to a file).
5. **Decrypt script** (~20 lines):
   - Read ciphertext + chain URL.
   - Build the same client.
   - Loop: `await fetchBeacon(client)` until the latest round ≥ `R` (sleeping one period between polls). The voting report (§7.3) flags beacon liveness as the one real external dependency; a `--max-wait` flag with a clear timeout error is the right ergonomics.
   - `plaintext = await timelockDecrypt(ciphertext, client)`; assert equals original.
6. **Smoke test it against live `quicknet`.** This is also where we sanity-check the round-timing math and DST handling under real conditions — the things the voting report (§7.1) calls out as "easy to get wrong, easy to unit-test".
7. **Audit-reproducibility check.** Run the decrypt script in a separate working directory / on a separate machine with only the ciphertext + chain URL as inputs. This is the demo that maps directly onto the voting design's claim that "the tally is a deterministic, independently reproducible function" (report §4.3, §10): if a third party with no shared state can recover the plaintext, the same property scales to a full election.

### 3.3 Out of scope for the minimal example

Keep the demo tight. The following all belong to later phases of the voting prototype (report §9, Phases 1–3), *not* to the minimal tlock example:

- Any Cardano validator, datum, or transaction logic.
- The Blake2b hash commitment half of the dual-commitment scheme (§6.5 of the report).
- Multi-round encryption / beacon-outage fallback (§7.3).
- Ballot encoding, aggregation rules, or tally output (§4.3, §5.4).
- Identity / Sybil-resistance integration (handled in a separate report).

The minimal example exists to confirm one thing: **encrypt now → decrypt after round `R` works, against live Drand, through our de-risked fork**. Everything else builds on that.

### 3.4 Definition of done

The minimal example is done when:

- The encrypt script produces a ciphertext bound to a future quicknet round, in ~one shot.
- The decrypt script, run after the round publishes, recovers the original plaintext byte-for-byte.
- A second, fully independent run of the decrypt script (different working directory, no shared local state with the encryptor) recovers the same plaintext from just the ciphertext and the public chain URL.
- The README documents which Drand network, round, and DST the demo targets, and the exact commit SHA of the fork it depends on.

At that point we have a verified, supply-chain-conscious tlock primitive ready to plug into Phase 1 (Aiken validator + on-chain commit datum) of the voting prototype.

## 4. Useful references

- Voting design this demo serves: [`commit-reveal-drand-voting-report.md`](./commit-reveal-drand-voting-report.md) §3 (tlock primitive), §7.1 (parameters), §9 Phase 0 (this demo's place in the roadmap).
- Fork: <https://github.com/mpizenberg/tlock-js> @ `dffa9a3`.
- Upstream `tlock-js`: <https://github.com/drand/tlock-js>.
- Drand: <https://drand.love> — quicknet `/info` and `/public/{round}` endpoints.
- `tlock` paper (Gailly, Melissaris & Romailler): <https://eprint.iacr.org/2023/189>.
