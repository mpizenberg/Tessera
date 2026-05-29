# Commit–reveal voting on Cardano with Drand timelock and off-chain reveal

*A preliminary research and design report for a prototype: how to run a publicly-auditable election on Cardano where ballots are committed during the voting window and forcibly revealed afterwards via Drand timelock encryption, with the tally computed off-chain.*

---

## Executive summary

When ballots are visible during the voting period — the default for anything posted on a public chain — the aggregation rule is no longer the main threat. **Bandwagon effects, last-mover advantage, and live strategic coordination** dominate, and none of them are fixable by choosing a better tallying method. The classic remedy is **commit–reveal**: voters publish a binding commitment to their ballot during the voting window, and the plaintext ballots are revealed only after the window closes.

Plain commit–reveal has one structural weakness: **selective non-reveal**. A voter who can choose whether to reveal can wait, observe how other reveals are trending, and withhold their ballot if it no longer helps them — reintroducing the very last-mover advantage commit–reveal was meant to remove. The fix is **forced reveal**: make disclosure independent of voter action.

This report develops the design that the parent research note (`research-single-winner-voting-methods.md`, §6.5–§6.6) identifies as the cleanest forced-reveal mechanism available on Cardano today: **Drand timelock encryption (`tlock`) with an off-chain tally**. The key findings:

- **Forced reveal comes from cryptography, not from the validator.** Once Drand's "League of Entropy" publishes the round signature for a target round `R`, every ciphertext encrypted to `R` is decryptable by anyone — auditors included. The voter has no decision to make at reveal time.
- **The on-chain validator's only job is admission control**: ensure each eligible voter submits exactly one well-formed ciphertext during the commit window. It performs no decryption and no tally.
- **The tally is off-chain and publicly reproducible.** After round `R`, any party downloads the on-chain ciphertexts, decrypts them with the published Drand signature, and runs the aggregation rule. Anyone can independently verify the result.
- **A hard Aiken/Plutus limitation shapes the design.** Plutus exposes the BLS12-381 pairing only as an *equality oracle* (`final_verify`), not as a value you can read. IBE decryption needs the GT pairing *element* as a KDF input, which Plutus cannot return. Therefore a validator **cannot** verify on-chain that a given plaintext is the honest tlock decryption of its datum. For an off-chain-tally election this does not matter — but it rules out on-chain decryption verification entirely.
- **Recommended pattern: dual commitment with the tlock as the single source of truth.** Store both a cheap Blake2b hash commitment and a tlock ciphertext of the same `(ballot, salt)`. The **tlock decryption is the canonical ballot and is computed for *every* voter** — an on-chain reveal never substitutes a different value. This is essential: if the tallier only decrypted the tlock for silent voters, a malicious voter could commit ballot A under the hash and a different ballot B under the tlock, then choose which one counts after observing how reveals trend — an **equivocation attack** that resurrects the last-mover advantage (see §6.5 and §8.1). The hash's role is reduced to a beacon-outage recovery anchor, not an authoritative override.

The result is a system that preserves **end-state public auditability** while eliminating bandwagon and last-mover dynamics — without requiring a trustee committee. It does **not** by itself solve coercion or vote-buying (those need ballot secrecy or coercion-resistant cryptography, and identity/Sybil resistance is assumed handled at a separate layer).

---

## 1. Goal and scope

**Goal.** Document, at a depth sufficient to build a prototype, how to run an election on Cardano in which:

1. Ballots are *committed* on-chain during a voting window so that no one can read them while voting is open.
2. Ballots are *forcibly revealed* after the window closes, with disclosure independent of any individual voter's choice.
3. The tally is computed *off-chain* and is *publicly reproducible* by any auditor.

**In scope.**

- The commit–reveal lifecycle and phase timeline.
- Drand `tlock` as the forced-reveal primitive: what it is, which beacon/curve to target, and the parameters that must line up.
- The on-chain / off-chain responsibility split, and concrete datum/redeemer shapes.
- The Aiken/Plutus feasibility boundary for BLS12-381, and what it permits and forbids.
- Threats specific to commit–reveal (selective non-reveal, griefing, beacon outage) and their mitigations.
- A prototype scope and open questions.

