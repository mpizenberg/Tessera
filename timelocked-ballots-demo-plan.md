# Timelocked ballots for the CIP-179 demo — implementation plan

*Adds delayed-reveal ("timelocked") ballots to the minimal CIP-179 example using Drand `tlock` (quicknet). Ballots are encrypted at submission time and become decryptable by anyone once a chosen Drand round publishes. This is **delayed reveal, not secrecy**: contents are hidden only until round `R`.*

Companion design rationale: `commit-reveal-drand-voting-report.md`. This document is the concrete build plan for the `minimal/` example.

---

## 1. Scope

**In scope**
- A new `timelocked` ballot mode for CIP-179 surveys, alongside the existing public mode.
- Off-chain Drand `tlock` encryption/decryption wired into the Elm app via `elm-concurrent-task`.
- Survey-definition fields that pin the decryption parameters once, so individual responses don't repeat them.
- Display of timelocked responses: locked before round `R`, decrypted on view after `R`, grouped by survey.

**Out of scope (unchanged from the current example, or deferred)**
- **No tally.** We display responses, as today. Aggregation is not implemented.
- **No admission logic / no validator.** Eligibility and one-vote-per-voter are not enforced on-chain. The convention remains **latest-valid-response-wins** per `(survey_ref, role, credential)`, applied off-chain at read time.
- **No hash-commit fallback / dual commitment.** Pure `tlock` only. The Blake2b outage-recovery anchor from the report is deferred (see §10).
- **Role + credential stay in the public payload** for this MVP (only the answers are timelocked).
- Identity/Sybil resistance and coercion resistance — explicitly delegated elsewhere (see report §1).

---

## 2. Locked design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Mode is named **`timelocked`** (UI: "delayed reveal / revealable after round R"). Not "secret". | Avoid implying permanent confidentiality; it is a time-delayed reveal. |
| 2 | Store **raw IBE bytes** `U‖V‖W`, **not** the age envelope. | Compact; decryption parameters come from the survey definition. See §5.1 for the documented tradeoff. |
| 3 | Survey definition pins **ballot mode, Drand chain hash, target round `R`, and `padding_size`**. | Responses carry none of this; one source of truth per survey. |
| 4 | **Pad the CBOR-encoded answers with zero bytes up to `padding_size`** before encrypting. | Fixes ciphertext length so it does not leak ballot content size. CBOR is self-delimiting, so trailing zeros are ignored on decrypt. |
| 5 | **Hardcode** quicknet's Drand parameters in the JS bundle (and document them). | They are long-lived network constants; avoids a network round-trip just to compute `R`. |
| 6 | Survey creation takes a **deadline (minute precision)** and derives `R` client-side from the hardcoded params. | Simple UX; no live `/info` fetch needed. |
| 7 | Bundle `tlock-js` **once** with esbuild and commit `static/tlock.js`. No esbuild dependency inside `minimal/`. | Matches how `elm-cardano.js` / `elm-concurrent-task.js` were produced. |

---

## 3. Cryptographic scheme (raw IBE on quicknet)

Quicknet is `bls-unchained-g1-rfc9380`: BLS12-381 with **signatures on G1**, **public key on G2**.

- **Encrypt** (local, no network): IBE-encrypt the padded ballot directly with `encryptOnG2RFC9380(masterPublicKey, ID, msg)`, where `ID = SHA256(round_be64)` is the round identity. Output ciphertext is `(U, V, W)`:
  - `U` = `r · G2`, the ephemeral element, **96 bytes** compressed.
  - `V`, `W` = XOR masks, each **`len(msg)` bytes** = `padding_size` bytes.
  - Serialized ciphertext = `U ‖ V ‖ W` = `96 + 2·padding_size` bytes.
- **Decrypt** (needs network): fetch the round signature `σ_R` (a G1 point, 48 bytes) from Drand, then `decryptOnG2(σ_R, {U, V, W})`. `σ_R` is exactly the IBE trapdoor for identity `H(round)`.

Hardcoded quicknet constants (to live in `tlock.js`, documented in a header comment):

```
chainHash  = 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
publicKey  = 83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a
genesisTime = 1692803367   (unix seconds)
period      = 3            (seconds)
scheme      = bls-unchained-g1-rfc9380
DST         = BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_
beaconURL   = https://api.drand.sh/<chainHash>/public/<round>
```