**Out of scope** (assumed solved at other layers, per the parent note's threat model):

- **Identity / Sybil resistance.** One ballot per eligible voter, no double-voting. Handled by an enrollment/credential layer (see `sybil-resistant-voting-cardano-report.md`).
- **Coercion and vote-buying.** Commit–reveal hides ballots *during* voting but reveals them *after*. If reveals are linkable to identity, coercion is not solved — that needs ballot secrecy or coercion-resistant cryptography. This report treats the election context as one where transparent end-state ballots are acceptable (e.g. small high-trust groups, internal org governance, transparency-prioritised participatory budgeting).
- **The choice of aggregation rule.** Any single-winner rule (STAR, Schulze, Ranked Pairs, Approval, …) can sit on top; the parent note covers that. Commit–reveal is rule-agnostic.

---

## 2. The problem: why forced reveal

### 2.1 Public ballots break the secret-ballot assumptions

A naïve on-chain vote publishes each ballot as it is cast. That reintroduces attacks the secret ballot was invented to defeat (parent note §6.1):

1. **Coercion / vote-buying become enforceable** — a third party can verify compliance. (Not solved by commit–reveal alone; out of scope here.)
2. **Bandwagon / cascade effects** — visible running totals sway later voters.
3. **Last-mover advantage** — late voters have strictly more information than early ones.
4. **Chilling effects** — voters self-censor under social pressure.
5. **Perfect-information strategic voting** — strategy stops being a guess and becomes a solvable game.

Commit–reveal directly addresses **2, 3, and 5** (and reduces 4): if no one can read any ballot until the window closes, there is no running total to chase and no informational edge for late voters.

### 2.2 The residual hole: selective non-reveal

Plain commit–reveal still lets a voter *choose whether to reveal*. After the window closes, a strategic voter can watch other reveals land and then decide to withhold their own — recreating last-mover advantage at the reveal stage. **Forced reveal** closes this hole by making disclosure a function of *time*, not of voter action.

### 2.3 Forced-reveal mechanisms, ranked

From the parent note §6.5, ordered by strength:

| Mechanism | Strength | How it works | Trade-off |
| --- | --- | --- | --- |
| **Bond / slashing** | Weak | Collateral locked at commit is forfeited on non-reveal. | Discourages but does not prevent — a motivated voter pays the bond. |
| **Default-ballot via relayer** | Medium | After the window, anyone can submit a tx defaulting an unrevealed commit to a null ballot, paid a bounty from the forfeited bond. | Removes most last-mover advantage; voter still chooses between "my vote" and "the default". |
| **Threshold encryption (trustee committee)** | Strong | Ballots encrypted to a *t*-of-*n* key held by trustees; after the window trustees publish decryption shares. | Voter cannot withhold. Needs an honest threshold of trustees and off-chain coordination; raises a governance question about trustee selection. |
| **Drand timelock (`tlock`)** | Strongest | Ballots encrypted under a Drand public key whose decryption material is broadcast at a future round. Decryption is a function of time; no trustee committee beyond Drand. | External dependency on Drand beacon availability; confidentiality before round `R` rests on the Drand threshold. |

This report develops the **`tlock`** option as the primary mechanism, with **classic hash commit–reveal retained as a recoverable fallback** for beacon outages.

---

## 3. The primitive: Drand timelock encryption (`tlock`)

### 3.1 What Drand provides

[Drand](https://drand.love) is a distributed randomness beacon run by the "League of Entropy" (LoE). On its `quicknet` network it produces a fresh threshold BLS signature every **3 seconds**, indexed by an incrementing **round number**. The round signature `σ_R` for round `R` is unpredictable before `R` and public afterwards. Round timing is wall-clock-based:

```
R = floor((deadline_unix − genesis_unix) / period_seconds)     # period = 3s for quicknet
```

### 3.2 What `tlock` is

`tlock` ([Gailly, Melissaris & Yolan Romailler, "tlock: Practical Timelock Encryption from Threshold BLS"](https://eprint.iacr.org/2023/189)) is **Boneh–Franklin Identity-Based Encryption (BF-IBE)** instantiated on BLS12-381, where the *identity* is the Drand round number. You encrypt a message to round `R` today; no one can decrypt until the LoE publishes `σ_R`; after that, anyone can.

Decryption with the round signature `σ_R` has the shape:

```
M = V ⊕ H'( e(σ_R, U) )
```

where `e(·,·)` is the BLS12-381 pairing, `U` is part of the ciphertext, and `H'` is a KDF applied to the **GT field element** `e(σ_R, U)`. Note carefully: the KDF input is the *value* of the pairing, not an equation between pairings. This single fact drives the on-chain feasibility analysis in §6.

### 3.3 Why `tlock` is the right forced-reveal primitive here

- **No reveal-time choice for the voter.** Decryption depends only on the clock reaching round `R`. Selective non-reveal is impossible — the §2.2 hole is closed cryptographically.
- **No trustee committee to select or govern.** The only trust assumption is the Drand LoE threshold (see §3.4), which already exists and is operated independently of the election.
- **Public, reproducible decryption.** After `σ_R` is published, every auditor can decrypt every ciphertext and re-run the tally.

### 3.4 Trust and liveness assumptions

- **Confidentiality before `R`** rests on the LoE threshold (currently ~9 nodes, threshold 6). Early collusion of a threshold of nodes implies early decryption. This must be disclosed to voters; it is a real assumption, not "cryptographically unconditional".
- **Liveness.** If the LoE fails to publish `σ_R`, ciphertexts for round `R` cannot be decrypted and that path of the election cannot be tallied. Mitigations in §7.3.

---

## 4. Architecture

### 4.1 The on-chain / off-chain split

The defining design choice: **the chain does admission control; everything cryptographic about decryption and tallying happens off-chain.**

```
                COMMIT WINDOW                         AFTER ROUND R
   ┌───────────────────────────────┐      ┌──────────────────────────────────┐
   │ Voter builds ballot B          │      │ Drand publishes σ_R               │
   │   c = tlock_encrypt(B‖salt, R) │      │                                   │
   │   h = blake2b(B‖salt)          │      │ Off-chain tallier / any auditor:  │
   │ Submits tx: datum = {h, c, id} │      │  1. read all commit UTxOs         │
   │                                │      │  2. decrypt EVERY c: B=tlock(c,σ_R)│
   │ Validator checks:              │      │  3. check blake2b(B)==h (canonical)│
   │  • eligible & unused credential│      │  4. cross-check any on-chain reveal│
   │  • exactly one ciphertext      │      │  5. run aggregation rule          │
   │  • c well-formed (on curve)    │      │  6. publish result + proof trail  │
   │  • within commit window        │      │                                   │
   └───────────────────────────────┘      └──────────────────────────────────┘
        (on-chain reveal is an optional convenience, never authoritative)
```

### 4.2 On-chain validator responsibilities

The validator is small and does **no BLS pairing work**. Its checks:

1. **Eligibility / one-vote.** The submitting credential is in the eligible set and has not already committed. (Mechanism inherited from the identity layer — e.g. a state token, a Merkle membership proof, or a spent-once enrollment UTxO. Out of scope to design here, but the datum must carry whatever the chosen scheme needs.)
2. **Exactly one ciphertext per voter.** Enforced structurally by the UTxO/credential model.
3. **Commit-window timing.** The transaction's validity interval must lie within the open commit window (Cardano slot bounds).
4. **Ciphertext well-formedness.** Call `uncompress` on the ciphertext's group-element components. `uncompress` performs subgroup membership checks, making on-curve membership a cheap precondition of acceptance. This blocks one class of griefing (§7.2). *Semantic* validity of the plaintext ballot is **not** checkable on-chain and is policed off-chain by the tally rule.
5. **(Optional) On-chain reveal verification.** If a voter reveals `(B, salt)` on-chain after the deadline, the validator recomputes `blake2b(B‖salt)` and checks it equals the stored `h`. This is the only "reveal" the validator ever validates — a cheap hash, no BLS. **Note:** this on-chain reveal is *not* authoritative for the tally. It is a convenience/availability anchor; the canonical ballot is always the tlock decryption (§4.3, §6.5). Letting the on-chain reveal override the tlock would enable the equivocation attack of §8.1.

The validator **never**: decrypts a tlock ciphertext, verifies a decryption, or computes a tally.

### 4.3 Off-chain tallier / auditor responsibilities

After round `R`:

1. Fetch `σ_R` from a Drand endpoint (or any mirror; it is public and identical everywhere).
2. Read every commit UTxO (via an indexer — Blockfrost, Ogmios/Kupo, etc.).
3. **For every ballot — not just silent voters' — decrypt the tlock ciphertext** and treat the decryption as canonical:
   - Compute `B ‖ salt = tlock_decrypt(c, σ_R)`.
   - Verify well-formedness: `blake2b(B‖salt) == h` (the on-chain hash commitment) **and** `B` is a semantically valid ballot for the rule. If either check fails, the commit was malformed/equivocated and the ballot is discarded per a published rule.
   - If the voter *also* revealed `(B', salt')` on-chain, it is only an integrity cross-check: it must match the decryption (`B' == B`). A mismatch is logged but does **not** let `B'` count — the tlock value `B` is authoritative regardless. This is what defeats the equivocation attack (§8.1): the voter has exactly one canonical ballot, fixed at commit time, and cannot select between two after observing trends.
4. Run the chosen aggregation rule over the recovered (decrypted) ballots.
5. Publish the result together with the full input set (ciphertexts, `σ_R`, decryptions, any discards with reasons) so any third party can reproduce it byte-for-byte.

Because both `σ_R` and the on-chain ciphertexts are public, **the tally is a deterministic, independently reproducible function** — the off-chain tallier is not trusted, merely first. Decrypting *every* ciphertext (rather than only silent voters') is O(n) cheap off-chain work and is what makes the tlock the single source of truth.

---

## 5. Data structures (prototype shapes)

These are illustrative Aiken-flavoured sketches for the prototype, not final wire formats.

### 5.1 Commit datum

```aiken
type CommitDatum {
  voter_id: VerificationKeyHash,   // or whatever the identity layer yields
  hash_commit: ByteArray,          // blake2b_256(ballot ‖ salt), 32 bytes
  tlock_ct: TlockCiphertext,       // serialized tlock ciphertext (see 5.3)
  round: Int,                      // target Drand round R (binds ct to a time)
  revealed: Option<Ballot>,        // optional on-chain reveal; cross-checked, not authoritative
}
```

### 5.2 Redeemers

```aiken
type CommitRedeemer {
  Reveal { ballot: Ballot, salt: ByteArray }   // optional on-chain reveal, after deadline
  // (Admission is enforced at commit-tx construction; spending the commit
  //  UTxO to reveal is the main post-window action a voter takes.)
}
```

### 5.3 Tlock ciphertext encoding

A BF-IBE / `tlock` ciphertext over BLS12-381 consists of `(U, V, W)` where `U` is a G2 element and `V, W` are byte strings (the masked message and a check value). Drand publishes group elements **compressed**: 48 bytes for G1, 96 bytes for G2. The whole ciphertext for a small ballot is comfortably **~150–250 bytes**, well within Cardano datum/transaction limits.

### 5.4 Ballot encoding

The ballot `B` is whatever the aggregation rule needs — e.g. a STAR score vector (7 candidates × 0–5 → 7 bytes), an approval bitset, or a ranking permutation. Keep it small and fixed-width so the ciphertext stays compact and decryption/validation are unambiguous. `salt` is a fresh random nonce (e.g. 16–32 bytes) so identical ballots produce distinct commitments.

---

## 6. Aiken / Plutus feasibility for BLS12-381

This is the crux that determines what the validator *can* and *cannot* do.

### 6.1 Available primitives

Plutus V3 ([CIP-0381](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0381)) exposes BLS12-381 builtins surfaced by Aiken via `aiken/crypto/bls12_381`:

- **G1 / G2**: `add`, `scalar_mul`, `neg`, `equal`, `compress`, `uncompress`, `hash_to_group` (RFC 9380, caller-supplied DST).
- **Pairing**: `miller_loop : G1 → G2 → MlResult`, `mul_ml_result`, and `final_verify : MlResult → MlResult → Bool`.

### 6.2 The limitation that matters

**Plutus exposes the pairing only as an *equality oracle*.** You can check `e(A,B) == e(C,D)` via `final_verify`, but you **cannot read the GT field element** value of `e(A,B)`. This is sufficient for BLS *signature verification* (which only ever needs an equality check) but insufficient for IBE *decryption*.

`tlock` decryption needs the *value* `e(σ_R, U)` as the input to the KDF `H'` (§3.2). There is no rearrangement that lets `final_verify` rescue this: the KDF consumes the pairing output, it is not one side of a pairing equation. **Therefore a validator cannot recompute a tlock decryption on-chain.**

### 6.3 What this permits and forbids

| Goal | Feasible in Aiken today? |
| --- | --- |
| Voters submit time-locked ballots; tally computed off-chain after round `R` | **Yes**, trivially — validator just stores ciphertexts as datums; no BLS ops on-chain. |
| Hash-commit on-chain with `tlock` as the canonical forced reveal | **Yes** — validator verifies a cheap Blake2b hash on optional reveal; `tlock` is decrypted off-chain for every voter as the source of truth. |
| Validator verifies on-chain that a revealed plaintext is the genuine `tlock` decryption of its datum | **No** — needs the GT element to recompute the KDF, which Plutus does not expose. |
| Use a Drand beacon **not** on BLS12-381 (e.g. the legacy BN254 default beacon) | **No** — wrong curve; Plutus has no BN254 builtins. Must target a BLS12-381 beacon (`quicknet`). |

### 6.4 Why the "No" rows don't block the design

On-chain validation of decryption is **not needed** for an election whose tally is off-chain anyway. The forced-reveal property comes from the cryptography, not the validator: once Drand publishes `σ_R`, every ciphertext targeted at `R` is decryptable by anyone (auditors included), and the voter has no opportunity to back out. The validator's only job is to ensure each eligible voter submitted exactly one well-formed ciphertext during the commit window — all of which is feasible today.

### 6.5 Recommended pattern: dual commitment, tlock-canonical

Store **both** a Blake2b hash commitment and a `tlock` ciphertext for the same `(ballot, salt)`. The cardinal rule: **the tlock decryption is the single source of truth, and it is decrypted for *every* voter.** An on-chain reveal is never authoritative.

- **Canonical tally (always).** After round `R`, the off-chain tallier decrypts the `tlock` ciphertext for *every* commit with `σ_R`, checks `blake2b(decryption) == h`, and counts the decrypted ballot. There is exactly one canonical ballot per voter, fixed at commit time.
- **On-chain reveal (optional convenience).** A cooperative voter may reveal `(ballot, salt)` on-chain after the deadline; Aiken verifies `blake2b(ballot‖salt) == h`. This gives an immediately-available, cheap (no-BLS) record, but it only serves as an integrity cross-check — it must match the tlock decryption, and it cannot override it.
- **Beacon-outage fallback.** If Drand never publishes `σ_R`, the canonical path is unavailable; the election falls back to the voluntary on-chain reveals (a degraded, voluntary-reveal mode accepted only under outage — see §7.3).

**Why decrypt everyone instead of only silent voters.** If the tlock were decrypted *only* for voters who failed to reveal on-chain, a malicious voter could commit ballot `A` under the hash and a different ballot `B` under the tlock, then — after watching how reveals trend — either reveal `A` (and have `A` counted) or stay silent (and have `B` decrypted and counted). That free post-deadline choice is the **equivocation attack** (§8.1); it reintroduces exactly the last-mover advantage the scheme exists to remove. Making the tlock canonical for everyone removes the choice: the voter's ballot is whatever they encrypted at commit time, full stop. The cost — decrypting every ciphertext rather than a subset — is negligible off-chain. Note also that an IBE ciphertext is *itself* a binding commitment to its plaintext, so the tlock alone already binds the vote; the hash exists for outage recovery and early availability, not for binding.

---

## 7. Drand parameters and operational concerns

Even in the off-chain-tally model, several Drand-specific parameters must match exactly or the system silently breaks.

### 7.1 Parameters that must line up

1. **Curve / beacon.** Target a BLS12-381 beacon — Drand's **`quicknet`** is current. The legacy default beacon is BN254 and is unusable on Cardano.
2. **Group placement.** `quicknet` puts signatures on **G1** and the public key on **G2**; `tlock` places the round identity `H(round)` on G1 and `U = g₂^r` on G2. Plutus supports `hash_to_group` on both groups, so this is fine.
3. **Hash-to-curve DST.** `hash_to_group` follows RFC 9380 with a caller-supplied **domain separation tag**. The DST used when reconstructing a round identity (off-chain, and anywhere the validator touches `hash_to_group`) must exactly match Drand's per-network DST — e.g. `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` for `quicknet`. Easy to get wrong, easy to unit-test.
4. **Serialization.** Drand publishes compressed elements (48 B G1, 96 B G2); Plutus has `uncompress`. Within transaction limits.
5. **Round timing.** `quicknet` emits a beacon every 3 s since genesis. Pick `R = (deadline_unix − genesis) / period`. Cardano slots and Drand rounds are independent — the deadline is wall-clock-based, so map carefully between Cardano slot bounds (for the commit-window check) and the Drand round (for decryption timing).

### 7.2 Griefing via malformed ciphertexts

A voter can post bytes that do not decrypt to a valid ballot. Mitigation: the validator cheaply enforces well-formedness by calling `uncompress` on the ciphertext's group-element components (which includes subgroup checks), making on-curve membership a precondition of acceptance. *Semantic* validity of the plaintext (is it a legal ballot for this rule?) is policed off-chain at tally time by a published discard rule.

### 7.3 Beacon availability (liveness)

If the LoE fails to publish `σ_R`, ciphertexts for round `R` cannot be decrypted. Mitigations:

- **Keep the target round close** to the deadline to minimise exposure to outages.
- **Encrypt to a chain of consecutive rounds** so any one of several signatures suffices.
- **Retain the hash-commit path** so honest voters can still reveal manually even if the beacon is down — this is the recoverable fallback that justifies the dual-commitment design.

### 7.4 Costs

Per ciphertext on-chain: **zero pairings**, at most a few `uncompress` calls. Per-voter datum: roughly **150–250 bytes**. Comfortably within Cardano execution budgets. The expensive cryptography (decryption) is entirely off-chain and runs on commodity hardware.

---

## 8. Threat model summary

| Threat | Addressed by | Residual risk |
| --- | --- | --- |
| Bandwagon / cascade during voting | Commitment hides all ballots until window closes | None during window |
| Last-mover advantage at reveal | `tlock` forced reveal (time-based decryption) | None — voter has no reveal-time choice |
| Selective non-reveal | `tlock` decryption applied to *every* voter | None, given beacon liveness |
| **Equivocation (hash ≠ tlock)** | tlock decryption is canonical for all voters; on-chain reveal can't override (§8.1) | None — voter has one canonical ballot fixed at commit |
| Beacon outage | Hash-commit fallback + multi-round encryption + close target round | Degraded to voluntary reveal only if beacon fails |
| Malformed ciphertext griefing | On-chain `uncompress` subgroup check + off-chain discard rule | Discarded ballots (voter self-harms only) |
| Early decryption | Drand LoE threshold (6-of-9) | Requires threshold collusion; disclose to voters |
| Double voting / Sybil | **Out of scope** — identity layer | Per identity-layer guarantees |
| Coercion / vote-buying | **Not solved** — reveals are public/linkable | Accept only in transparency-tolerant contexts |

### 8.1 The equivocation attack and why tlock-canonical defeats it

**Setup.** A voter stores two independent commitments to *different* ballots: `h = blake2b(A‖salt₁)` and `c = tlock_encrypt(B‖salt₂, R)` with `A ≠ B`.

**The attack (only possible under a flawed tally rule).** Suppose the tallier decrypts the tlock *only* for voters who did not reveal on-chain. After the window closes, the voter observes how revealed ballots trend, then:

- reveals `(A, salt₁)` on-chain → the validator checks the hash, `A` counts; or
- stays silent → the tallier decrypts `c`, `B` counts.

The voter has effectively cast two pre-committed ballots and **chosen which one counts after seeing others' votes** — precisely the last-mover advantage commit–reveal exists to eliminate. Detecting the `h`/`c` mismatch "at tally time" is insufficient, because under this rule the mismatched commitment for the path the voter *didn't* take is never even examined.

**The fix (this report's design).** Decrypt the tlock for **every** voter and treat that decryption as the only canonical ballot (§4.3, §6.5). The on-chain reveal becomes a non-authoritative integrity cross-check. Now:

- There is exactly one canonical ballot per voter — `B`, fixed at commit time, before any trend is observable.
- Revealing a different `A` on-chain changes nothing; `B` is counted regardless, and the mismatch is logged (and may trigger a discard rule).
- The voter therefore gains nothing by equivocating, so the only rational commit is `h` and `c` agreeing on a single ballot — which is the honest case.

The cost is decrypting every ciphertext instead of a subset: negligible off-chain work. An IBE ciphertext is itself binding, so the tlock alone already fixes the vote; the hash is retained only for outage recovery and early on-chain availability.

---

## 9. Prototype scope and roadmap

A minimal prototype to validate the design end-to-end:

**Phase 0 — Off-chain tlock harness (no chain).**
- Encrypt/decrypt ballots against `quicknet` using an existing `tlock` library (e.g. `drand/tlock` in Go, or `tlock-js`).
- Confirm round-timing math and DST handling against live Drand. *Deliverable: a script that encrypts a ballot to a near-future round and decrypts it after the round publishes.*

**Phase 1 — Aiken validator (admission + hash reveal).**
- Validator storing `CommitDatum`, enforcing commit-window bounds, single-commit-per-voter, ciphertext `uncompress` well-formedness, and happy-path hash reveal.
- Property tests for the hash-commit/reveal round-trip and rejection of malformed ciphertexts. *Deliverable: validator + Aiken tests.*

**Phase 2 — Off-chain indexer + tallier.**
- Read commit UTxOs (Blockfrost/Kupo), decrypt the tlock ciphertext for *every* commit with `σ_R` (canonical), cross-check each against `h` and against any on-chain reveal, discard malformed/equivocated commits per a published rule, run an aggregation rule (start with Approval or STAR — simplest ballots).
- Output a reproducible result bundle (inputs + decryptions + discards-with-reasons + tally). *Deliverable: a tallier any third party can re-run.*

**Phase 3 — Devnet end-to-end.**
- Wire commit transactions, a real deadline-to-round mapping, and a full election run on a Cardano devnet/preview network with a handful of test voters — including a silent voter (decrypted via tlock) and an **equivocating voter** (hash ≠ tlock) to demonstrate that the tlock value is the one counted and the mismatch is flagged. *Deliverable: a demonstrable election with public verification steps.*

### Open questions for the prototype

- **Identity layer interface.** What exactly does the commit tx carry to prove eligibility and one-vote-per-voter? (Defer to the Sybil report; pick the simplest workable option for the demo — e.g. an allow-list of pre-registered keys.)
- **Discard rule for malformed/late ballots.** Precise, published semantics so the off-chain tally stays deterministic and contestable.
- **Multi-round encryption ergonomics.** Is single-round (`R`) enough for the prototype, with multi-round deferred as a liveness hardening?
- **Result anchoring.** Should the final tally (or its hash) be posted back on-chain for a tamper-evident record, even though the computation is off-chain?
- **Ballot size vs rule.** Confirm the chosen aggregation rule's ballot encoding keeps ciphertexts within comfortable datum limits.

---

## 10. Conclusion

Drand-based timelock commit–reveal is **genuinely feasible on Cardano today for the off-chain-tally model an election needs**. The forced-reveal property is delivered by the cryptography — once `σ_R` publishes, every ciphertext is decryptable by anyone and no voter can selectively withhold — so the on-chain validator needs only to do admission control, which Aiken handles cheaply with no pairing work. The one hard limitation (Plutus cannot extract the GT pairing element, so a validator cannot verify a decryption on-chain) does **not** constrain this design, because decryption and tally are off-chain and independently reproducible by any auditor. The recommended dual-commitment pattern makes the `tlock` decryption the single source of truth — decrypted for every voter so no one can equivocate between a hash ballot and a tlock ballot — while the Blake2b hash serves as a cheap on-chain availability anchor and as the recovery route if the Drand beacon stalls. Treating the on-chain reveal as authoritative (decrypting only silent voters) would reopen the equivocation/last-mover hole, so the tlock-canonical rule is load-bearing, not incidental.

This eliminates bandwagon and last-mover dynamics while preserving full end-state auditability. It does **not** solve coercion or vote-buying (linkable public reveals), nor Sybil resistance — both are explicitly delegated to other layers and other reports.

---

## Sources

- Parent research note: `research-single-winner-voting-methods.md` §6.5–§6.6 (commit–reveal on Cardano; Drand `tlock` on Aiken feasibility).
- Companion: `sybil-resistant-voting-cardano-report.md` (identity / Sybil-resistance layer assumed here).
- [Drand — distributed randomness beacon](https://drand.love)
- [Gailly, Melissaris & Romailler — *tlock: Practical Timelock Encryption from Threshold BLS* (eprint 2023/189)](https://eprint.iacr.org/2023/189)
- [Boneh & Franklin — *Identity-Based Encryption from the Weil Pairing*](https://crypto.stanford.edu/~dabo/papers/bfibe.pdf)
- [CIP-0381 — Plutus BLS12-381 built-in primitives](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0381)
- [Aiken — `aiken/crypto/bls12_381` stdlib](https://aiken-lang.github.io/stdlib/aiken/crypto/bls12_381.html)
- [RFC 9380 — Hashing to Elliptic Curves](https://datatracker.ietf.org/doc/rfc9380/)
- [drand/tlock (Go reference implementation)](https://github.com/drand/tlock)
- [tlock-js (JavaScript/TypeScript implementation)](https://github.com/drand/tlock-js)