**Round mapping** (computed in Elm from the hardcoded `genesisTime`/`period`):

```
R = floor((deadline_unix − genesisTime) / period) + 1
```

(The `+1` matches `tlock-js` `roundAt`.) Reveal happens at real wall-clock time `genesisTime + (R−1)·period`, independent of the Cardano network. For the demo, pick a deadline a few minutes out.

---

## 4. Data model changes (`Survey.elm`)

### 4.1 Survey definition

Add a ballot-mode group. Public surveys are unchanged on the wire; timelocked surveys carry the extra config.

```
ballot_mode = public        ; existing behaviour, plaintext answers
            / timelocked     ; answers are raw-IBE ciphertext

timelock_config = [
    chain_hash   : bytes,    ; quicknet chain hash (pinned)
    round        : uint,     ; target Drand round R
    padding_size : uint,     ; min plaintext size (bytes) before encryption
]
```

Encode/decode in `toMetadatum` / `fromMetadatum` / `decodeDefinition`. Bump `specVersion` for timelocked definitions.

### 4.2 Response answers

- **Public response**: unchanged — `[+ answer_item]`.
- **Timelocked response**: the `answers` field becomes a single byte blob `U‖V‖W`, stored as a **list of ≤64-byte byte chunks** (reuse the chunking helper at `Survey.elm:278-325`). The rest of the response tuple — `survey_ref`, `role`, `credential` — stays public and identical to today.

The decoder picks the shape from the referenced survey's ballot mode; if the survey is unknown, the blob stays opaque.

### 4.3 Plaintext / padding format

```
plaintext = cbor(answers) ‖ zero_pad_to(padding_size)
```

- Encode the answers array with `elm-toulouse/cbor`, then right-pad with `0x00` to reach `padding_size`. If the CBOR already exceeds `padding_size`, no truncation — larger ciphertexts are permitted (they self-identify as oversized by their length).
- On decrypt: CBOR-decode **one** item and ignore trailing bytes. (Impl note: ensure the decoder consumes a single item and tolerates trailing zeros.)

---

## 5. Architecture

### 5.1 JS bundle `static/tlock.js` (the documented tradeoff)

A thin wrapper around the `@mpizenberg/tlock-js` fork, exposing two functions, registered as concurrent tasks. **Because we store raw IBE bytes (decision 2), we bypass the library's high-level `timelockEncrypt`/`timelockDecrypt` (which produce/consume the age envelope) and call the low-level IBE directly.** Consequence to document in the file header:

> This wrapper reimplements the round-identity hashing (`SHA256` of the 64-bit big-endian round) and uses the quicknet DST verbatim from the fork's source, so they cannot drift from the library. The age layer (ChaCha20 file-key wrapping + armor) is intentionally dropped: round and chain hash are not embedded in the stored ciphertext and **must** be supplied from the survey definition at decrypt time. Trade-off accepted for compactness; the higher-level age API would be lower-risk but larger and redundant with the survey definition.

Task surface (args/results as hex strings over the concurrent-task JSON channel):

```
tlock:encrypt { round, plaintextHex }            -> { ciphertextHex }   // U‖V‖W, local only
tlock:decrypt { round, ciphertextHex }           -> { plaintextHex }    // fetches σ_R, verifies, IBE-decrypts
```

`tlock:decrypt` fetches `σ_R` from `beaconURL`, verifies it against the hardcoded public key, then runs `decryptOnG2`.

### 5.2 Wiring (`index.html`)

Register alongside the existing `storage:*` tasks (`index.html:300-309`):

```js
import * as Tlock from "/tlock.js";
ConcurrentTask.register({
  tasks: {
    "storage:read":  async (a) => await Storage.read(a),
    "storage:write": async (a) => await Storage.write(a),
    "tlock:encrypt": async (a) => await Tlock.encrypt(a),
    "tlock:decrypt": async (a) => await Tlock.decrypt(a),
  },
  ports: { send: app.ports.sendTask, receive: app.ports.receiveTask },
});
```

### 5.3 Elm side

- **`Survey.elm`**: new types (`BallotMode`, `TimelockConfig`); encode/decode for definition + timelocked response; CBOR-encode-and-pad helper; `roundForDeadline` (pure arithmetic from hardcoded constants).
- **`Main.elm`**: the existing `ConcurrentTask.Pool` (`Main.elm:95`), `onProgress` (`Main.elm:559`), and `sendTask`/`receiveTask` ports already exist — reuse them.
  - **Create**: when mode = timelocked, take a deadline → compute `R` → store `timelock_config` in the definition.
  - **Respond**: build answers → CBOR + pad → `ConcurrentTask` `tlock:encrypt` → embed `U‖V‖W` chunks in the response metadatum → build/submit tx as today.
  - **Display**: group responses by survey ID. For a timelocked response, if `now < reveal_time(R)` show "locked until \<time\>"; otherwise `tlock:decrypt` on view (using `R` from the survey def) → CBOR-decode → render answers. Responses to unknown surveys remain opaque.

---

## 6. Lifecycle

```
   CREATE (owner)                 RESPOND (voter)                 VIEW (anyone)
 ┌──────────────────────┐    ┌────────────────────────┐    ┌───────────────────────────┐
 │ pick deadline        │    │ fill answers           │    │ group responses by survey │
 │ R = round(deadline)  │    │ p = cbor(ans)+pad      │    │ if now < revealTime(R):   │
 │ store mode+chainHash │    │ ct = tlock:encrypt(R,p)│    │    show "locked until …"  │
 │ +R+padding in def    │    │ store U‖V‖W chunks     │    │ else:                     │
 └──────────────────────┘    └────────────────────────┘    │  pt = tlock:decrypt(R,ct) │
                                                           │  answers = cborDecode(pt) │
                                                           └───────────────────────────┘
```

---

## 7. Off-chain validity / discard rule (documented, read-time only)

A timelocked response counts (under latest-valid-response-wins) iff:
1. it references a known timelocked survey;
2. its ciphertext blob length is `≥ 96 + 2·padding_size` and parses as `U‖V‖W`;
3. it decrypts under `σ_R` for the survey's `R`; and
4. the decrypted CBOR is a valid answer set for the survey's questions (trailing padding ignored).

Anything else is shown as discarded with a reason. There is no on-chain enforcement; the read-time rule is the only authority.

---

## 8. Build process

1. In `tlock-minimal-example/` (already has the fork in `node_modules`), add a small wrapper entry module exporting `encrypt`/`decrypt` per §5.1.
2. Bundle once: `esbuild --bundle --platform=neutral --format=esm <wrapper> --outfile=tlock.js`.
3. Copy the output to `minimal/static/tlock.js` with a documented header comment (constants + the raw-IBE tradeoff note).
4. `minimal/` build is unchanged: `elm-cardano make src/Main.elm --output=static/main.js`.

Risk to verify first (highest-risk step): browser compatibility of the fork (noble curves are fine; watch for any `Buffer` usage — shim or use the fork's exported `Buffer`). Validate an encrypt→decrypt round-trip against live quicknet with a near-future round before touching Elm.

---

## 9. Implementation steps (sequenced)

1. **`tlock.js` bundle + round-trip test.** Wrapper, esbuild bundle, prove encrypt/decrypt against live quicknet. *(De-risks the crypto + browser path before any Elm work.)*
2. **Concurrent-task wiring.** Register `tlock:encrypt`/`tlock:decrypt` in `index.html`; add the Elm `ConcurrentTask.define` calls and a trivial round-trip behind a dev button.
3. **Definition model.** `BallotMode` + `TimelockConfig`, encode/decode, `specVersion` bump, creation UI (deadline → `R`).
4. **Response encoding.** CBOR+pad helper; encrypt-then-embed in the response metadatum; submit tx.
5. **Display.** Group by survey; locked-vs-revealed states; decrypt-on-view; opaque for unknown surveys.
6. **Docs.** Fold the raw-IBE decision, hardcoded constants, and discard rule into `minimal/README.md`.

---

## 10. Deferred / future hardening

- **Beacon-outage fallback (hash commit).** Quicknet mainnet has no recorded outages and Drand's catch-up backfills delayed rounds, so a stall delays reveal rather than losing it. The dual-commitment Blake2b anchor (report §6.5, §7.3) is therefore deferred; add it only if an election has a hard *publish-by* deadline.
- **Role/credential privacy.** Currently public; timelocking them too would need a larger redesign.
- **Multi-round encryption.** Not needed given catch-up; deferred.
- **On-chain result anchoring and a real tally.** Out of scope for this demo.
```
